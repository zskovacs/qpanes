use super::*;
use crate::{DirectoryTarget, ListRequest, SortDirection, SortKey, list_directory};
use tempfile::TempDir;

struct Fixture {
    _temp: TempDir,
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::create_dir(root.join("left")).unwrap();
        fs::create_dir(root.join("right")).unwrap();
        Self { _temp: temp, root }
    }
    fn left(&self) -> PathBuf {
        self.root.join("left")
    }
    fn right(&self) -> PathBuf {
        self.root.join("right")
    }
    fn entry(&self, path: &Path) -> Entry {
        list_directory(ListRequest {
            target: DirectoryTarget::Path(NativePath::from_path(path.parent().unwrap())),
            sort: SortKey::Name,
            direction: SortDirection::Ascending,
        })
        .unwrap()
        .entries
        .into_iter()
        .find(|entry| entry.path == NativePath::from_path(path))
        .unwrap()
    }
    fn transfer(&self, name: &str) -> TransferRequest {
        TransferRequest {
            source: self.entry(&self.left().join(name)),
            destination: NativePath::from_path(&self.right()),
        }
    }
    fn create(&self, name: &str) -> Result<OperationResult, FsError> {
        create_directory(CreateDirectoryRequest {
            parent: NativePath::from_path(&self.left()),
            name: name.into(),
        })
    }
    fn rename(&self, old: &str, new: &str) -> Result<OperationResult, FsError> {
        rename_entry(RenameRequest {
            source: self.entry(&self.left().join(old)),
            name: new.into(),
        })
    }
    fn no_staging(&self) {
        assert!(fs::read_dir(self.right()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".qpanes-copy-")
        }));
    }
    fn retained_staging(&self) -> PathBuf {
        let stages: Vec<_> = fs::read_dir(self.right())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".qpanes-copy-")
            })
            .collect();
        assert_eq!(stages.len(), 1);
        stages.into_iter().next().unwrap()
    }
}

#[test]
fn create_directory_unicode_conflict_and_invalid_names() {
    let fixture = Fixture::new();
    let created = fixture.create("árvíz 🦀").unwrap();
    assert_eq!(
        created.path,
        Some(NativePath::from_path(&fixture.left().join("árvíz 🦀")))
    );
    assert!(fixture.left().join("árvíz 🦀").is_dir());
    assert_eq!(
        fixture.create("árvíz 🦀").unwrap_err().code,
        ErrorCode::Conflict
    );
    fs::write(fixture.left().join("existing"), b"keep").unwrap();
    assert_eq!(
        fixture.create("existing").unwrap_err().code,
        ErrorCode::Conflict
    );
    for name in ["", ".", "..", "one/two", "\0bad"] {
        assert_eq!(
            fixture.create(name).unwrap_err().code,
            ErrorCode::InvalidName,
            "{name:?}"
        );
    }
    assert_eq!(fs::read(fixture.left().join("existing")).unwrap(), b"keep");
}

#[test]
fn windows_name_rules_include_devices_extensions_and_superscripts() {
    for name in [
        "CON",
        "con.txt",
        "NUL.tar.gz",
        "COM1",
        "lpt9.txt",
        "COM¹.log",
        "LPT³",
        "trailing.",
        "trailing ",
        "a:b",
        "a\\b",
        "?",
        "\u{1}x",
        "CONIN$",
        "con .txt",
    ] {
        assert!(validate_name_for(name, true).is_err(), "{name:?}");
    }
    for name in [
        "árvíz 🦀.txt",
        "COM10",
        "console",
        ".hidden",
        "a..b",
        " leading",
    ] {
        assert!(validate_name_for(name, true).is_ok(), "{name:?}");
    }
    assert!(validate_name_for("CON", false).is_ok());
    assert!(validate_name_for("a\\b", false).is_ok());
}

