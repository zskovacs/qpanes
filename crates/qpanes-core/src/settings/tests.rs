use super::*;
use std::path::PathBuf;

/// Disposable configuration directory; never the developer's real settings.
struct Config(tempfile::TempDir);
impl Config {
    fn new() -> Self {
        Self(
            tempfile::Builder::new()
                .prefix("qpanes-settings-")
                .tempdir()
                .unwrap(),
        )
    }
    fn dir(&self) -> &Path {
        self.0.path()
    }
    fn file(&self) -> PathBuf {
        self.dir().join(SETTINGS_FILE)
    }
    fn backup(&self) -> PathBuf {
        self.dir().join(INVALID_SETTINGS_FILE)
    }
    fn write(&self, text: &str) {
        fs::write(self.file(), text).unwrap();
    }
}

fn native(path: &Path) -> NativePath {
    NativePath::from_path(path)
}

fn tab(path: Option<NativePath>, name: &str) -> TabState {
    TabState {
        path,
        location: format!("/display/{name}"),
        name: name.to_owned(),
        sort: SortKey::Size,
        direction: SortDirection::Descending,
    }
}

fn sample(config: &Config) -> SettingsDocument {
    let mut shortcuts = BTreeMap::new();
    shortcuts.insert("closeTab".to_owned(), "Ctrl+Shift+W".to_owned());
    SettingsDocument {
        version: 1,
        favorites: vec![Favorite {
            id: "f-1".into(),
            label: "Árvíz projects 🦀".into(),
            path: native(config.dir()),
            location: config.dir().to_string_lossy().into_owned(),
        }],
        shortcuts,
        session: Some(SessionState {
            active_side: Side::Right,
            left: Some(PanelSession {
                active_tab: 1,
                tabs: vec![tab(None, "home"), tab(Some(native(config.dir())), "config")],
            }),
            right: None,
        }),
    }
}

fn temporary_files(config: &Config) -> Vec<String> {
    fs::read_dir(config.dir())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect()
}

#[test]
fn missing_settings_use_defaults_and_allow_saving() {
    let config = Config::new();
    let loaded = load_settings(&config.dir().join("not-created-yet"));
    assert_eq!(loaded.status, SettingsStatus::Missing);
    assert_eq!(loaded.document, SettingsDocument::default());
    assert!(loaded.warnings.is_empty());
}

#[test]
fn saved_settings_round_trip_atomically_without_leftover_temporaries() {
    let config = Config::new();
    let nested = config.dir().join("io.qpanes.app");
    let document = sample(&config);
    save_settings(&nested, &document).unwrap();
    let loaded = load_settings(&nested);
    assert_eq!(
        loaded.status,
        SettingsStatus::Loaded,
        "{:?}",
        loaded.warnings
    );
    assert_eq!(loaded.document, document);
    let mut changed = document.clone();
    changed.favorites[0].label = "Renamed".into();
    save_settings(&nested, &changed).unwrap();
    assert_eq!(
        load_settings(&nested).document,
        changed,
        "save replaces the previous file"
    );
    assert!(fs::read_dir(&nested).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")
    }));
    let text = fs::read_to_string(nested.join(SETTINGS_FILE)).unwrap();
    assert!(
        text.contains("\"version\": 1") && text.contains("\"activeSide\": \"right\""),
        "{text}"
    );
}

#[cfg(unix)]
#[test]
fn non_utf8_directory_identifiers_survive_persistence_losslessly() {
    use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
    let config = Config::new();
    let directory = config.dir().join(OsStr::from_bytes(b"lossy-\xff-name"));
    fs::create_dir(&directory).unwrap();
    let mut document = SettingsDocument::default();
    document.favorites.push(Favorite {
        id: "lossy".into(),
        label: "lossy-�-name".into(),
        path: native(&directory),
        location: directory.to_string_lossy().into_owned(),
    });
    save_settings(config.dir(), &document).unwrap();
    let loaded = load_settings(config.dir());
    assert_eq!(loaded.status, SettingsStatus::Loaded);
    assert_eq!(
        loaded.document.favorites[0].path.to_path().unwrap(),
        directory
    );
    assert_eq!(
        probe_status(&loaded.document.favorites[0].path),
        crate::DirectoryStatus::Available
    );
}

#[cfg(unix)]
fn probe_status(path: &NativePath) -> crate::DirectoryStatus {
    crate::probe_directories(std::slice::from_ref(path)).unwrap()[0]
}

