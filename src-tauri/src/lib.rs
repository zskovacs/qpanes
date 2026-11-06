use qpanes_core::{
    CreateDirectoryRequest, DirectoryListing, Entry, FsError, ListRequest, OperationResult,
    RenameRequest, SortDirection, SortKey, TransferRequest, TrashRequest,
};

#[tauri::command]
async fn create_directory(request: CreateDirectoryRequest) -> Result<OperationResult, FsError> {
    tauri::async_runtime::spawn_blocking(move || qpanes_core::create_directory(request))
        .await
        .map_err(|_| FsError::operation_unavailable())?
}

#[tauri::command]
async fn rename_entry(request: RenameRequest) -> Result<OperationResult, FsError> {
    tauri::async_runtime::spawn_blocking(move || qpanes_core::rename_entry(request))
        .await
        .map_err(|_| FsError::operation_unavailable())?
}

#[tauri::command]
async fn copy_entry(request: TransferRequest) -> Result<OperationResult, FsError> {
    tauri::async_runtime::spawn_blocking(move || qpanes_core::copy_entry(request))
        .await
        .map_err(|_| FsError::operation_unavailable())?
}

#[tauri::command]
async fn move_entry(request: TransferRequest) -> Result<OperationResult, FsError> {
    tauri::async_runtime::spawn_blocking(move || qpanes_core::move_entry(request))
        .await
        .map_err(|_| FsError::operation_unavailable())?
}

#[tauri::command]
async fn trash_entry(request: TrashRequest) -> Result<OperationResult, FsError> {
    tauri::async_runtime::spawn_blocking(move || qpanes_core::trash_entry(request))
        .await
        .map_err(|_| FsError::operation_unavailable())?
}

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
            sort_directory_entries,
            create_directory,
            rename_entry,
            copy_entry,
            move_entry,
            trash_entry
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

    #[test]
    fn virtual_parent_cannot_be_deserialized_as_any_mutation_source() {
        let parent = serde_json::json!({ "kind": "parent", "key": "parent" });
        assert!(
            serde_json::from_value::<qpanes_core::RenameRequest>(serde_json::json!({
                "source": parent, "name": "new"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<qpanes_core::TransferRequest>(serde_json::json!({
                "source": parent, "destination": "u:2f746d70"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<qpanes_core::TrashRequest>(serde_json::json!({
                "source": parent
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<qpanes_core::CreateDirectoryRequest>(serde_json::json!({
                "parent": parent, "name": "new"
            }))
            .is_err()
        );
    }

    #[test]
    fn cross_device_error_has_the_documented_ipc_code() {
        assert_eq!(
            serde_json::to_value(qpanes_core::ErrorCode::CrossDeviceNotSupported).unwrap(),
            "cross_device_not_supported"
        );
    }

    #[test]
    fn an_unknown_mutation_outcome_never_instructs_an_unreviewed_retry() {
        let error = qpanes_core::FsError::operation_unavailable();
        assert_eq!(error.code, qpanes_core::ErrorCode::Unavailable);
        assert!(
            error
                .message
                .contains("Inspect the source, destination and Trash")
        );
        assert!(!error.message.contains("Try again"));
    }
}