#[test]
fn rename_file_and_directory_preserves_identity_contents_and_unicode() {
    let fixture = Fixture::new();
    fs::write(fixture.left().join("a"), b"contents\0\xff").unwrap();
    let identity = fixture.entry(&fixture.left().join("a")).identity;
    let renamed = fixture.rename("a", "új 🦀.bin").unwrap();
    assert_eq!(
        renamed.path,
        Some(NativePath::from_path(&fixture.left().join("új 🦀.bin")))
    );
    assert_eq!(
        fixture.entry(&fixture.left().join("új 🦀.bin")).identity,
        identity
    );
    assert_eq!(
        fs::read(fixture.left().join("új 🦀.bin")).unwrap(),
        b"contents\0\xff"
    );
    assert!(!fixture.left().join("a").exists());
    fs::create_dir(fixture.left().join("dir")).unwrap();
    fs::write(fixture.left().join("dir/child"), b"child").unwrap();
    fixture.rename("dir", "renamed-dir").unwrap();
    assert_eq!(
        fs::read(fixture.left().join("renamed-dir/child")).unwrap(),
        b"child"
    );
}

#[test]
fn rename_rejects_collision_same_name_and_invalid_name_without_changing_source() {
    let fixture = Fixture::new();
    fs::write(fixture.left().join("a"), b"source").unwrap();
    fs::write(fixture.left().join("b"), b"destination").unwrap();
    assert_eq!(
        fixture.rename("a", "b").unwrap_err().code,
        ErrorCode::Conflict
    );
    assert_eq!(
        fixture.rename("a", "a").unwrap_err().code,
        ErrorCode::SameEntry
    );
    for name in ["", "..", "../elsewhere"] {
        assert_eq!(
            fixture.rename("a", name).unwrap_err().code,
            ErrorCode::InvalidName
        );
    }
    assert_eq!(fs::read(fixture.left().join("a")).unwrap(), b"source");
    assert_eq!(fs::read(fixture.left().join("b")).unwrap(), b"destination");
}

#[test]
fn copy_regular_binary_and_nested_tree() {
    let fixture = Fixture::new();
    fs::write(fixture.left().join("a"), b"simple").unwrap();
    copy_entry(fixture.transfer("a")).unwrap();
    assert_eq!(fs::read(fixture.right().join("a")).unwrap(), b"simple");
    let binary: Vec<_> = (0..32768).map(|index| (index % 256) as u8).collect();
    fs::create_dir_all(fixture.left().join("tree/nested/empty")).unwrap();
    fs::write(fixture.left().join("tree/nested/binary"), &binary).unwrap();
    fs::write(fixture.left().join("tree/top"), b"top").unwrap();
    copy_entry(fixture.transfer("tree")).unwrap();
    assert_eq!(
        fs::read(fixture.right().join("tree/nested/binary")).unwrap(),
        binary
    );
    assert_eq!(fs::read(fixture.right().join("tree/top")).unwrap(), b"top");
    assert!(fixture.right().join("tree/nested/empty").is_dir());
    assert!(fixture.left().join("tree/nested/binary").exists());
    fixture.no_staging();
}

#[test]
fn copy_large_file_uses_fixed_buffer_and_exact_bytes() {
    let fixture = Fixture::new();
    let chunk: Vec<_> = (0..COPY_BUFFER).map(|index| (index % 251) as u8).collect();
    let mut file = File::create_new(fixture.left().join("large")).unwrap();
    for _ in 0..513 {
        file.write_all(&chunk).unwrap();
    }
    drop(file);
    copy_entry(fixture.transfer("large")).unwrap();
    let mut source = File::open(fixture.left().join("large")).unwrap();
    let mut destination = File::open(fixture.right().join("large")).unwrap();
    let mut a = [0; COPY_BUFFER];
    let mut b = [0; COPY_BUFFER];
    loop {
        let count = source.read(&mut a).unwrap();
        let other = destination.read(&mut b).unwrap();
        assert_eq!(count, other);
        assert_eq!(a[..count], b[..other]);
        if count == 0 {
            break;
        }
    }
    struct BoundedReader {
        remaining: usize,
    }
    impl Read for BoundedReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            assert!(buffer.len() <= COPY_BUFFER);
            let count = self.remaining.min(buffer.len());
            buffer[..count].fill(7);
            self.remaining -= count;
            Ok(count)
        }
    }
    assert_eq!(
        stream_copy(
            &mut BoundedReader {
                remaining: COPY_BUFFER * 4 + 7
            },
            &mut io::sink()
        )
        .unwrap(),
        (COPY_BUFFER * 4 + 7) as u64
    );
    fixture.no_staging();
}