#[test]
fn corrupt_json_is_preserved_before_defaults_are_used() {
    let config = Config::new();
    config.write("{ \"version\": 1, \"favorites\": [");
    let loaded = load_settings(config.dir());
    assert_eq!(loaded.status, SettingsStatus::Recovered);
    assert_eq!(loaded.document, SettingsDocument::default());
    assert!(
        loaded
            .warnings
            .iter()
            .any(|warning| warning.contains("not valid JSON")),
        "{:?}",
        loaded.warnings
    );
    assert_eq!(
        fs::read_to_string(config.backup()).unwrap(),
        "{ \"version\": 1, \"favorites\": ["
    );
    save_settings(config.dir(), &sample(&config)).unwrap();
    assert_eq!(
        fs::read_to_string(config.backup()).unwrap(),
        "{ \"version\": 1, \"favorites\": [",
        "saving never touches the backup"
    );
}

#[test]
fn incompatible_or_unversioned_documents_are_not_interpreted() {
    for (text, reason) in [
        (
            "{\"version\": 2, \"favorites\": []}",
            "unsupported version 2",
        ),
        ("{\"favorites\": []}", "no supported version"),
        ("[1, 2, 3]", "does not contain a settings object"),
        ("\"text\"", "does not contain a settings object"),
    ] {
        let config = Config::new();
        config.write(text);
        let loaded = load_settings(config.dir());
        assert_eq!(loaded.status, SettingsStatus::Recovered, "{text}");
        assert_eq!(loaded.document, SettingsDocument::default());
        assert!(
            loaded
                .warnings
                .iter()
                .any(|warning| warning.contains(reason)),
            "{text}: {:?}",
            loaded.warnings
        );
        assert_eq!(fs::read_to_string(config.backup()).unwrap(), text);
    }
}

#[test]
fn invalid_items_are_dropped_individually_and_the_original_is_preserved() {
    let config = Config::new();
    let good = native(config.dir());
    let foreign = if cfg!(windows) {
        "u:2f746d70"
    } else {
        "w:43003a00"
    };
    let text = serde_json::json!({
        "version": 1,
        "favorites": [
            { "id": "a", "label": "Good", "path": good, "location": "/good" },
            { "id": "b", "label": "Foreign platform", "path": foreign, "location": "/x" },
            { "id": "c", "label": "Bad hex", "path": "u:zz", "location": "/x" },
            { "id": "d", "label": "Duplicate path", "path": good, "location": "/good" },
            { "id": "e", "label": "  padded  ", "path": good, "location": "/good" },
            { "id": "f", "label": "Relative", "path": native(Path::new("relative")), "location": "relative" },
            { "id": "g", "label": "Extra", "path": good, "location": "/good", "unexpected": true },
            "not an object"
        ],
        "shortcuts": { "copy": "F9", "move": 5, "bad action": "F4", "trash": "" },
        "session": {
            "activeSide": "middle",
            "left": { "activeTab": 9, "tabs": [ { "path": good, "location": "/good", "name": "good", "sort": "name", "direction": "ascending" }, { "path": "u:zz", "location": "", "name": "", "sort": "name", "direction": "ascending" } ] },
            "right": { "activeTab": 0, "tabs": [ { "path": null, "location": "", "name": "", "sort": "chaos", "direction": "ascending" } ] }
        },
        "futureSetting": true
    })
    .to_string();
    config.write(&text);
    let loaded = load_settings(config.dir());
    assert_eq!(loaded.status, SettingsStatus::Recovered);
    assert_eq!(loaded.document.favorites.len(), 1);
    assert_eq!(loaded.document.favorites[0].label, "Good");
    assert_eq!(loaded.document.shortcuts.len(), 1);
    assert_eq!(loaded.document.shortcuts["copy"], "F9");
    let session = loaded.document.session.clone().unwrap();
    assert_eq!(
        session.active_side,
        Side::Left,
        "invalid active side falls back to the left panel"
    );
    let left = session.left.unwrap();
    assert_eq!(
        (left.tabs.len(), left.active_tab),
        (1, 0),
        "out-of-range active tab is clamped"
    );
    assert!(
        session.right.is_none(),
        "a panel without valid tabs falls back to home"
    );
    assert!(loaded.warnings.len() >= 10, "{:?}", loaded.warnings);
    assert!(
        loaded
            .warnings
            .iter()
            .any(|warning| warning.contains("futureSetting"))
    );
    assert_eq!(
        fs::read_to_string(config.backup()).unwrap(),
        text,
        "original bytes are preserved for manual recovery"
    );
    assert_eq!(
        fs::read_to_string(config.file()).unwrap(),
        text,
        "loading never rewrites settings.json"
    );
    save_settings(config.dir(), &loaded.document).unwrap();
    assert_eq!(
        load_settings(config.dir()).status,
        SettingsStatus::Loaded,
        "sanitized settings save cleanly"
    );
}

