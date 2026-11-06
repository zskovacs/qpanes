//! Local filesystem semantics, independent of desktop IPC and presentation.

use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    fs, io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

mod operations;
pub use operations::{
    CreateDirectoryRequest, OperationResult, RenameRequest, TransferRequest, TrashRequest,
    copy_entry, create_directory, move_entry, rename_entry, trash_entry,
};

/// Lossless native path. Display labels must never be used as path identifiers.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NativePath(String);

impl NativePath {
    pub fn from_path(path: &Path) -> Self {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            Self(format!("u:{}", encode(path.as_os_str().as_bytes())))
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            let bytes: Vec<_> = path
                .as_os_str()
                .encode_wide()
                .flat_map(u16::to_le_bytes)
                .collect();
            Self(format!("w:{}", encode(&bytes)))
        }
    }

    pub fn to_path(&self) -> Result<PathBuf, FsError> {
        #[cfg(unix)]
        {
            use std::{ffi::OsString, os::unix::ffi::OsStringExt};
            let bytes = decode(
                self.0
                    .strip_prefix("u:")
                    .ok_or_else(FsError::invalid_path)?,
            )?;
            if bytes.contains(&0) {
                return Err(FsError::invalid_path());
            }
            Ok(PathBuf::from(OsString::from_vec(bytes)))
        }
        #[cfg(windows)]
        {
            use std::{ffi::OsString, os::windows::ffi::OsStringExt};
            let bytes = decode(
                self.0
                    .strip_prefix("w:")
                    .ok_or_else(FsError::invalid_path)?,
            )?;
            if !bytes.len().is_multiple_of(2) {
                return Err(FsError::invalid_path());
            }
            let units: Vec<_> = bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect();
            if units.contains(&0) {
                return Err(FsError::invalid_path());
            }
            Ok(PathBuf::from(OsString::from_wide(&units)))
        }
    }
}

fn encode(bytes: &[u8]) -> String {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 15) as usize] as char);
    }
    result
}

