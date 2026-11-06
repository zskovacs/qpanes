//! Small OS boundary: file identity, no-replace rename and native Trash policy.
use super::*;

#[cfg(target_os = "linux")]
pub(in crate::operations) fn mount_id(file: &File) -> Result<Option<u64>, FsError> {
    use rustix::fs::{AtFlags, StatxFlags, statx};
    let metadata = statx(file, "", AtFlags::EMPTY_PATH | AtFlags::SYMLINK_NOFOLLOW, StatxFlags::MNT_ID)
        .map_err(|error| fail(ErrorCode::UnsupportedPlatform, format!("This filesystem cannot provide a mount identity for safe recursive copying: {error}")))?;
    if metadata.stx_mask & StatxFlags::MNT_ID.bits() == 0 {
        return Err(fail(
            ErrorCode::UnsupportedPlatform,
            "Mount identity is unavailable; recursive copying cannot safely exclude bind-mount aliases.",
        ));
    }
    Ok(Some(metadata.stx_mnt_id))
}

#[cfg(not(target_os = "linux"))]
pub(in crate::operations) fn mount_id(_file: &File) -> Result<Option<u64>, FsError> {
    Ok(None)
}

#[cfg(unix)]
pub(in crate::operations) fn identity(file: &File) -> io::Result<Identity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok(Identity {
        device: metadata.dev(),
        file: metadata.ino().into(),
    })
}

#[cfg(unix)]
pub(in crate::operations) fn listing_identity(
    _path: &Path,
    metadata: &Metadata,
) -> Option<Identity> {
    use std::os::unix::fs::MetadataExt;
    Some(Identity {
        device: metadata.dev(),
        file: metadata.ino().into(),
    })
}

#[cfg(unix)]
pub(in crate::operations) fn nonblocking(options: &mut cap_std::fs::OpenOptions) {
    use cap_std::fs::OpenOptionsExt;
    options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
}

#[cfg(unix)]
pub(in crate::operations) fn check_reparse(_file: &File) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
pub(in crate::operations) fn copy_permissions(
    output: &File,
    metadata: &Metadata,
) -> io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    // Never introduce setuid/setgid privilege bits on a newly owned copy.
    output.set_permissions(fs::Permissions::from_mode(metadata.mode() & 0o777))
}