#[test]
fn the_active_tab_follows_its_tab_when_earlier_tabs_are_dropped() {
    let config = Config::new();
    let good = native(config.dir());
    let tab = |path: serde_json::Value, name: &str| serde_json::json!({ "path": path, "location": name, "name": name, "sort": "name", "direction": "ascending" });
    let text = serde_json::json!({ "version": 1, "favorites": [], "shortcuts": {}, "session": {
        "activeSide": "left",
        "left": { "activeTab": 1, "tabs": [tab("u:zz".into(), "invalid"), tab(serde_json::to_value(&good).unwrap(), "b"), tab(serde_json::Value::Null, "c")] },
        "right": { "activeTab": 0, "tabs": [tab("u:zz".into(), "invalid"), tab(serde_json::Value::Null, "d")] }
    } })
    .to_string();
    config.write(&text);
    let session = load_settings(config.dir()).document.session.unwrap();
    let left = session.left.unwrap();
    assert_eq!(
        left.tabs[left.active_tab].name, "b",
        "the previously active tab stays active"
    );
    assert_eq!(
        session.right.unwrap().active_tab,
        0,
        "a dropped active tab falls back to the first remaining tab"
    );
}

#[cfg(unix)]
#[test]
fn saving_through_a_symlinked_settings_file_keeps_the_link() {
    let config = Config::new();
    let dotfiles = config.dir().join("dotfiles");
    fs::create_dir(&dotfiles).unwrap();
    let target = dotfiles.join("qpanes.json");
    save_settings(&dotfiles, &SettingsDocument::default()).unwrap();
    fs::rename(dotfiles.join(SETTINGS_FILE), &target).unwrap();
    let app = config.dir().join("app");
    fs::create_dir(&app).unwrap();
    std::os::unix::fs::symlink(&target, app.join(SETTINGS_FILE)).unwrap();
    let document = sample(&config);
    save_settings(&app, &document).unwrap();
    assert!(
        fs::symlink_metadata(app.join(SETTINGS_FILE))
            .unwrap()
            .file_type()
            .is_symlink(),
        "the link itself is preserved"
    );
    assert_eq!(load_settings(&app).document, document);
    assert_eq!(
        serde_json::from_slice::<SettingsDocument>(&fs::read(&target).unwrap()).unwrap(),
        document,
        "the link target receives the update"
    );
}

#[test]
fn oversized_settings_are_moved_aside_without_reading_them_fully() {
    let config = Config::new();
    let file = fs::File::create(config.file()).unwrap();
    file.set_len(MAX_SETTINGS_BYTES + 10).unwrap();
    let loaded = load_settings(config.dir());
    assert_eq!(loaded.status, SettingsStatus::Recovered);
    assert!(loaded.warnings[0].contains("larger than 2 MiB"));
    assert!(!config.file().exists());
    assert_eq!(
        fs::metadata(config.backup()).unwrap().len(),
        MAX_SETTINGS_BYTES + 10
    );
}

#[test]
fn unreadable_settings_disable_saving_and_are_left_untouched() {
    let config = Config::new();
    fs::create_dir(config.file()).unwrap();
    let loaded = load_settings(config.dir());
    assert_eq!(loaded.status, SettingsStatus::Unavailable);
    assert!(loaded.warnings[0].contains("will not be saved"));
    assert!(config.file().is_dir());
    assert!(!config.backup().exists());
}

