use super::*;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "qpanes-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, AtomicOrdering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn list(&self, key: SortKey, direction: SortDirection) -> DirectoryListing {
        list_directory(request(&self.0, key, direction)).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn request(path: &Path, sort: SortKey, direction: SortDirection) -> ListRequest {
    ListRequest {
        target: DirectoryTarget::Path(NativePath::from_path(path)),
        sort,
        direction,
    }
}
fn names(listing: &DirectoryListing) -> Vec<&str> {
    listing.entries.iter().map(|e| e.name.as_str()).collect()
}

#[test]
fn real_listing_metadata_hidden_unicode_and_directory_navigation() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("folder")).unwrap();
    fs::write(fixture.0.join(".hidden"), b"123").unwrap();
    fs::write(fixture.0.join("árvíz 🦀.txt"), b"hello").unwrap();
    let listing = fixture.list(SortKey::Name, SortDirection::Ascending);
    assert_eq!(names(&listing), ["folder", ".hidden", "árvíz 🦀.txt"]);
    assert_eq!(listing.entries[0].kind, EntryKind::Directory);
    assert_eq!(listing.entries[0].size, None);
    assert_eq!(listing.entries[2].size, Some(5));
    assert!(listing.entries[2].modified_ms.is_some());
    let nested = list_directory(request(
        &listing.entries[0].path.to_path().unwrap(),
        SortKey::Name,
        SortDirection::Ascending,
    ))
    .unwrap();
    assert!(nested.entries.is_empty());
    assert_eq!(nested.parent, Some(listing.path));
}

#[test]
fn ordering_keeps_directories_first_in_both_directions_and_stable_size_ties() {
    let fixture = Fixture::new();
    for dir in ["z-dir", "a-dir"] {
        fs::create_dir(fixture.0.join(dir)).unwrap();
    }
    for (name, data) in [("b.txt", "12"), ("A.txt", "12"), ("c.txt", "1")] {
        fs::write(fixture.0.join(name), data).unwrap();
    }
    assert_eq!(
        names(&fixture.list(SortKey::Name, SortDirection::Ascending)),
        ["a-dir", "z-dir", "A.txt", "b.txt", "c.txt"]
    );
    assert_eq!(
        names(&fixture.list(SortKey::Name, SortDirection::Descending)),
        ["z-dir", "a-dir", "c.txt", "b.txt", "A.txt"]
    );
    assert_eq!(
        names(&fixture.list(SortKey::Size, SortDirection::Ascending)),
        ["a-dir", "z-dir", "c.txt", "A.txt", "b.txt"]
    );
    assert_eq!(
        names(&fixture.list(SortKey::Size, SortDirection::Descending)),
        ["a-dir", "z-dir", "A.txt", "b.txt", "c.txt"]
    );
}

#[test]
fn modification_sort_and_pre_epoch_timestamps() {
    let fixture = Fixture::new();
    for (name, seconds) in [("old", 1_000_000), ("new", 2_000_000)] {
        fs::File::create(fixture.0.join(name))
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_modified(UNIX_EPOCH + std::time::Duration::from_secs(seconds)),
            )
            .unwrap();
    }
    assert_eq!(
        names(&fixture.list(SortKey::Modified, SortDirection::Ascending)),
        ["old", "new"]
    );
    assert_eq!(
        names(&fixture.list(SortKey::Modified, SortDirection::Descending)),
        ["new", "old"]
    );
    assert_eq!(
        timestamp_ms(UNIX_EPOCH - std::time::Duration::from_secs(1)),
        Some(-1000)
    );
}

#[test]
fn unknown_metadata_sorts_last_and_disappearing_entry_does_not_panic() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("known"), b"x").unwrap();
    let mut entries = fixture
        .list(SortKey::Name, SortDirection::Ascending)
        .entries;
    entries.push(read_entry(fixture.0.join("gone"), "gone".into()));
    for key in [SortKey::Size, SortKey::Modified] {
        for direction in [SortDirection::Ascending, SortDirection::Descending] {
            sort_entries(&mut entries, key, direction);
            assert_eq!(entries[1].name, "gone");
            assert_eq!(entries[1].kind, EntryKind::Unknown);
            assert!(entries[1].metadata_error.is_some());
        }
    }
}

#[test]
fn missing_disappeared_and_file_targets_return_typed_errors() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("gone")).unwrap();
    fs::remove_dir(fixture.0.join("gone")).unwrap();
    assert_eq!(
        list_directory(request(
            &fixture.0.join("gone"),
            SortKey::Name,
            SortDirection::Ascending
        ))
        .unwrap_err()
        .code,
        ErrorCode::NotFound
    );
    fs::write(fixture.0.join("file"), b"data").unwrap();
    assert_eq!(
        list_directory(request(
            &fixture.0.join("file"),
            SortKey::Name,
            SortDirection::Ascending
        ))
        .unwrap_err()
        .code,
        ErrorCode::NotDirectory
    );
}