#[cfg(unix)]
pub(in crate::operations) fn same_change_time(before: &Metadata, after: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    (before.ctime(), before.ctime_nsec()) == (after.ctime(), after.ctime_nsec())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(in crate::operations) fn rename_noreplace(
    old: &Dir,
    name: &OsStr,
    new: &Dir,
    target: &OsStr,
    _expected: Option<Identity>,
) -> Result<(), FsError> {
    rustix::fs::renameat_with(old, name, new, target, rustix::fs::RenameFlags::NOREPLACE)
        .map_err(|error| match error {
            rustix::io::Errno::NOSYS | rustix::io::Errno::OPNOTSUPP | rustix::io::Errno::INVAL =>
                fail(ErrorCode::UnsupportedPlatform, "This filesystem does not support a safe no-replace rename. Nothing was replaced."),
            rustix::io::Errno::XDEV => fail(ErrorCode::CrossDeviceNotSupported,
                "Moving between filesystems is not supported. Use Copy, verify the copy, then move the original to Trash explicitly."),
            other => FsError::from_io(other.into()),
        })
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub(in crate::operations) fn rename_noreplace(
    _old: &Dir,
    _name: &OsStr,
    _new: &Dir,
    _target: &OsStr,
    _expected: Option<Identity>,
) -> Result<(), FsError> {
    Err(fail(
        ErrorCode::UnsupportedPlatform,
        "Safe no-replace operations are not supported on this platform.",
    ))
}

#[cfg(unix)]
pub(in crate::operations) fn directory_metadata(
    directory: &Dir,
    metadata: &Metadata,
) -> Result<(), FsError> {
    // cap-std can hold O_PATH directory handles. Reopen through that handle
    // before applying metadata or fsync; fchmod/fsync reject O_PATH with EBADF.
    let file = File::from(
        rustix::fs::openat(
            directory,
            ".",
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::DIRECTORY
                | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        )
        .map_err(|error| FsError::from_io(error.into()))?,
    );
    preserve_metadata(&file, metadata)
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(in crate::operations) fn check_copy_supported(
    _input: &File,
    _metadata: &Metadata,
) -> Result<(), FsError> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub(in crate::operations) fn check_copy_supported(
    input: &File,
    _metadata: &Metadata,
) -> Result<(), FsError> {
    match rustix::fs::fgetxattr_query(input, "com.apple.ResourceFork") {
        Ok(0) | Err(rustix::io::Errno::NOATTR) => Ok(()),
        Ok(_) => Err(fail(
            ErrorCode::UnsupportedEntry,
            "Copying macOS resource forks is not supported. The source was left intact.",
        )),
        Err(error) => Err(FsError::from_io(error.into())),
    }
}

#[cfg(target_os = "linux")]
pub(in crate::operations) fn trash(source: Source) -> Result<OperationResult, FsError> {
    source.revalidate_absolute()?;
    // Cargo deliberately enables only trash-rs's descriptor-based Portal backend.
    // No freedesktop filesystem fallback and no permanent deletion API are used.
    ::trash::delete(&source.path).map_err(|error| fail(ErrorCode::TrashFailed, format!(
        "Could not move the entry to the operating system's Trash: {error}. QPanes does not fall back to permanent deletion. A running desktop Trash portal and a supported, writable location are required. If the service disconnected, inspect the source and Trash before retrying."
    )))?;
    Ok(OperationResult {
        path: None,
        warnings: Vec::new(),
    })
}

#[cfg(target_os = "macos")]
pub(in crate::operations) fn trash(source: Source) -> Result<OperationResult, FsError> {
    use ::trash::macos::{DeleteMethod, TrashContextExtMacos};
    if source.path.to_str().is_none() {
        return Err(fail(
            ErrorCode::UnsupportedEntry,
            "Native Trash does not safely support this non-UTF-8 path. The entry was left intact.",
        ));
    }
    source.revalidate_absolute()?;
    let mut context = ::trash::TrashContext::new();
    context.set_delete_method(DeleteMethod::NsFileManager);
    context.delete(&source.path).map_err(|error| fail(ErrorCode::TrashFailed, format!(
        "Could not move the entry to the operating system's Trash: {error}. No permanent deletion was requested. Inspect the source and Trash before retrying."
    )))?;
    Ok(OperationResult {
        path: None,
        warnings: Vec::new(),
    })
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(in crate::operations) fn trash(_source: Source) -> Result<OperationResult, FsError> {
    Err(fail(
        ErrorCode::UnsupportedPlatform,
        "Moving to Trash is unavailable on this platform: the current native library cannot guarantee recycle-only behavior. The entry was left intact; permanent deletion is never used.",
    ))
}

#[cfg(windows)]
mod windows {
    use super::*;
    use cap_std::fs::OpenOptionsExt;
    use std::{
        mem::{offset_of, size_of},
        os::windows::{ffi::OsStrExt, io::AsRawHandle},
    };
    use windows_sys::Win32::Storage::FileSystem::*;

    pub(in crate::operations) fn identity(file: &File) -> io::Result<Identity> {
        let mut information = FILE_ID_INFO::default();
        // SAFETY: the live handle, correctly aligned output struct and exact
        // buffer length satisfy GetFileInformationByHandleEx's contract.
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileIdInfo,
                (&mut information as *mut FILE_ID_INFO).cast(),
                size_of::<FILE_ID_INFO>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Identity {
            device: information.VolumeSerialNumber,
            file: u128::from_le_bytes(information.FileId.Identifier),
        })
    }

    pub(in crate::operations) fn listing_identity(
        path: &Path,
        _metadata: &Metadata,
    ) -> Option<Identity> {
        use std::os::windows::fs::OpenOptionsExt;
        let file = fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .ok()?;
        identity(&file).ok()
    }

    pub(in crate::operations) fn nonblocking(_options: &mut cap_std::fs::OpenOptions) {}

    pub(in crate::operations) fn check_reparse(file: &File) -> io::Result<()> {
        use std::os::windows::fs::MetadataExt;
        if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Reparse points are not supported for filesystem mutations.",
            ));
        }
        Ok(())
    }

    pub(in crate::operations) fn rename_noreplace(
        old: &Dir,
        name: &OsStr,
        new: &Dir,
        target: &OsStr,
        expected: Option<Identity>,
    ) -> Result<(), FsError> {
        let mut options = cap_std::fs::OpenOptions::new();
        options
            .access_mode(DELETE | FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .follow(FollowSymlinks::No)
            .maybe_dir(true);
        let file = old
            .open_with(name, &options)
            .map_err(FsError::from_io)?
            .into_std();
        check_reparse(&file).map_err(FsError::from_io)?;
        if let Some(expected) = expected
            && identity(&file).map_err(FsError::from_io)? != expected
        {
            return Err(changed());
        }
        let units: Vec<u16> = target.encode_wide().collect();
        let bytes = offset_of!(FILE_RENAME_INFO, FileName) + units.len() * 2;
        let mut storage = vec![0_usize; bytes.div_ceil(size_of::<usize>())];
        // SAFETY: usize storage provides FILE_RENAME_INFO alignment and enough
        // initialized bytes for its variable name. All handles outlive the call;
        // name contains exactly one validated/native component. ReplaceIfExists
        // stays false. RootDirectory anchors the target without a display path.
        let success = unsafe {
            let information = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
            (*information).Anonymous.ReplaceIfExists = false;
            (*information).RootDirectory = new.as_raw_handle();
            (*information).FileNameLength = (units.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(
                units.as_ptr(),
                (*information).FileName.as_mut_ptr(),
                units.len(),
            );
            SetFileInformationByHandle(
                file.as_raw_handle(),
                FileRenameInfo,
                information.cast(),
                bytes as u32,
            )
        };
        if success == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(17) {
                return Err(fail(
                    ErrorCode::CrossDeviceNotSupported,
                    "Moving between filesystems is not supported. The source was left intact.",
                ));
            }
            return Err(FsError::from_io(error));
        }
        Ok(())
    }

    pub(in crate::operations) fn copy_permissions(
        output: &File,
        metadata: &Metadata,
    ) -> io::Result<()> {
        output.set_permissions(metadata.permissions())
    }

    pub(in crate::operations) fn same_change_time(_before: &Metadata, _after: &Metadata) -> bool {
        true
    }

    pub(in crate::operations) fn directory_metadata(
        directory: &Dir,
        metadata: &Metadata,
    ) -> Result<(), FsError> {
        let mut options = cap_std::fs::OpenOptions::new();
        options
            .access_mode(FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES)
            .follow(FollowSymlinks::No)
            .maybe_dir(true);
        let file = directory
            .open_with(".", &options)
            .map_err(FsError::from_io)?
            .into_std();
        copy_permissions(&file, metadata).map_err(FsError::from_io)?;
        file.set_times(
            FileTimes::new()
                .set_accessed(metadata.accessed().map_err(FsError::from_io)?)
                .set_modified(metadata.modified().map_err(FsError::from_io)?),
        )
        .map_err(FsError::from_io)
    }

    pub(in crate::operations) fn check_copy_supported(
        file: &File,
        metadata: &Metadata,
    ) -> Result<(), FsError> {
        check_reparse(file).map_err(FsError::from_io)?;
        // A fixed bound; refuse rich-stream files rather than silently dropping
        // contents outside the default data stream. No whole-file allocation.
        let mut storage = vec![0_u64; 8192];
        // SAFETY: live handle, aligned initialized output buffer and exact size.
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileStreamInfo,
                storage.as_mut_ptr().cast(),
                (storage.len() * 8) as u32,
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(38) && metadata.is_dir() {
                return Ok(());
            }
            return Err(fail(
                ErrorCode::UnsupportedEntry,
                format!(
                    "Could not verify that this entry has only its default data stream: {error}"
                ),
            ));
        }
        // SAFETY: FILE_STREAM_INFO alignment is at most u64; the buffer is far
        // larger than the struct and initialized by the successful call.
        let information = unsafe { &*storage.as_ptr().cast::<FILE_STREAM_INFO>() };
        if information.NextEntryOffset != 0 || information.StreamNameLength != 14 {
            return Err(fail(
                ErrorCode::UnsupportedEntry,
                "Copying alternate data streams is not supported. The source was left intact.",
            ));
        }
        // The sole stream must be exactly ::$DATA, rather than a named stream.
        let expected: Vec<u16> = "::$DATA".encode_utf16().collect();
        // SAFETY: 14 bytes are within the returned fixed buffer after the header.
        let name = unsafe { std::slice::from_raw_parts(information.StreamName.as_ptr(), 7) };
        if name != expected {
            return Err(fail(
                ErrorCode::UnsupportedEntry,
                "The entry has an unsupported data stream.",
            ));
        }
        Ok(())
    }
}

#[cfg(windows)]
pub(super) use windows::{
    check_copy_supported, check_reparse, copy_permissions, directory_metadata, identity,
    listing_identity, nonblocking, rename_noreplace, same_change_time,
};
