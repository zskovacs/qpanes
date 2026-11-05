use qpanes_core::{DirectoryListing, Entry, FsError, ListRequest, SortDirection, SortKey};

#[tauri::command]
async fn list_directory(request: ListRequest) -> Result<DirectoryListing, FsError> {
    tauri::async_runtime::spawn_blocking(move || qpanes_core::list_directory(request))
        .await
        .map_err(|_| FsError::unavailable())?
}

/// Reorder an existing listing without touching the filesystem.
#[tauri::command]
async fn sort_directory_entries(
    mut entries: Vec<Entry>,
    sort: SortKey,
    direction: SortDirection,
) -> Result<Vec<Entry>, FsError> {
    tauri::async_runtime::spawn_blocking(move || {
        qpanes_core::sort_entries(&mut entries, sort, direction);
        entries
    })
    .await
    .map_err(|_| FsError::unavailable())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_directory,
            sort_directory_entries
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn virtual_parent_is_not_a_filesystem_entry() {
        let parent = serde_json::json!({
            "path": "parent", "name": "[..]", "kind": "parent",
            "size": null, "modifiedMs": null, "metadataError": null
        });
        assert!(serde_json::from_value::<qpanes_core::Entry>(parent).is_err());
    }
}