#[test]
fn deep_copy_fits_a_worker_stack_and_rejects_excess_depth_without_publication() {
    let fixture = Fixture::new();
    let mut leaf = fixture.left().join("deep");
    for _ in 0..48 {
        leaf.push("d");
    }
    fs::create_dir_all(&leaf).unwrap();
    fs::write(leaf.join("contents"), b"deep contents").unwrap();
    let request = fixture.transfer("deep");
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(move || copy_entry(request))
        .unwrap()
        .join()
        .unwrap()
        .unwrap();
    assert_eq!(
        fs::read(
            fixture
                .right()
                .join(leaf.strip_prefix(fixture.left()).unwrap())
                .join("contents")
        )
        .unwrap(),
        b"deep contents"
    );

    let mut excessive = fixture.left().join("excessive");
    for _ in 0..MAX_COPY_DEPTH + 1 {
        excessive.push("d");
    }
    fs::create_dir_all(&excessive).unwrap();
    let request = fixture.transfer("excessive");
    let error = std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(move || copy_entry(request))
        .unwrap()
        .join()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::UnsupportedEntry);
    assert!(!fixture.right().join("excessive").exists());
    assert!(excessive.is_dir());
    let recovery = fixture.retained_staging();
    assert!(recovery.join("payload").is_dir());
    assert!(error.message.contains(&recovery.display().to_string()));
    assert!(
        error
            .message
            .contains("nonempty staging is never deleted automatically")
    );
}

#[test]
fn copy_conflict_self_descendant_missing_and_stale_identity_fail_safely() {
    let fixture = Fixture::new();
    fs::write(fixture.left().join("a"), b"source").unwrap();
    fs::write(fixture.right().join("a"), b"existing").unwrap();
    assert_eq!(
        copy_entry(fixture.transfer("a")).unwrap_err().code,
        ErrorCode::Conflict
    );
    let mut request = fixture.transfer("a");
    request.destination = NativePath::from_path(&fixture.left());
    assert_eq!(copy_entry(request).unwrap_err().code, ErrorCode::SameEntry);
    fs::create_dir_all(fixture.left().join("tree/child")).unwrap();
    for destination in ["tree", "tree/child"] {
        let mut tree = fixture.transfer("tree");
        tree.destination = NativePath::from_path(&fixture.left().join(destination));
        assert_eq!(
            copy_entry(tree.clone()).unwrap_err().code,
            ErrorCode::Descendant
        );
        assert_eq!(move_entry(tree).unwrap_err().code, ErrorCode::Descendant);
    }
    let missing = fixture.transfer("a");
    fs::remove_file(fixture.left().join("a")).unwrap();
    assert_eq!(copy_entry(missing).unwrap_err().code, ErrorCode::NotFound);
    fs::write(fixture.left().join("a"), b"new").unwrap();
    let mut stale = fixture.transfer("a");
    stale.source.identity = Some("wrong".into());
    assert_eq!(
        copy_entry(stale).unwrap_err().code,
        ErrorCode::SourceChanged
    );
    assert_eq!(fs::read(fixture.right().join("a")).unwrap(), b"existing");
    fixture.no_staging();
}

#[cfg(unix)]
#[test]
fn broken_symlink_destinations_are_conflicts_for_every_namespace_operation() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    fs::write(fixture.left().join("source"), b"keep source").unwrap();
    symlink("absent", fixture.right().join("source")).unwrap();
    assert_eq!(
        copy_entry(fixture.transfer("source")).unwrap_err().code,
        ErrorCode::Conflict
    );
    assert_eq!(
        move_entry(fixture.transfer("source")).unwrap_err().code,
        ErrorCode::Conflict
    );
    symlink("absent", fixture.left().join("occupied")).unwrap();
    assert_eq!(
        fixture.rename("source", "occupied").unwrap_err().code,
        ErrorCode::Conflict
    );
    assert_eq!(
        fs::read(fixture.left().join("source")).unwrap(),
        b"keep source"
    );
    assert_eq!(
        fs::read_link(fixture.right().join("source")).unwrap(),
        PathBuf::from("absent")
    );
    assert_eq!(
        fs::read_link(fixture.left().join("occupied")).unwrap(),
        PathBuf::from("absent")
    );
}

