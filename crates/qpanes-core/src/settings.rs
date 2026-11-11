//! Versioned local preferences: favorites, shortcut overrides and tab session.
//!
//! Paths are opaque native identifiers. Locations, names and labels are
//! display-only text and are never converted back into filesystem paths.
//! Loading is lenient (invalid content is preserved and reported); saving is
//! strict, bounded and replaces the file atomically.

use crate::{ErrorCode, FsError, NativePath, SortDirection, SortKey};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{self, Read, Write},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

pub const SETTINGS_VERSION: u32 = 1;
pub const SETTINGS_FILE: &str = "settings.json";
pub const INVALID_SETTINGS_FILE: &str = "settings.invalid.json";
pub const MAX_SETTINGS_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_FAVORITES: usize = 256;
pub const MAX_LABEL_CHARS: usize = 200;
pub const MAX_LOCATION_CHARS: usize = 65_536;
/// `w:` plus four hexadecimal digits for each of 32,767 UTF-16 units.
pub const MAX_PATH_ID_CHARS: usize = 131_070;
pub const MAX_ID_CHARS: usize = 64;
pub const MAX_TABS: usize = 32;
pub const MAX_SHORTCUTS: usize = 64;
pub const MAX_SHORTCUT_CHARS: usize = 64;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsDocument {
    pub version: u32,
    pub favorites: Vec<Favorite>,
    /// Only overrides of the renderer's platform defaults.
    pub shortcuts: BTreeMap<String, String>,
    pub session: Option<SessionState>,
}

