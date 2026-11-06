//! Single-entry local mutations. No UI, Tauri, shell, retries or operation queue.
use crate::{Entry, EntryKind, ErrorCode, FsError, NativePath};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt};
use cap_std::{ambient_authority, fs::Dir};
use serde::{Deserialize, Serialize};
use std::{
    ffi::{OsStr, OsString},
    fs::{self, File, FileTimes, Metadata},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

mod native;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateDirectoryRequest {
    pub parent: NativePath,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameRequest {
    pub source: Entry,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferRequest {
    pub source: Entry,
    pub destination: NativePath,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrashRequest {
    pub source: Entry,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub path: Option<NativePath>,
    pub warnings: Vec<String>,
}

fn fail(code: ErrorCode, message: impl Into<String>) -> FsError {
    FsError {
        code,
        message: message.into(),
    }
}

fn changed() -> FsError {
    fail(
        ErrorCode::SourceChanged,
        "The selected entry changed. Refresh the panel and review it before trying again.",
    )
}

/// A single native component, never a path. The OS enforces filesystem length limits.
fn validate_name_for(name: &str, windows: bool) -> Result<(), FsError> {
    let invalid = name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['\0', '/'])
        || (windows
            && (name.ends_with(['.', ' '])
                || name.chars().any(|c| c < ' ' || "<>:\"\\|?*".contains(c))));
    let base = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_uppercase();
    let reserved = windows
        && (matches!(
            base.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || ["COM", "LPT"].iter().any(|prefix| {
            base.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        }));
    if invalid || reserved {
        return Err(fail(
            ErrorCode::InvalidName,
            "Enter one valid file or directory name, without a path or reserved native name.",
        ));
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<(), FsError> {
    validate_name_for(name, cfg!(windows))
}

/// Refuse dot components, relative identifiers and symlink ancestors. Open handles
/// anchor subsequent work even if a parent is renamed while an operation runs.
fn open_directory(path: &Path) -> Result<Dir, FsError> {
    if !path.is_absolute() {
        return Err(FsError::invalid_path());
    }
    let mut root = PathBuf::new();
    let mut names = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir if names.is_empty() => root.push(component),
            Component::Normal(name) => names.push(name),
            _ => return Err(FsError::invalid_path()),
        }
    }
    let mut directory =
        Dir::open_ambient_dir(root, ambient_authority()).map_err(FsError::from_io)?;
    #[cfg(windows)]
    native::check_reparse(&dir_file(&directory)?).map_err(FsError::from_io)?;
    for name in names {
        directory = directory
            .open_dir_nofollow(name)
            .map_err(FsError::from_io)?;
        #[cfg(windows)]
        native::check_reparse(&dir_file(&directory)?).map_err(FsError::from_io)?;
    }
    Ok(directory)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Identity {
    device: u64,
    file: u128,
}

impl Identity {
    fn token(self) -> String {
        format!("{:x}:{:x}", self.device, self.file)
    }
}

pub(super) fn listing_identity(path: &Path, metadata: &Metadata) -> Option<String> {
    native::listing_identity(path, metadata).map(Identity::token)
}

fn dir_file(directory: &Dir) -> Result<File, FsError> {
    directory
        .try_clone()
        .map(Dir::into_std_file)
        .map_err(FsError::from_io)
}

fn dir_identity(directory: &Dir) -> Result<Identity, FsError> {
    native::identity(&dir_file(directory)?).map_err(FsError::from_io)
}

fn open_entry(parent: &Dir, name: &OsStr) -> Result<File, FsError> {
    let kind = parent
        .symlink_metadata(name)
        .map_err(FsError::from_io)?
        .file_type();
    if kind.is_symlink() || (!kind.is_file() && !kind.is_dir()) {
        return Err(fail(
            ErrorCode::UnsupportedEntry,
            "Symbolic links and special entries are not supported and are never followed.",
        ));
    }
    let mut options = cap_std::fs::OpenOptions::new();
    options
        .read(true)
        .follow(FollowSymlinks::No)
        .maybe_dir(true);
    native::nonblocking(&mut options);
    let file = parent
        .open_with(name, &options)
        .map_err(FsError::from_io)?
        .into_std();
    let meta = file.metadata().map_err(FsError::from_io)?;
    if !meta.is_file() && !meta.is_dir() {
        return Err(fail(
            ErrorCode::UnsupportedEntry,
            "Only regular files and directories are supported. Links and special entries are not followed.",
        ));
    }
    native::check_reparse(&file).map_err(FsError::from_io)?;
    Ok(file)
}

struct Source {
    path: PathBuf,
    parent: Dir,
    name: OsString,
    file: File,
    identity: Identity,
    metadata: Metadata,
}

impl Source {
    fn open(entry: Entry) -> Result<Self, FsError> {
        if !matches!(entry.kind, EntryKind::File | EntryKind::Directory) {
            return Err(fail(
                ErrorCode::UnsupportedEntry,
                "Select a regular file or directory. Symbolic links and special entries are not supported.",
            ));
        }
        let path = entry.path.to_path()?;
        // Reject non-normal final components before normalizing anything.
        if !path.is_absolute()
            || !matches!(path.components().next_back(), Some(Component::Normal(_)))
        {
            return Err(FsError::invalid_path());
        }
        let name = path
            .file_name()
            .ok_or_else(FsError::invalid_path)?
            .to_owned();
        let parent = open_directory(path.parent().ok_or_else(FsError::invalid_path)?)?;
        let file = open_entry(&parent, &name)?;
        let metadata = file.metadata().map_err(FsError::from_io)?;
        if metadata.is_dir() != (entry.kind == EntryKind::Directory) {
            return Err(changed());
        }
        let identity = native::identity(&file).map_err(FsError::from_io)?;
        if entry.identity.as_deref() != Some(identity.token().as_str()) {
            return Err(changed());
        }
        Ok(Self {
            path,
            parent,
            name,
            file,
            identity,
            metadata,
        })
    }

    fn revalidate(&self) -> Result<(), FsError> {
        if native::identity(&open_entry(&self.parent, &self.name)?).map_err(FsError::from_io)?
            != self.identity
        {
            return Err(changed());
        }
        Ok(())
    }

    /// Native Trash APIs accept a pathname. Check that it still names the same
    /// anchored parent and entry before handing it off to the OS integration.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn revalidate_absolute(&self) -> Result<(), FsError> {
        self.revalidate()?;
        let current = open_directory(self.path.parent().ok_or_else(FsError::invalid_path)?)?;
        if dir_identity(&current)? != dir_identity(&self.parent)?
            || native::identity(&open_entry(&current, &self.name)?).map_err(FsError::from_io)?
                != self.identity
        {
            return Err(changed());
        }
        Ok(())
    }
}

fn result(path: &Path) -> OperationResult {
    OperationResult {
        path: Some(NativePath::from_path(path)),
        warnings: Vec::new(),
    }
}

pub fn create_directory(request: CreateDirectoryRequest) -> Result<OperationResult, FsError> {
    validate_name(&request.name)?;
    let path = request.parent.to_path()?;
    let directory = open_directory(&path)?;
    directory
        .create_dir(&request.name)
        .map_err(FsError::from_io)?;
    Ok(result(&path.join(request.name)))
}

pub fn rename_entry(request: RenameRequest) -> Result<OperationResult, FsError> {
    validate_name(&request.name)?;
    let source = Source::open(request.source)?;
    if source.name == OsStr::new(&request.name) {
        return Err(fail(
            ErrorCode::SameEntry,
            "The new name is the current name.",
        ));
    }
    source.revalidate()?;
    drop(source.file);
    native::rename_noreplace(
        &source.parent,
        &source.name,
        &source.parent,
        OsStr::new(&request.name),
        Some(source.identity),
    )?;
    Ok(result(&source.path.with_file_name(request.name)))
}

fn check_destination(source: &Source, destination: &Dir) -> Result<(), FsError> {
    let destination_id = dir_identity(destination)?;
    if dir_identity(&source.parent)? == destination_id {
        return Err(fail(
            ErrorCode::SameEntry,
            "Source and destination refer to the same entry.",
        ));
    }
    if !source.metadata.is_dir() {
        return Ok(());
    }
    // Bind mounts may alias a descendant without exposing its original parent
    // through '..'. Refuse same-device cross-mount directory transfers rather
    // than assuming canonical path prefixes prove safety.
    if source.identity.device == destination_id.device
        && native::mount_id(&source.file)? != native::mount_id(&dir_file(destination)?)?
    {
        return Err(fail(
            ErrorCode::UnsupportedEntry,
            "Directory transfers through different mounts of the same filesystem are not supported safely.",
        ));
    }
    let mut ancestor = destination.try_clone().map_err(FsError::from_io)?;
    for _ in 0..1024 {
        let current_id = dir_identity(&ancestor)?;
        if current_id == source.identity {
            return Err(fail(
                ErrorCode::Descendant,
                "A directory cannot be copied or moved into itself or a descendant.",
            ));
        }
        let parent = ancestor
            .open_parent_dir(ambient_authority())
            .map_err(FsError::from_io)?;
        if dir_identity(&parent)? == current_id {
            return Ok(());
        }
        ancestor = parent;
    }
    Err(fail(
        ErrorCode::UnsupportedEntry,
        "The directory ancestry is too deep or cyclic to verify safely.",
    ))
}

pub fn move_entry(request: TransferRequest) -> Result<OperationResult, FsError> {
    let source = Source::open(request.source)?;
    let path = request.destination.to_path()?;
    let destination = open_directory(&path)?;
    check_destination(&source, &destination)?;
    source.revalidate()?;
    drop(source.file);
    native::rename_noreplace(
        &source.parent,
        &source.name,
        &destination,
        &source.name,
        Some(source.identity),
    )?;
    Ok(result(&path.join(&source.name)))
}

/// Marked staging lives on the destination filesystem. Creating a directory and
/// opening it are separate syscalls: neither its name nor mode proves ownership
/// of the opened directory or its contents. Never recursively delete staging.
struct Staging {
    directory: Dir,
    path: PathBuf,
}

impl Staging {
    fn create(parent: &Dir, path: &Path, prefix: &str) -> Result<Self, FsError> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        for _ in 0..64 {
            let time = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let name = format!(
                ".qpanes-{prefix}-{}-{time:x}-{:x}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            );
            let builder = cap_std::fs::DirBuilder::new();
            #[cfg(unix)]
            let mut builder = builder;
            #[cfg(unix)]
            {
                use cap_std::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match parent.create_dir_with(&name, &builder) {
                Ok(()) => {
                    return Self::open_created(parent, path.join(name));
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(FsError::from_io(error)),
            }
        }
        Err(fail(
            ErrorCode::Conflict,
            "Could not reserve a private staging directory.",
        ))
    }

    fn open_created(parent: &Dir, path: PathBuf) -> Result<Self, FsError> {
        let acquire = || -> Result<Dir, FsError> {
            let directory = parent
                .open_dir_nofollow(path.file_name().ok_or_else(FsError::invalid_path)?)
                .map_err(FsError::from_io)?;
            // Reject an already populated replacement, without removing it.
            // Emptiness is only an early check, never authorization to delete:
            // another writer can add entries after this check as well.
            if let Some(entry) = directory.entries().map_err(FsError::from_io)?.next() {
                entry.map_err(FsError::from_io)?;
                return Err(fail(
                    ErrorCode::SourceChanged,
                    "Staging is no longer empty.",
                ));
            }
            Ok(directory)
        };
        let directory = acquire().map_err(|mut error| {
            error.message = format!(
                "Could not safely acquire copy staging at {}: {}. It was left untouched; inspect this location and any renamed staging before removal.",
                path.display(), error.message
            );
            error
        })?;
        Ok(Self { directory, path })
    }

    fn cleanup(self) -> io::Result<()> {
        // The OS enforces emptiness at removal, including concurrent inserts.
        // Retain ALL nonempty stages, even on copy failure: they may contain
        // unrelated entries substituted before open or inserted during copying.
        self.directory.remove_open_dir()
    }
}

const COPY_BUFFER: usize = 64 * 1024;
const MAX_COPY_DEPTH: usize = 128;

fn stream_copy(reader: &mut impl Read, writer: &mut impl Write) -> io::Result<u64> {
    // Keep the bounded buffer off recursive traversal's stack, including when
    // release optimization inlines this helper into copy_node.
    let mut buffer = vec![0_u8; COPY_BUFFER];
    let mut total = 0;
    loop {
        let read = match reader.read(&mut buffer) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if read == 0 {
            return Ok(total);
        }
        writer.write_all(&buffer[..read])?;
        total += read as u64;
    }
}

fn preserve_metadata(output: &File, metadata: &Metadata) -> Result<(), FsError> {
    native::copy_permissions(output, metadata).map_err(FsError::from_io)?;
    output
        .set_times(
            FileTimes::new()
                .set_accessed(metadata.accessed().map_err(FsError::from_io)?)
                .set_modified(metadata.modified().map_err(FsError::from_io)?),
        )
        .map_err(FsError::from_io)?;
    output.sync_all().map_err(FsError::from_io)
}

fn verify_unchanged(before: &Metadata, after: &Metadata) -> Result<(), FsError> {
    if before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || !native::same_change_time(before, after)
    {
        return Err(changed());
    }
    Ok(())
}

fn copy_node(
    input: &mut File,
    output_dir: &Dir,
    name: &OsStr,
    device: u64,
    mount: Option<u64>,
    staging: Identity,
    ancestors: &mut Vec<Identity>,
) -> Result<(), FsError> {
    let metadata = input.metadata().map_err(FsError::from_io)?;
    let identity = native::identity(input).map_err(FsError::from_io)?;
    if identity.device != device
        || identity == staging
        || (mount.is_some() && native::mount_id(input)? != mount)
        || ancestors.contains(&identity)
        || ancestors.len() >= MAX_COPY_DEPTH
    {
        return Err(fail(
            ErrorCode::UnsupportedEntry,
            "Copying mount crossings, directory loops or trees deeper than 128 levels is not supported.",
        ));
    }
    native::check_copy_supported(input, &metadata)?;
    if metadata.is_file() {
        let mut options = cap_std::fs::OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        let mut output = output_dir
            .open_with(name, &options)
            .map_err(FsError::from_io)?
            .into_std();
        // Bound reads to the initial length, then detect growth/short reads.
        let copied = stream_copy(&mut (&mut *input).take(metadata.len()), &mut output)
            .map_err(FsError::from_io)?;
        let mut extra = [0];
        if copied != metadata.len() || input.read(&mut extra).map_err(FsError::from_io)? != 0 {
            return Err(changed());
        }
        verify_unchanged(&metadata, &input.metadata().map_err(FsError::from_io)?)?;
        preserve_metadata(&output, &metadata)?;
    } else if metadata.is_dir() {
        output_dir.create_dir(name).map_err(FsError::from_io)?;
        let output = output_dir
            .open_dir_nofollow(name)
            .map_err(FsError::from_io)?;
        let source = Dir::from_std_file(input.try_clone().map_err(FsError::from_io)?);
        ancestors.push(identity);
        for entry in source.entries().map_err(FsError::from_io)? {
            let entry = entry.map_err(FsError::from_io)?;
            let name = entry.file_name();
            let mut child = open_entry(&source, &name)?;
            copy_node(
                &mut child, &output, &name, device, mount, staging, ancestors,
            )?;
        }
        ancestors.pop();
        verify_unchanged(&metadata, &input.metadata().map_err(FsError::from_io)?)?;
        native::directory_metadata(&output, &metadata)?;
    } else {
        return Err(fail(
            ErrorCode::UnsupportedEntry,
            "Only regular files and directories can be copied.",
        ));
    }
    Ok(())
}

pub fn copy_entry(request: TransferRequest) -> Result<OperationResult, FsError> {
    let mut source = Source::open(request.source)?;
    let path = request.destination.to_path()?;
    let destination = open_directory(&path)?;
    check_destination(&source, &destination)?;
    // Catch existing entries (including broken symlinks) early. Publication still
    // uses the kernel's atomic no-replace operation to close the collision race.
    match destination.symlink_metadata(&source.name) {
        Ok(_) => {
            return Err(fail(
                ErrorCode::Conflict,
                "The destination already contains an entry with this name.",
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(FsError::from_io(error)),
    }
    let staging = Staging::create(&destination, &path, "copy")?;
    copy_to_staging(&mut source, &destination, &path, staging)
}

fn copy_to_staging(
    source: &mut Source,
    destination: &Dir,
    path: &Path,
    staging: Staging,
) -> Result<OperationResult, FsError> {
    let attempt: Result<OperationResult, FsError> = (|| {
        let mount = if source.metadata.is_dir() {
            native::mount_id(&source.file)?
        } else {
            None
        };
        copy_node(
            &mut source.file,
            &staging.directory,
            OsStr::new("payload"),
            source.identity.device,
            mount,
            dir_identity(&staging.directory)?,
            &mut Vec::new(),
        )?;
        source.revalidate()?;
        check_destination(source, destination)?;
        native::rename_noreplace(
            &staging.directory,
            OsStr::new("payload"),
            destination,
            &source.name,
            None,
        )?;
        Ok(result(&path.join(&source.name)))
    })();
    let recovery = staging.path.clone();
    let cleanup = staging.cleanup();
    match (attempt, cleanup) {
        (Ok(mut result), Err(error)) => {
            result.warnings.push(format!(
                "Copy completed, but staging could not be removed: {error}. Reserved location: {} (it may have been renamed). Review it before removal; nonempty staging is never deleted automatically.",
                recovery.display()
            ));
            Ok(result)
        }
        (Err(mut error), Err(cleanup)) => {
            error.message.push_str(&format!(
                " Copy staging could not be removed: {cleanup}. Reserved location: {} (it may have been renamed). Review it before removal; nonempty staging is never deleted automatically.",
                recovery.display()
            ));
            Err(error)
        }
        (result, Ok(())) => result,
    }
}

pub fn trash_entry(request: TrashRequest) -> Result<OperationResult, FsError> {
    native::trash(Source::open(request.source)?)
}

#[cfg(test)]
mod tests;