#[test]
fn native_publication_rejects_concurrent_destination_creation() {
    let fixture = Fixture::new();
    let directory = open_directory(&fixture.right()).unwrap();
    fs::write(fixture.right().join("prepared"), b"copy").unwrap();
    // Simulate a creator winning after validation and before publication.
    assert!(directory.symlink_metadata("target").is_err());
    fs::write(fixture.right().join("target"), b"race winner").unwrap();
    assert_eq!(
        native::rename_noreplace(
            &directory,
            OsStr::new("prepared"),
            &directory,
            OsStr::new("target"),
            None
        )
        .unwrap_err()
        .code,
        ErrorCode::Conflict
    );
    assert_eq!(
        fs::read(fixture.right().join("target")).unwrap(),
        b"race winner"
    );
    assert_eq!(fs::read(fixture.right().join("prepared")).unwrap(), b"copy");
}

#[test]
fn move_file_and_directory_use_same_filesystem_identity_and_preserve_source_on_conflict() {
    let fixture = Fixture::new();
    fs::write(fixture.left().join("a"), b"move").unwrap();
    let request = fixture.transfer("a");
    let identity = request.source.identity.clone();
    move_entry(request).unwrap();
    assert!(!fixture.left().join("a").exists());
    assert_eq!(fixture.entry(&fixture.right().join("a")).identity, identity);
    fs::create_dir(fixture.left().join("dir")).unwrap();
    fs::write(fixture.left().join("dir/child"), b"keep").unwrap();
    fs::create_dir(fixture.right().join("dir")).unwrap();
    assert_eq!(
        move_entry(fixture.transfer("dir")).unwrap_err().code,
        ErrorCode::Conflict
    );
    assert_eq!(fs::read(fixture.left().join("dir/child")).unwrap(), b"keep");
    fs::remove_dir(fixture.right().join("dir")).unwrap();
    move_entry(fixture.transfer("dir")).unwrap();
    assert_eq!(
        fs::read(fixture.right().join("dir/child")).unwrap(),
        b"keep"
    );
    assert!(!fixture.left().join("dir").exists());
}

#[cfg(unix)]
#[test]
fn symlinks_special_entries_aliases_and_partial_tree_failure_never_publish() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    fs::write(fixture.left().join("outside"), b"must survive").unwrap();
    symlink("outside", fixture.left().join("link")).unwrap();
    assert_eq!(
        copy_entry(fixture.transfer("link")).unwrap_err().code,
        ErrorCode::UnsupportedEntry
    );
    assert_eq!(
        move_entry(fixture.transfer("link")).unwrap_err().code,
        ErrorCode::UnsupportedEntry
    );
    assert_eq!(
        fixture.rename("link", "new").unwrap_err().code,
        ErrorCode::UnsupportedEntry
    );
    assert_eq!(
        trash_entry(TrashRequest {
            source: fixture.entry(&fixture.left().join("link"))
        })
        .unwrap_err()
        .code,
        ErrorCode::UnsupportedEntry
    );
    fs::create_dir(fixture.left().join("tree")).unwrap();
    fs::write(fixture.left().join("tree/file"), b"some copied data").unwrap();
    symlink("..", fixture.left().join("tree/loop")).unwrap();
    let error = copy_entry(fixture.transfer("tree")).unwrap_err();
    assert_eq!(error.code, ErrorCode::UnsupportedEntry);
    assert!(!fixture.right().join("tree").exists());
    assert_eq!(
        fs::read(fixture.left().join("outside")).unwrap(),
        b"must survive"
    );
    let recovery = fixture.retained_staging();
    assert!(recovery.join("payload").is_dir());
    assert!(error.message.contains(&recovery.display().to_string()));
    // Native directory moves carry contained links unchanged, without traversal.
    move_entry(fixture.transfer("tree")).unwrap();
    assert_eq!(
        fs::read_link(fixture.right().join("tree/loop")).unwrap(),
        PathBuf::from("..")
    );
    assert_eq!(
        fs::read(fixture.right().join("tree/file")).unwrap(),
        b"some copied data"
    );
    symlink(fixture.right(), fixture.root.join("alias")).unwrap();
    let mut request = fixture.transfer("outside");
    request.destination = NativePath::from_path(&fixture.root.join("alias"));
    assert!(copy_entry(request).is_err());
    #[cfg(target_os = "linux")]
    rustix::fs::mkfifoat(
        rustix::fs::CWD,
        fixture.left().join("special"),
        rustix::fs::Mode::RUSR,
    )
    .unwrap();
    #[cfg(not(target_os = "linux"))]
    let _socket = std::os::unix::net::UnixListener::bind(fixture.left().join("special")).unwrap();
    assert_eq!(
        copy_entry(fixture.transfer("special")).unwrap_err().code,
        ErrorCode::UnsupportedEntry
    );
}