#[test]
fn reject_relative_and_malformed_paths() {
    assert_eq!(
        list_directory(ListRequest {
            target: DirectoryTarget::Typed("relative".into()),
            sort: SortKey::Name,
            direction: SortDirection::Ascending
        })
        .unwrap_err()
        .code,
        ErrorCode::InvalidPath
    );
    for value in ["", "u:0", "u:gg", "w:0", "u:00", "x:1234"] {
        assert!(NativePath(value.into()).to_path().is_err(), "{value}");
    }
}

#[test]
fn native_path_roundtrip_and_root_boundary() {
    let fixture = Fixture::new();
    assert_eq!(
        NativePath::from_path(&fixture.0).to_path().unwrap(),
        fixture.0
    );
    let mut root = fs::canonicalize(&fixture.0).unwrap();
    while let Some(parent) = root.parent() {
        root = parent.to_path_buf();
    }
    assert!(
        list_directory(request(&root, SortKey::Name, SortDirection::Ascending))
            .unwrap()
            .parent
            .is_none()
    );
}

#[cfg(unix)]
#[test]
fn non_utf8_paths_with_colliding_labels_remain_distinct_and_navigable() {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    let fixture = Fixture::new();
    for name in [vec![b'x', 0xff], vec![b'x', 0xfe]] {
        fs::create_dir(fixture.0.join(OsString::from_vec(name))).unwrap();
    }
    let listing = fixture.list(SortKey::Name, SortDirection::Ascending);
    assert_eq!(listing.entries[0].name, listing.entries[1].name);
    assert_ne!(listing.entries[0].path, listing.entries[1].path);
    for entry in listing.entries {
        assert!(
            list_directory(request(
                &entry.path.to_path().unwrap(),
                SortKey::Name,
                SortDirection::Ascending
            ))
            .unwrap()
            .entries
            .is_empty()
        );
    }
}

#[cfg(unix)]
#[test]
fn links_including_broken_and_looping_are_listed_without_traversal() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    symlink(&fixture.0, fixture.0.join("loop")).unwrap();
    symlink(fixture.0.join("missing"), fixture.0.join("broken")).unwrap();
    let listing = fixture.list(SortKey::Name, SortDirection::Ascending);
    assert_eq!(listing.entries.len(), 2);
    assert!(
        listing.entries.iter().all(|e| e.kind == EntryKind::Symlink
            && e.size.is_none()
            && e.metadata_error.is_none())
    );
}

#[cfg(unix)]
#[test]
fn inaccessible_directory_returns_permission_error() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let private = fixture.0.join("private");
    fs::create_dir(&private).unwrap();
    fs::set_permissions(&private, fs::Permissions::from_mode(0o0)).unwrap();
    let permissions_enforced = fs::read_dir(&private).is_err();
    let result = list_directory(request(&private, SortKey::Name, SortDirection::Ascending));
    fs::set_permissions(&private, fs::Permissions::from_mode(0o700)).unwrap();
    if !permissions_enforced {
        eprintln!("Permission-denial assertion skipped: this user/filesystem bypasses mode bits");
        return;
    }
    assert_eq!(
        result.unwrap_err().code,
        ErrorCode::PermissionDenied,
        "Run this test as an unprivileged user so the filesystem enforces permissions"
    );
}

#[cfg(windows)]
#[test]
fn windows_unpaired_surrogates_roundtrip() {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};
    let path = PathBuf::from(OsString::from_wide(&[b'C' as u16, 58, 92, 0xd800]));
    assert_eq!(NativePath::from_path(&path).to_path().unwrap(), path);
}

#[cfg(windows)]
#[test]
fn windows_drive_and_unc_roots_have_no_parent() {
    for root in [
        r"C:\",
        r"\\server\share\",
        r"\\?\C:\",
        r"\\?\UNC\server\share\",
    ] {
        let path = Path::new(root);
        assert!(path.parent().is_none(), "{root}");
        assert_eq!(NativePath::from_path(path).to_path().unwrap(), path);
    }
}

#[test]
fn large_directory_lists_and_sorts_all_entries() {
    let fixture = Fixture::new();
    for index in (0..10_000).rev() {
        fs::File::create(fixture.0.join(format!("file-{index:05}.txt"))).unwrap();
    }
    let started = std::time::Instant::now();
    let listing = fixture.list(SortKey::Name, SortDirection::Ascending);
    eprintln!(
        "10,000 entries: enumeration, metadata and name sort took {:?}",
        started.elapsed()
    );
    assert_eq!(listing.entries.len(), 10_000);
    assert_eq!(listing.entries.first().unwrap().name, "file-00000.txt");
    assert_eq!(listing.entries.last().unwrap().name, "file-09999.txt");
    assert!(
        listing
            .entries
            .iter()
            .all(|entry| entry.size == Some(0) && entry.metadata_error.is_none())
    );
}