#[cfg(unix)]
#[test]
fn permission_denied_settings_are_not_reset() {
    use std::os::unix::fs::PermissionsExt;
    let config = Config::new();
    config.write("{\"version\":1}");
    fs::set_permissions(config.file(), fs::Permissions::from_mode(0o000)).unwrap();
    if fs::read(config.file()).is_ok() {
        return; // Running with privileges that bypass permissions.
    }
    let loaded = load_settings(config.dir());
    fs::set_permissions(config.file(), fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(loaded.status, SettingsStatus::Unavailable);
    assert_eq!(
        fs::read_to_string(config.file()).unwrap(),
        "{\"version\":1}"
    );
}

#[test]
fn a_backup_that_cannot_be_written_disables_saving() {
    let config = Config::new();
    config.write("not json");
    fs::create_dir(config.backup()).unwrap();
    fs::write(config.backup().join("occupied"), b"keep").unwrap();
    let loaded = load_settings(config.dir());
    assert_eq!(loaded.status, SettingsStatus::Unavailable);
    assert!(
        loaded
            .warnings
            .iter()
            .any(|warning| warning.contains("could not be preserved"))
    );
    assert_eq!(fs::read_to_string(config.file()).unwrap(), "not json");
    assert_eq!(fs::read(config.backup().join("occupied")).unwrap(), b"keep");
    assert!(
        temporary_files(&config).is_empty(),
        "the failed temporary file is removed"
    );
}

#[test]
fn strict_save_rejects_invalid_documents_without_touching_the_file() {
    let config = Config::new();
    let valid = sample(&config);
    save_settings(config.dir(), &valid).unwrap();
    let before = fs::read(config.file()).unwrap();
    let mut cases: Vec<SettingsDocument> = Vec::new();
    let mut case = |change: &dyn Fn(&mut SettingsDocument)| {
        let mut document = valid.clone();
        change(&mut document);
        cases.push(document);
    };
    case(&|d| d.version = 2);
    case(&|d| d.favorites[0].path = NativePath("u:zz".into()));
    case(&|d| d.favorites[0].label = String::new());
    case(&|d| d.favorites[0].label = "line\nbreak".into());
    case(&|d| d.favorites[0].label = "x".repeat(MAX_LABEL_CHARS + 1));
    case(&|d| d.favorites[0].id = "../escape".into());
    case(&|d| {
        d.favorites.push(Favorite {
            id: "f-2".into(),
            ..d.favorites[0].clone()
        })
    });
    case(&|d| {
        d.favorites.push(Favorite {
            path: native(Path::new("/elsewhere")),
            ..d.favorites[0].clone()
        })
    });
    case(&|d| {
        d.shortcuts.insert("copy".into(), "Ctrl+ Space".into());
    });
    case(&|d| {
        d.session
            .as_mut()
            .unwrap()
            .left
            .as_mut()
            .unwrap()
            .active_tab = 2
    });
    case(&|d| {
        d.session
            .as_mut()
            .unwrap()
            .left
            .as_mut()
            .unwrap()
            .tabs
            .clear()
    });
    case(&|d| {
        let left = d.session.as_mut().unwrap().left.as_mut().unwrap();
        left.tabs = vec![left.tabs[0].clone(); MAX_TABS + 1];
    });
    for document in cases {
        let error = save_settings(config.dir(), &document).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidSettings, "{document:?}");
        assert_eq!(fs::read(config.file()).unwrap(), before);
    }
    assert!(temporary_files(&config).is_empty());
}

#[test]
fn save_requests_reject_unknown_fields_and_forged_shapes() {
    let config = Config::new();
    let mut value = serde_json::to_value(sample(&config)).unwrap();
    value["favorites"][0]["kind"] = serde_json::json!("parent");
    assert!(serde_json::from_value::<SettingsDocument>(value).is_err());
    let forged = serde_json::json!({ "version": 1, "favorites": [], "shortcuts": {}, "session": null, "operations": [] });
    assert!(serde_json::from_value::<SettingsDocument>(forged).is_err());
}

#[test]
fn directory_probes_classify_without_following_display_labels() {
    use crate::DirectoryStatus::*;
    let config = Config::new();
    let file = config.dir().join("file.txt");
    fs::write(&file, b"x").unwrap();
    let paths = [
        native(config.dir()),
        native(&config.dir().join("missing")),
        native(&file),
        NativePath("u:zz".into()),
        native(Path::new("relative")),
    ];
    assert_eq!(
        crate::probe_directories(&paths).unwrap(),
        [Available, Missing, NotDirectory, Invalid, Invalid]
    );
    let many = vec![native(config.dir()); crate::MAX_PROBE_PATHS + 1];
    assert_eq!(
        crate::probe_directories(&many).unwrap_err().code,
        ErrorCode::InvalidOperation
    );
}

#[cfg(unix)]
#[test]
fn unreadable_directories_probe_as_permission_denied() {
    use std::os::unix::fs::PermissionsExt;
    let config = Config::new();
    let locked = config.dir().join("locked");
    fs::create_dir(&locked).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let status = probe_status(&native(&locked));
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    if fs::read_dir(&locked).is_ok() && status == crate::DirectoryStatus::Available {
        return; // Privileged test runner.
    }
    assert_eq!(status, crate::DirectoryStatus::PermissionDenied);
}

#[test]
fn listings_expose_a_display_name_for_tabs() {
    let config = Config::new();
    let child = config.dir().join("Ünïcode folder");
    fs::create_dir(&child).unwrap();
    let listing = crate::list_directory(crate::ListRequest {
        target: crate::DirectoryTarget::Path(native(&child)),
        sort: SortKey::Name,
        direction: SortDirection::Ascending,
    })
    .unwrap();
    assert_eq!(listing.name, "Ünïcode folder");
    let mut root = child.clone();
    while let Some(parent) = root.parent() {
        root = parent.to_path_buf();
    }
    let root_listing = crate::list_directory(crate::ListRequest {
        target: crate::DirectoryTarget::Path(native(&root)),
        sort: SortKey::Name,
        direction: SortDirection::Ascending,
    })
    .unwrap();
    assert_eq!(
        root_listing.name, root_listing.label,
        "a root uses its full display label"
    );
}