#[cfg(unix)]
#[test]
fn non_utf8_sources_use_native_identity_for_copy_move_and_rename() {
    use std::os::unix::ffi::OsStringExt;
    let fixture = Fixture::new();
    let name = OsString::from_vec(b"native-\xff".to_vec());
    let path = fixture.left().join(&name);
    fs::write(&path, b"native").unwrap();
    let source = fixture.entry(&path);
    assert!(source.name.contains('\u{fffd}'));
    copy_entry(TransferRequest {
        source: source.clone(),
        destination: NativePath::from_path(&fixture.right()),
    })
    .unwrap();
    assert_eq!(fs::read(fixture.right().join(&name)).unwrap(), b"native");
    let renamed = rename_entry(RenameRequest {
        source,
        name: "unicode 🦀".into(),
    })
    .unwrap();
    let renamed_path = renamed.path.unwrap().to_path().unwrap();
    move_entry(TransferRequest {
        source: fixture.entry(&renamed_path),
        destination: NativePath::from_path(&fixture.right()),
    })
    .unwrap();
    assert_eq!(
        fs::read(fixture.right().join("unicode 🦀")).unwrap(),
        b"native"
    );
}

#[cfg(unix)]
#[test]
fn ordinary_permissions_and_times_are_preserved_without_privilege_bits() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let fixture = Fixture::new();
    fs::write(fixture.left().join("a"), b"contents").unwrap();
    fs::set_permissions(fixture.left().join("a"), fs::Permissions::from_mode(0o6750)).unwrap();
    let time = UNIX_EPOCH + std::time::Duration::from_secs(1_234_567);
    File::open(fixture.left().join("a"))
        .unwrap()
        .set_times(FileTimes::new().set_accessed(time).set_modified(time))
        .unwrap();
    copy_entry(fixture.transfer("a")).unwrap();
    let metadata = fs::metadata(fixture.right().join("a")).unwrap();
    assert_eq!(metadata.mode() & 0o7777, 0o750);
    assert_eq!(metadata.modified().unwrap(), time);
    assert_eq!(metadata.accessed().unwrap(), time);
}

#[cfg(unix)]
#[test]
fn directory_metadata_works_with_capability_path_handles() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let fixture = Fixture::new();
    let path = fixture.left().join("tree");
    fs::create_dir(&path).unwrap();
    fs::write(path.join("child"), b"child").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o750)).unwrap();
    let time = UNIX_EPOCH + std::time::Duration::from_secs(1_234_567);
    File::open(&path)
        .unwrap()
        .set_times(FileTimes::new().set_modified(time))
        .unwrap();
    copy_entry(fixture.transfer("tree")).unwrap();
    let metadata = fs::metadata(fixture.right().join("tree")).unwrap();
    assert_eq!(metadata.mode() & 0o777, 0o750);
    assert_eq!(metadata.modified().unwrap(), time);
    fixture.no_staging();
}