impl Default for SettingsDocument {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            favorites: Vec::new(),
            shortcuts: BTreeMap::new(),
            session: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Favorite {
    pub id: String,
    pub label: String,
    pub path: NativePath,
    /// Lossy display location captured when the favorite was added.
    pub location: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    Left,
    Right,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionState {
    pub active_side: Side,
    pub left: Option<PanelSession>,
    pub right: Option<PanelSession>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PanelSession {
    pub active_tab: usize,
    pub tabs: Vec<TabState>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TabState {
    /// `None` opens the native home directory.
    pub path: Option<NativePath>,
    pub location: String,
    pub name: String,
    pub sort: SortKey,
    pub direction: SortDirection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingsStatus {
    /// A valid file was read without changes.
    Loaded,
    /// No file exists yet; defaults are used and saving is enabled.
    Missing,
    /// Invalid content was preserved as `settings.invalid.json`; valid parts or
    /// defaults are used and saving is enabled.
    Recovered,
    /// The file could not be read or preserved. Defaults are used and the
    /// renderer must not save, so existing data is never overwritten.
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsLoad {
    pub document: SettingsDocument,
    pub status: SettingsStatus,
    pub warnings: Vec<String>,
}

/// Call from a blocking worker.
pub fn load_settings(dir: &Path) -> SettingsLoad {
    let file = dir.join(SETTINGS_FILE);
    let bytes = match read_bounded(&file) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return result(SettingsDocument::default(), SettingsStatus::Missing, vec![]),
        Err(ReadError::TooLarge) => {
            // The whole file was not read, so preserve it by renaming it.
            let mut warnings =
                vec!["Settings were reset because settings.json is larger than 2 MiB.".to_owned()];
            return match fs::rename(&file, dir.join(INVALID_SETTINGS_FILE)) {
                Ok(()) => {
                    warnings.push(preserved());
                    result(
                        SettingsDocument::default(),
                        SettingsStatus::Recovered,
                        warnings,
                    )
                }
                Err(error) => unavailable(warnings, &error),
            };
        }
        Err(ReadError::Io(error)) => {
            return result(
                SettingsDocument::default(),
                SettingsStatus::Unavailable,
                vec![format!(
                    "Settings could not be read ({error}). Changes will not be saved during this session."
                )],
            );
        }
    };
    let mut warnings = Vec::new();
    let document = parse_lenient(&bytes, &mut warnings).unwrap_or_else(|reason| {
        warnings.push(format!("Settings were reset because {reason}."));
        SettingsDocument::default()
    });
    if warnings.is_empty() {
        return result(document, SettingsStatus::Loaded, warnings);
    }
    // Preserve the original bytes before a later save can replace them.
    match write_atomically(dir, INVALID_SETTINGS_FILE, &bytes) {
        Ok(()) => {
            warnings.push(preserved());
            result(document, SettingsStatus::Recovered, warnings)
        }
        Err(error) => unavailable(warnings, &error),
    }
}

/// Validate strictly and replace the settings file atomically.
/// Call from a blocking worker.
pub fn save_settings(dir: &Path, document: &SettingsDocument) -> Result<(), FsError> {
    validate_settings(document)?;
    let mut bytes = serde_json::to_vec_pretty(document)
        .map_err(|error| invalid(format!("Settings could not be encoded: {error}")))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err(invalid("Settings exceed the 2 MiB limit.".to_owned()));
    }
    write_atomically(dir, SETTINGS_FILE, &bytes).map_err(FsError::from_io)
}

/// Strict validation used for every save request.
pub fn validate_settings(document: &SettingsDocument) -> Result<(), FsError> {
    if document.version != SETTINGS_VERSION {
        return Err(invalid(format!(
            "Unsupported settings version {}.",
            document.version
        )));
    }
    if document.favorites.len() > MAX_FAVORITES {
        return Err(invalid(format!(
            "At most {MAX_FAVORITES} favorites are supported."
        )));
    }
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    for favorite in &document.favorites {
        validate_favorite(favorite).map_err(invalid)?;
        if !ids.insert(favorite.id.as_str()) {
            return Err(invalid("Favorite identifiers must be unique.".to_owned()));
        }
        if !paths.insert(favorite.path.as_str()) {
            return Err(invalid(
                "A directory can appear only once in Favorites.".to_owned(),
            ));
        }
    }
    if document.shortcuts.len() > MAX_SHORTCUTS {
        return Err(invalid(format!(
            "At most {MAX_SHORTCUTS} shortcut overrides are supported."
        )));
    }
    for (action, combo) in &document.shortcuts {
        validate_shortcut(action, combo).map_err(invalid)?;
    }
    if let Some(session) = &document.session {
        for panel in [&session.left, &session.right].into_iter().flatten() {
            validate_panel(panel).map_err(invalid)?;
        }
    }
    Ok(())
}

fn result(
    document: SettingsDocument,
    status: SettingsStatus,
    warnings: Vec<String>,
) -> SettingsLoad {
    SettingsLoad {
        document,
        status,
        warnings,
    }
}

fn preserved() -> String {
    "The previous file was preserved as settings.invalid.json.".to_owned()
}

fn unavailable(mut warnings: Vec<String>, error: &io::Error) -> SettingsLoad {
    warnings.push(format!(
        "The invalid settings file could not be preserved ({error}). Changes will not be saved during this session."
    ));
    result(
        SettingsDocument::default(),
        SettingsStatus::Unavailable,
        warnings,
    )
}

fn invalid(message: String) -> FsError {
    FsError {
        code: ErrorCode::InvalidSettings,
        message,
        recovery: None,
    }
}

enum ReadError {
    TooLarge,
    Io(io::Error),
}

fn read_bounded(file: &Path) -> Result<Option<Vec<u8>>, ReadError> {
    let handle = match fs::File::open(file) {
        Ok(handle) => handle,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ReadError::Io(error)),
    };
    let mut bytes = Vec::new();
    handle
        .take(MAX_SETTINGS_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(ReadError::Io)?;
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err(ReadError::TooLarge);
    }
    Ok(Some(bytes))
}

/// Write through an exclusively created sibling and rename it into place.
/// Only the temporary file this call created is ever removed.
fn write_atomically(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fs::create_dir_all(dir)?;
    // Write through a symlinked file (e.g. managed dotfiles) so the link keeps
    // pointing at the updated target instead of being replaced by a new file.
    // The native target path is used as-is, never a lossy rendering of it.
    let link = dir.join(name);
    let destination = match fs::symlink_metadata(&link) {
        Ok(metadata) if metadata.file_type().is_symlink() => fs::canonicalize(&link)
            .ok()
            .filter(|target| target.parent().is_some())
            .unwrap_or(link),
        _ => link,
    };
    let parent = destination.parent().unwrap_or(dir);
    let mut attempt = 0;
    let (temporary, mut handle) = loop {
        let candidate = parent.join(format!(
            ".{name}.{}.{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(handle) => break (candidate, handle),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists && attempt < 16 => {
                attempt += 1
            }
            Err(error) => return Err(error),
        }
    };
    let written = handle
        .write_all(bytes)
        .and_then(|()| handle.sync_all())
        .and_then(|()| {
            drop(handle);
            fs::rename(&temporary, &destination)
        });
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    #[cfg(unix)]
    if let Ok(directory) = fs::File::open(parent) {
        // Best effort: persist the rename itself.
        let _ = directory.sync_all();
    }
    Ok(())
}

fn parse_lenient(bytes: &[u8], warnings: &mut Vec<String>) -> Result<SettingsDocument, String> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("settings.json is not valid JSON ({error})"))?;
    let Value::Object(mut root) = value else {
        return Err("settings.json does not contain a settings object".to_owned());
    };
    match root.remove("version").as_ref().and_then(Value::as_u64) {
        Some(version) if version == u64::from(SETTINGS_VERSION) => {}
        Some(version) => return Err(format!("settings.json uses unsupported version {version}")),
        None => return Err("settings.json has no supported version".to_owned()),
    }
    let favorites = lenient_favorites(root.remove("favorites"), warnings);
    let shortcuts = lenient_shortcuts(root.remove("shortcuts"), warnings);
    let session = lenient_session(root.remove("session"), warnings);
    for key in root.keys().take(8) {
        warnings.push(format!("Unknown setting “{}” was ignored.", truncate(key)));
    }
    Ok(SettingsDocument {
        version: SETTINGS_VERSION,
        favorites,
        shortcuts,
        session,
    })
}

fn lenient_favorites(value: Option<Value>, warnings: &mut Vec<String>) -> Vec<Favorite> {
    let items = match value {
        None | Some(Value::Null) => return Vec::new(),
        Some(Value::Array(items)) => items,
        Some(_) => {
            warnings.push("Favorites were ignored because they are not a list.".to_owned());
            return Vec::new();
        }
    };
    let mut favorites: Vec<Favorite> = Vec::new();
    for (index, item) in items.into_iter().enumerate() {
        if favorites.len() == MAX_FAVORITES {
            warnings.push(format!(
                "Only the first {MAX_FAVORITES} favorites were kept."
            ));
            break;
        }
        let favorite = serde_json::from_value::<Favorite>(item)
            .map_err(|error| error.to_string())
            .and_then(|favorite| validate_favorite(&favorite).map(|()| favorite));
        match favorite {
            Ok(favorite)
                if favorites
                    .iter()
                    .any(|kept| kept.id == favorite.id || kept.path == favorite.path) =>
            {
                warnings.push(format!(
                    "Favorite {} was ignored because it is a duplicate.",
                    index + 1
                ));
            }
            Ok(favorite) => favorites.push(favorite),
            Err(reason) => warnings.push(format!(
                "Favorite {} was ignored: {}",
                index + 1,
                truncate(&reason)
            )),
        }
    }
    favorites
}

fn lenient_shortcuts(value: Option<Value>, warnings: &mut Vec<String>) -> BTreeMap<String, String> {
    let entries = match value {
        None | Some(Value::Null) => return BTreeMap::new(),
        Some(Value::Object(entries)) => entries,
        Some(_) => {
            warnings
                .push("Custom shortcuts were ignored because they are not a mapping.".to_owned());
            return BTreeMap::new();
        }
    };
    let mut shortcuts = BTreeMap::new();
    for (action, combo) in entries {
        if shortcuts.len() == MAX_SHORTCUTS {
            warnings.push(format!("Only {MAX_SHORTCUTS} custom shortcuts were kept."));
            break;
        }
        match combo {
            Value::String(combo) if validate_shortcut(&action, &combo).is_ok() => {
                shortcuts.insert(action, combo);
            }
            _ => warnings.push(format!(
                "Custom shortcut for “{}” was ignored.",
                truncate(&action)
            )),
        }
    }
    shortcuts
}

fn lenient_session(value: Option<Value>, warnings: &mut Vec<String>) -> Option<SessionState> {
    let mut root = match value? {
        Value::Null => return None,
        Value::Object(root) => root,
        _ => {
            warnings.push("Saved tabs were ignored because the session is invalid.".to_owned());
            return None;
        }
    };
    let active_side = match root
        .remove("activeSide")
        .map(serde_json::from_value::<Side>)
    {
        Some(Ok(side)) => side,
        _ => {
            warnings.push("The active panel could not be restored.".to_owned());
            Side::Left
        }
    };
    let mut panel = |key: &str, name: &str| lenient_panel(root.remove(key), name, warnings);
    let left = panel("left", "left");
    let right = panel("right", "right");
    Some(SessionState {
        active_side,
        left,
        right,
    })
}

fn lenient_panel(
    value: Option<Value>,
    side: &str,
    warnings: &mut Vec<String>,
) -> Option<PanelSession> {
    let mut panel: Map<String, Value> = match value? {
        Value::Null => return None,
        Value::Object(panel) => panel,
        _ => {
            warnings.push(format!("Saved {side} tabs were ignored."));
            return None;
        }
    };
    let Some(Value::Array(items)) = panel.remove("tabs") else {
        warnings.push(format!("Saved {side} tabs were ignored."));
        return None;
    };
    // The saved index refers to the saved list; follow that tab if it survives.
    let requested = panel.remove("activeTab").as_ref().and_then(Value::as_u64);
    let mut active_tab = None;
    let mut tabs = Vec::new();
    for (index, item) in items.into_iter().enumerate() {
        if tabs.len() == MAX_TABS {
            warnings.push(format!(
                "Only the first {MAX_TABS} {side} tabs were restored."
            ));
            break;
        }
        match serde_json::from_value::<TabState>(item)
            .map_err(|error| error.to_string())
            .and_then(|tab| validate_tab(&tab).map(|()| tab))
        {
            Ok(tab) => {
                if requested == Some(index as u64) {
                    active_tab = Some(tabs.len());
                }
                tabs.push(tab);
            }
            Err(reason) => warnings.push(format!(
                "Saved {side} tab {} was ignored: {}",
                index + 1,
                truncate(&reason)
            )),
        }
    }
    if tabs.is_empty() {
        return None;
    }
    let active_tab = active_tab.unwrap_or_else(|| {
        warnings.push(format!("The active {side} tab could not be restored."));
        0
    });
    Some(PanelSession { active_tab, tabs })
}

fn validate_panel(panel: &PanelSession) -> Result<(), String> {
    if panel.tabs.is_empty() || panel.tabs.len() > MAX_TABS {
        return Err(format!("Each saved panel needs 1–{MAX_TABS} tabs."));
    }
    if panel.active_tab >= panel.tabs.len() {
        return Err("The saved active tab does not exist.".to_owned());
    }
    panel.tabs.iter().try_for_each(validate_tab)
}

fn validate_tab(tab: &TabState) -> Result<(), String> {
    if let Some(path) = &tab.path {
        validate_path(path)?;
    }
    validate_text(&tab.location, "Tab location", MAX_LOCATION_CHARS)?;
    validate_text(&tab.name, "Tab name", MAX_LOCATION_CHARS)
}

fn validate_favorite(favorite: &Favorite) -> Result<(), String> {
    let id = favorite.id.as_str();
    if id.is_empty()
        || id.chars().count() > MAX_ID_CHARS
        || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("The favorite identifier is invalid.".to_owned());
    }
    let label = favorite.label.as_str();
    if label.trim() != label || label.is_empty() || label.chars().count() > MAX_LABEL_CHARS {
        return Err(format!(
            "Favorite names need 1–{MAX_LABEL_CHARS} characters without surrounding spaces."
        ));
    }
    if label.chars().any(char::is_control) {
        return Err("Favorite names cannot contain control characters.".to_owned());
    }
    validate_path(&favorite.path)?;
    validate_text(&favorite.location, "Favorite location", MAX_LOCATION_CHARS)
}

fn validate_shortcut(action: &str, combo: &str) -> Result<(), String> {
    let valid = |text: &str| {
        !text.is_empty()
            && text.chars().count() <= MAX_SHORTCUT_CHARS
            && text.chars().all(|c| c.is_ascii_graphic())
    };
    if valid(action) && valid(combo) {
        Ok(())
    } else {
        Err("The shortcut entry is invalid.".to_owned())
    }
}

fn validate_text(text: &str, field: &str, limit: usize) -> Result<(), String> {
    if text.chars().count() > limit {
        return Err(format!("{field} is too long."));
    }
    Ok(())
}

/// The identifier must decode for this platform into an absolute path.
fn validate_path(path: &NativePath) -> Result<(), String> {
    if path.as_str().len() > MAX_PATH_ID_CHARS {
        return Err("The saved directory identifier is too long.".to_owned());
    }
    match path.to_path() {
        Ok(native) if native.is_absolute() => Ok(()),
        _ => Err("The saved directory identifier is not valid on this system.".to_owned()),
    }
}

fn truncate(text: &str) -> String {
    let mut short: String = text.chars().take(120).collect();
    if short.len() < text.len() {
        short.push('…');
    }
    short
}

#[cfg(test)]
mod tests;