fn decode(hex: &str) -> Result<Vec<u8>, FsError> {
    if !hex.len().is_multiple_of(2) {
        return Err(FsError::invalid_path());
    }
    hex.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let high = (pair[0] as char)
                .to_digit(16)
                .ok_or_else(FsError::invalid_path)?;
            let low = (pair[1] as char)
                .to_digit(16)
                .ok_or_else(FsError::invalid_path)?;
            Ok(((high << 4) | low) as u8)
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum DirectoryTarget {
    Home,
    Path(NativePath),
    Typed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortKey {
    Name,
    Size,
    Modified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    Ascending,
    Descending,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRequest {
    pub target: DirectoryTarget,
    pub sort: SortKey,
    pub direction: SortDirection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    Directory,
    File,
    Symlink,
    Other,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: NativePath,
    pub name: String,
    pub kind: EntryKind,
    pub size: Option<u64>,
    pub modified_ms: Option<i64>,
    pub metadata_error: Option<String>,
    /// Native file identity captured at listing time, never a display label.
    #[serde(default)]
    pub identity: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: NativePath,
    pub label: String,
    pub parent: Option<NativePath>,
    pub entries: Vec<Entry>,
    pub warnings: Vec<String>,
    pub sort: SortKey,
    pub direction: SortDirection,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    NotFound,
    PermissionDenied,
    NotDirectory,
    InvalidPath,
    Io,
    Unavailable,
    Conflict,
    InvalidName,
    SameEntry,
    Descendant,
    UnsupportedEntry,
    #[serde(rename = "cross_device_not_supported")]
    CrossDeviceNotSupported,
    UnsupportedPlatform,
    SourceChanged,
    TrashFailed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsError {
    pub code: ErrorCode,
    pub message: String,
}

impl FsError {
    fn invalid_path() -> Self {
        Self {
            code: ErrorCode::InvalidPath,
            message: "Enter a valid absolute directory path.".into(),
        }
    }

    pub fn unavailable() -> Self {
        Self {
            code: ErrorCode::Unavailable,
            message: "The filesystem worker could not finish. Try again.".into(),
        }
    }

    pub fn operation_unavailable() -> Self {
        Self {
            code: ErrorCode::Unavailable,
            message: "The filesystem worker stopped before reporting the result. Inspect the source, destination and Trash before attempting another operation.".into(),
        }
    }

    fn from_io(error: io::Error) -> Self {
        let code = match error.kind() {
            io::ErrorKind::NotFound => ErrorCode::NotFound,
            io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
            io::ErrorKind::NotADirectory => ErrorCode::NotDirectory,
            io::ErrorKind::InvalidInput => ErrorCode::InvalidPath,
            io::ErrorKind::AlreadyExists => ErrorCode::Conflict,
            io::ErrorKind::InvalidFilename => ErrorCode::InvalidName,
            io::ErrorKind::CrossesDevices => ErrorCode::CrossDeviceNotSupported,
            _ => ErrorCode::Io,
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

fn initial_directory() -> Result<PathBuf, FsError> {
    // home_dir uses native OS discovery (including the Windows user profile).
    // A stale/unreadable home falls back to the process working directory.
    std::env::home_dir()
        .filter(|p| fs::read_dir(p).is_ok())
        .map(Ok)
        .unwrap_or_else(std::env::current_dir)
        .map_err(FsError::from_io)
}

/// Call from a blocking worker: directory enumeration and metadata perform I/O.
pub fn list_directory(request: ListRequest) -> Result<DirectoryListing, FsError> {
    let requested = match request.target {
        DirectoryTarget::Home => initial_directory()?,
        DirectoryTarget::Path(path) => path.to_path()?,
        DirectoryTarget::Typed(path) => PathBuf::from(path),
    };
    if !requested.is_absolute() {
        return Err(FsError::invalid_path());
    }
    let directory = fs::canonicalize(requested).map_err(FsError::from_io)?;
    let iterator = fs::read_dir(&directory).map_err(FsError::from_io)?;
    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    for item in iterator {
        match item {
            Ok(item) => entries.push(read_entry(
                item.path(),
                item.file_name().to_string_lossy().into_owned(),
            )),
            Err(error) => {
                // Bound warning memory even if the filesystem repeatedly fails.
                if warnings.len() < 8 {
                    warnings.push(format!("Some entries could not be read: {error}"));
                }
            }
        }
    }
    sort_entries(&mut entries, request.sort, request.direction);
    Ok(DirectoryListing {
        path: NativePath::from_path(&directory),
        label: directory.to_string_lossy().into_owned(),
        parent: directory.parent().map(NativePath::from_path),
        entries,
        warnings,
        sort: request.sort,
        direction: request.direction,
    })
}

fn read_entry(path: PathBuf, name: String) -> Entry {
    let mut entry = Entry {
        path: NativePath::from_path(&path),
        name,
        kind: EntryKind::Unknown,
        size: None,
        modified_ms: None,
        metadata_error: None,
        identity: None,
    };
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            entry.identity = operations::listing_identity(&path, &metadata);
            let kind = metadata.file_type();
            entry.kind = if kind.is_symlink() {
                EntryKind::Symlink
            } else if kind.is_dir() {
                EntryKind::Directory
            } else if kind.is_file() {
                EntryKind::File
            } else {
                EntryKind::Other
            };
            entry.size = (entry.kind == EntryKind::File).then_some(metadata.len());
            match metadata.modified() {
                Ok(time) => entry.modified_ms = timestamp_ms(time),
                Err(error) => {
                    entry.metadata_error = Some(format!("Modification time unavailable: {error}"))
                }
            }
        }
        Err(error) => entry.metadata_error = Some(format!("Metadata unavailable: {error}")),
    }
    entry
}

fn timestamp_ms(time: SystemTime) -> Option<i64> {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).ok(),
        Err(error) => i64::try_from(error.duration().as_millis())
            .ok()
            .map(|ms| -ms),
    }
}

pub fn sort_entries(entries: &mut [Entry], key: SortKey, direction: SortDirection) {
    // Cache the lowercase key once per entry rather than allocate in comparisons.
    if key == SortKey::Name && direction == SortDirection::Descending {
        entries.sort_by_cached_key(|entry| {
            (
                entry.kind != EntryKind::Directory,
                std::cmp::Reverse((
                    entry.name.to_lowercase(),
                    entry.name.clone(),
                    entry.path.clone(),
                )),
            )
        });
        return;
    }
    entries.sort_by_cached_key(|entry| {
        (
            entry.kind != EntryKind::Directory,
            entry.name.to_lowercase(),
            entry.name.clone(),
            entry.path.clone(),
        )
    });
    if key == SortKey::Name {
        return;
    }
    // Stable sort preserves deterministic name ties for size/date.
    entries.sort_by(|a, b| {
        (a.kind != EntryKind::Directory)
            .cmp(&(b.kind != EntryKind::Directory))
            .then_with(|| match key {
                SortKey::Name => Ordering::Equal,
                SortKey::Size => compare_optional(a.size, b.size, direction),
                SortKey::Modified => compare_optional(a.modified_ms, b.modified_ms, direction),
            })
    });
}

fn directed(order: Ordering, direction: SortDirection) -> Ordering {
    if direction == SortDirection::Descending {
        order.reverse()
    } else {
        order
    }
}

fn compare_optional<T: Ord>(a: Option<T>, b: Option<T>, direction: SortDirection) -> Ordering {
    match (a, b) {
        (Some(a), Some(b)) => directed(a.cmp(&b), direction),
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (None, None) => Ordering::Equal,
    }
}

#[cfg(test)]
mod tests;