#[cfg(unix)]
#[test]
fn permissions_fail_without_publishing_or_losing_sources() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    fs::write(fixture.left().join("a"), b"source").unwrap();
    let request = fixture.transfer("a");
    fs::set_permissions(fixture.right(), fs::Permissions::from_mode(0o500)).unwrap();
    let copy = copy_entry(request.clone());
    let moved = move_entry(request);
    fs::set_permissions(fixture.right(), fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(copy.unwrap_err().code, ErrorCode::PermissionDenied);
    assert_eq!(moved.unwrap_err().code, ErrorCode::PermissionDenied);
    assert_eq!(fs::read(fixture.left().join("a")).unwrap(), b"source");
    fs::set_permissions(fixture.left(), fs::Permissions::from_mode(0o500)).unwrap();
    let create = fixture.create("new");
    let rename = fixture.rename("a", "renamed");
    fs::set_permissions(fixture.left(), fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(create.unwrap_err().code, ErrorCode::PermissionDenied);
    assert_eq!(rename.unwrap_err().code, ErrorCode::PermissionDenied);
    fs::set_permissions(fixture.left().join("a"), fs::Permissions::from_mode(0o000)).unwrap();
    let copy = copy_entry(fixture.transfer("a"));
    fs::set_permissions(fixture.left().join("a"), fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(copy.unwrap_err().code, ErrorCode::PermissionDenied);
    fixture.no_staging();
}

#[cfg(target_os = "linux")]
#[test]
fn cross_device_move_has_no_copy_delete_fallback() {
    let fixture = Fixture::new();
    let Ok(other) = tempfile::tempdir_in("/dev/shm") else {
        eprintln!("Cross-device fixture unavailable; run unsandboxed to exercise this test.");
        return;
    };
    let left = open_directory(&fixture.left()).unwrap();
    let right = open_directory(other.path()).unwrap();
    if dir_identity(&left).unwrap().device == dir_identity(&right).unwrap().device {
        return;
    }
    fs::write(fixture.left().join("a"), b"source").unwrap();
    let mut request = fixture.transfer("a");
    request.destination = NativePath::from_path(other.path());
    assert_eq!(
        move_entry(request.clone()).unwrap_err().code,
        ErrorCode::CrossDeviceNotSupported
    );
    assert_eq!(fs::read(fixture.left().join("a")).unwrap(), b"source");
    assert!(!other.path().join("a").exists());
    copy_entry(request).unwrap();
    assert_eq!(fs::read(other.path().join("a")).unwrap(), b"source");
    assert_eq!(fs::read(fixture.left().join("a")).unwrap(), b"source");
}

#[test]
fn source_display_name_is_never_used_as_the_source_path() {
    let fixture = Fixture::new();
    fs::write(fixture.left().join("actual"), b"selected bytes").unwrap();
    fs::write(fixture.left().join("misleading"), b"unselected bytes").unwrap();
    let mut source = fixture.entry(&fixture.left().join("actual"));
    source.name = "misleading".into();
    rename_entry(RenameRequest {
        source,
        name: "renamed".into(),
    })
    .unwrap();
    assert_eq!(
        fs::read(fixture.left().join("renamed")).unwrap(),
        b"selected bytes"
    );
    assert_eq!(
        fs::read(fixture.left().join("misleading")).unwrap(),
        b"unselected bytes"
    );
}

#[test]
fn recursion_rejects_its_own_staging_if_namespace_changes_put_it_in_the_source() {
    let fixture = Fixture::new();
    let source = open_directory(&fixture.left()).unwrap();
    let staging = Staging::create(&source, &fixture.left(), "copy").unwrap();
    let mut input = dir_file(&staging.directory).unwrap();
    let id = dir_identity(&staging.directory).unwrap();
    let mount = native::mount_id(&input).unwrap();
    let error = copy_node(
        &mut input,
        &source,
        OsStr::new("must-not-exist"),
        id.device,
        mount,
        id,
        &mut Vec::new(),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::UnsupportedEntry);
    assert!(!fixture.left().join("must-not-exist").exists());
    staging.cleanup().unwrap();
}

#[test]
fn write_failure_propagates_instead_of_reporting_success() {
    struct Full {
        written: usize,
    }
    impl Write for Full {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.written >= COPY_BUFFER {
                return Err(io::Error::from(io::ErrorKind::StorageFull));
            }
            self.written += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut source = io::repeat(7).take(COPY_BUFFER as u64 * 3);
    let error = stream_copy(&mut source, &mut Full { written: 0 }).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::StorageFull);
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn trash_rejects_a_replaced_absolute_parent_before_os_handoff() {
    let fixture = Fixture::new();
    fs::write(fixture.left().join("selected"), b"original selected bytes").unwrap();
    let source = Source::open(fixture.entry(&fixture.left().join("selected"))).unwrap();
    let moved_parent = fixture.root.join("moved-parent");
    fs::rename(fixture.left(), &moved_parent).unwrap();
    fs::create_dir(fixture.left()).unwrap();
    fs::write(fixture.left().join("selected"), b"unrelated replacement").unwrap();
    // The anchored original is still valid; the absolute Trash pathname is not.
    source.revalidate().unwrap();
    assert_eq!(
        native::trash(source).unwrap_err().code,
        ErrorCode::SourceChanged
    );
    assert_eq!(
        fs::read(fixture.left().join("selected")).unwrap(),
        b"unrelated replacement"
    );
    assert_eq!(
        fs::read(moved_parent.join("selected")).unwrap(),
        b"original selected bytes"
    );
}

#[cfg(windows)]
#[test]
fn windows_rename_checks_the_identity_of_its_delete_capable_handle() {
    let fixture = Fixture::new();
    fs::write(fixture.left().join("selected"), b"original selected bytes").unwrap();
    let original = File::open(fixture.left().join("selected")).unwrap();
    let expected = native::identity(&original).unwrap();
    drop(original);
    fs::rename(
        fixture.left().join("selected"),
        fixture.left().join("original"),
    )
    .unwrap();
    fs::write(fixture.left().join("selected"), b"unrelated replacement").unwrap();
    let directory = open_directory(&fixture.left()).unwrap();
    let error = native::rename_noreplace(
        &directory,
        OsStr::new("selected"),
        &directory,
        OsStr::new("new-name"),
        Some(expected),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::SourceChanged);
    assert!(!fixture.left().join("new-name").exists());
    assert_eq!(
        fs::read(fixture.left().join("selected")).unwrap(),
        b"unrelated replacement"
    );
    assert_eq!(
        fs::read(fixture.left().join("original")).unwrap(),
        b"original selected bytes"
    );
}

#[test]
fn cleanup_retains_nonempty_staging_for_review_on_every_platform() {
    let fixture = Fixture::new();
    let parent = open_directory(&fixture.right()).unwrap();
    let staging = Staging::create(&parent, &fixture.right(), "copy").unwrap();
    let recovery = staging.path.clone();
    fs::write(recovery.join("unpublished"), b"review before removal").unwrap();
    assert!(staging.cleanup().is_err());
    assert_eq!(
        fs::read(recovery.join("unpublished")).unwrap(),
        b"review before removal"
    );
}

#[test]
fn cleanup_never_deletes_contents_of_a_substituted_staging_directory() {
    let fixture = Fixture::new();
    let parent = open_directory(&fixture.right()).unwrap();
    let stage_path = fixture.right().join(".qpanes-copy-substituted");
    parent.create_dir(stage_path.file_name().unwrap()).unwrap();
    let saved = fixture.root.join("original-empty-stage");
    fs::rename(&stage_path, &saved).unwrap();
    let foreign = fixture.root.join("independent-directory");
    fs::create_dir(&foreign).unwrap();
    fs::write(foreign.join("independent-data"), b"never delete this").unwrap();
    fs::rename(&foreign, &stage_path).unwrap();
    // Reproduce mkdir -> concurrent replacement -> open, without timing races.
    let staging = Staging {
        directory: parent
            .open_dir_nofollow(stage_path.file_name().unwrap())
            .unwrap(),
        path: stage_path.clone(),
    };
    assert!(staging.cleanup().is_err());
    assert_eq!(
        fs::read(stage_path.join("independent-data")).unwrap(),
        b"never delete this"
    );
    assert!(saved.is_dir());
}

#[test]
fn staging_acquisition_rejects_a_populated_replacement_without_cleanup() {
    let fixture = Fixture::new();
    let parent = open_directory(&fixture.right()).unwrap();
    let stage_path = fixture.right().join(".qpanes-copy-replaced-before-open");
    fs::create_dir(&stage_path).unwrap();
    let saved = fixture.root.join("original-empty-stage");
    fs::rename(&stage_path, &saved).unwrap();
    let foreign = fixture.root.join("independent-directory");
    fs::create_dir(&foreign).unwrap();
    fs::write(
        foreign.join("independent-data"),
        b"unrelated original bytes",
    )
    .unwrap();
    fs::rename(&foreign, &stage_path).unwrap();
    let error = Staging::open_created(&parent, stage_path.clone())
        .err()
        .unwrap();
    assert_eq!(error.code, ErrorCode::SourceChanged);
    assert!(error.message.contains(&stage_path.display().to_string()));
    assert!(error.message.contains("left untouched"));
    assert_eq!(
        fs::read(stage_path.join("independent-data")).unwrap(),
        b"unrelated original bytes"
    );
    assert!(saved.is_dir());
}

#[test]
fn successful_copy_retains_foreign_staging_contents_and_returns_a_warning() {
    let fixture = Fixture::new();
    fs::write(fixture.left().join("selected"), b"selected source bytes").unwrap();
    let mut source = Source::open(fixture.entry(&fixture.left().join("selected"))).unwrap();
    let destination = open_directory(&fixture.right()).unwrap();
    let staging = Staging::create(&destination, &fixture.right(), "copy").unwrap();
    let recovery = staging.path.clone();
    // A different writer introduces unrelated data after staging acquisition.
    let foreign = fixture.root.join("independent-data");
    fs::write(&foreign, b"never delete these unrelated bytes").unwrap();
    fs::rename(&foreign, recovery.join("independent-data")).unwrap();
    let result = copy_to_staging(&mut source, &destination, &fixture.right(), staging).unwrap();
    assert_eq!(
        result.path,
        Some(NativePath::from_path(&fixture.right().join("selected")))
    );
    assert_eq!(
        fs::read(fixture.right().join("selected")).unwrap(),
        b"selected source bytes"
    );
    assert_eq!(
        fs::read(fixture.left().join("selected")).unwrap(),
        b"selected source bytes"
    );
    assert_eq!(
        fs::read(recovery.join("independent-data")).unwrap(),
        b"never delete these unrelated bytes"
    );
    assert!(!recovery.join("payload").exists());
    assert_eq!(result.warnings.len(), 1);
    assert!(result.warnings[0].contains(&recovery.display().to_string()));
    assert!(result.warnings[0].contains("nonempty staging is never deleted automatically"));
}

#[test]
fn failed_copy_retains_foreign_payload_and_staging_contents() {
    let fixture = Fixture::new();
    fs::write(fixture.left().join("selected"), b"selected source bytes").unwrap();
    let mut source = Source::open(fixture.entry(&fixture.left().join("selected"))).unwrap();
    let destination = open_directory(&fixture.right()).unwrap();
    let staging = Staging::create(&destination, &fixture.right(), "copy").unwrap();
    let recovery = staging.path.clone();
    fs::write(recovery.join("payload"), b"preexisting conflicting payload").unwrap();
    fs::write(
        recovery.join("independent-data"),
        b"unrelated original bytes",
    )
    .unwrap();
    let error = copy_to_staging(&mut source, &destination, &fixture.right(), staging).unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert!(error.message.contains(&recovery.display().to_string()));
    assert!(
        error
            .message
            .contains("nonempty staging is never deleted automatically")
    );
    assert!(!fixture.right().join("selected").exists());
    assert_eq!(
        fs::read(fixture.left().join("selected")).unwrap(),
        b"selected source bytes"
    );
    assert_eq!(
        fs::read(recovery.join("payload")).unwrap(),
        b"preexisting conflicting payload"
    );
    assert_eq!(
        fs::read(recovery.join("independent-data")).unwrap(),
        b"unrelated original bytes"
    );
}

#[test]
fn cleanup_preserves_nonempty_stage_and_replacement_after_stage_is_renamed() {
    let fixture = Fixture::new();
    let destination = open_directory(&fixture.right()).unwrap();
    let staging = Staging::create(&destination, &fixture.right(), "copy").unwrap();
    let reserved = staging.path.clone();
    fs::write(reserved.join("payload"), b"incomplete bytes for review").unwrap();
    let renamed = fixture.root.join("renamed-staging");
    fs::rename(&reserved, &renamed).unwrap();
    fs::create_dir(&reserved).unwrap();
    fs::write(reserved.join("independent-data"), b"replacement bytes").unwrap();
    assert!(staging.cleanup().is_err());
    assert_eq!(
        fs::read(renamed.join("payload")).unwrap(),
        b"incomplete bytes for review"
    );
    assert_eq!(
        fs::read(reserved.join("independent-data")).unwrap(),
        b"replacement bytes"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn trash_failure_has_no_permanent_deletion_fallback() {
    // A separate test process makes D-Bus failure deterministic without changing
    // process-global environment in a multithreaded Rust test runner.
    const CHILD: &str = "QPANES_TEST_TRASH_FAILURE";
    if std::env::var_os(CHILD).is_some() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.left().join("tree/child")).unwrap();
        fs::write(fixture.left().join("tree/child/data"), b"keep").unwrap();
        let error = trash_entry(TrashRequest {
            source: fixture.entry(&fixture.left().join("tree")),
        })
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::TrashFailed);
        assert!(
            error
                .message
                .contains("does not fall back to permanent deletion")
        );
        assert_eq!(
            fs::read(fixture.left().join("tree/child/data")).unwrap(),
            b"keep"
        );
        return;
    }
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "operations::tests::trash_failure_has_no_permanent_deletion_fallback",
            "--nocapture",
        ])
        .env(CHILD, "1")
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            "unix:path=/tmp/qpanes-deliberately-absent-dbus",
        )
        .status()
        .unwrap();
    assert!(status.success());
}
