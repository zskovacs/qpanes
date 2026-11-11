use qpanes_core::operation_manager::{
    OperationJob, OperationManager, OperationSnapshot, ShutdownAttempt, SubmitRequest,
};
use qpanes_core::settings::{SettingsDocument, SettingsLoad, SettingsStatus};
use qpanes_core::{DirectoryListing, Entry, FsError, ListRequest, SortDirection, SortKey};
use serde::Deserialize;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager, State};

/// The app configuration directory and one lock serializing settings I/O.
#[derive(Clone)]
struct SettingsStore {
    dir: Option<PathBuf>,
    lock: Arc<Mutex<()>>,
}

#[tauri::command]
async fn load_settings(store: State<'_, SettingsStore>) -> Result<SettingsLoad, FsError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = store
            .lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match &store.dir {
            Some(dir) => qpanes_core::settings::load_settings(dir),
            None => SettingsLoad {
                document: SettingsDocument::default(),
                status: SettingsStatus::Unavailable,
                warnings: vec![
                    "The settings folder is unavailable. Changes will not be saved.".into(),
                ],
            },
        }
    })
    .await
    .map_err(|_| FsError::unavailable())
}

#[tauri::command]
async fn save_settings(
    store: State<'_, SettingsStore>,
    document: SettingsDocument,
) -> Result<(), FsError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = store
            .lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = store.dir.as_deref().ok_or_else(FsError::unavailable)?;
        qpanes_core::settings::save_settings(dir, &document)
    })
    .await
    .map_err(|_| FsError::unavailable())?
}

#[tauri::command]
async fn probe_directories(
    paths: Vec<qpanes_core::NativePath>,
) -> Result<Vec<qpanes_core::DirectoryStatus>, FsError> {
    tauri::async_runtime::spawn_blocking(move || qpanes_core::probe_directories(&paths))
        .await
        .map_err(|_| FsError::unavailable())?
}

#[tauri::command]
fn submit_operation(
    manager: State<'_, OperationManager>,
    request: SubmitRequest,
) -> Result<OperationJob, FsError> {
    manager.submit(request)
}
#[tauri::command]
fn list_operations(manager: State<'_, OperationManager>) -> OperationSnapshot {
    manager.snapshot()
}
#[tauri::command]
fn get_operation(
    manager: State<'_, OperationManager>,
    id: String,
) -> Result<OperationJob, FsError> {
    manager.get(&id)
}
#[tauri::command]
fn cancel_operation(
    manager: State<'_, OperationManager>,
    id: String,
) -> Result<OperationJob, FsError> {
    manager.cancel(&id)
}
#[tauri::command]
fn retry_operation(
    manager: State<'_, OperationManager>,
    id: String,
    client_id: String,
    sequence: u32,
) -> Result<OperationJob, FsError> {
    manager.retry(&id, client_id, sequence)
}
#[tauri::command]
fn dismiss_operation(manager: State<'_, OperationManager>, id: String) -> Result<(), FsError> {
    manager.dismiss(&id)
}
#[tauri::command]
fn classify_operation_invalidation(
    paths: Vec<qpanes_core::NativePath>,
    directories: Vec<qpanes_core::NativePath>,
    subtrees: Vec<qpanes_core::NativePath>,
) -> Result<Vec<bool>, FsError> {
    qpanes_core::classify_operation_invalidation(&paths, &directories, &subtrees)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum ShutdownAction {
    KeepWorking,
    CancelAndClose,
    ForceExit,
}
#[tauri::command]
fn shutdown_operations(
    app: tauri::AppHandle,
    manager: State<'_, OperationManager>,
    action: ShutdownAction,
    attempt: Option<ShutdownAttempt>,
) -> Result<(), FsError> {
    match action {
        ShutdownAction::KeepWorking => manager.keep_working(attempt.as_ref())?,
        ShutdownAction::CancelAndClose => {
            if let Some(attempt) =
                manager.begin_shutdown(std::time::Duration::from_secs(3), attempt.as_ref())?
            {
                let manager = manager.inner().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if manager.wait_shutdown(&attempt) && manager.finish_shutdown(&attempt) {
                        app.exit(0);
                    }
                });
            }
        }
        ShutdownAction::ForceExit => {
            manager.authorize_force_exit(attempt.as_ref())?;
            app.exit(0);
        }
    }
    Ok(())
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
        .setup(|app| {
            let handle = app.handle().clone();
            let manager = OperationManager::new(move |revision| {
                // Events are low-frequency hints; list_operations is authoritative.
                let _ = handle.emit_to("main", "operations-changed", revision);
            })?;
            app.manage(manager);
            app.manage(SettingsStore {
                dir: app.path().app_config_dir().ok(),
                lock: Arc::new(Mutex::new(())),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && !window.state::<OperationManager>().request_close()
            {
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_directory,
            sort_directory_entries,
            submit_operation,
            list_operations,
            get_operation,
            cancel_operation,
            retry_operation,
            dismiss_operation,
            shutdown_operations,
            classify_operation_invalidation,
            load_settings,
            save_settings,
            probe_directories
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event
                && !app.state::<OperationManager>().request_close()
            {
                api.prevent_exit();
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn managed_submission_rejects_virtual_parent_and_forged_result() {
        let request = serde_json::json!({
            "clientId": "renderer", "sequence": 1,
            "intent": { "kind": "trash", "source": { "kind": "parent", "key": "parent" } }
        });
        assert!(serde_json::from_value::<super::SubmitRequest>(request).is_err());
        let forged = serde_json::json!({
            "clientId": "renderer", "sequence": 1,
            "intent": { "kind": "create", "parent": "u:2f746d70", "name": "fixture", "state": "completed" }
        });
        assert!(serde_json::from_value::<super::SubmitRequest>(forged).is_err());
    }

    #[test]
    fn managed_snapshot_wire_names_match_renderer_contract() {
        let manager = super::OperationManager::new(|_| {}).unwrap();
        let snapshot = serde_json::to_value(manager.snapshot()).unwrap();
        assert_eq!(snapshot["revision"], 0);
        assert_eq!(snapshot["invalidationRevision"], 0);
        assert_eq!(snapshot["shutdownState"], "idle");
        assert_eq!(snapshot["closeRequested"], false);
        assert_eq!(snapshot["accepting"], true);
        assert_eq!(snapshot["jobs"], serde_json::json!([]));
        let error = serde_json::to_value(qpanes_core::FsError::operation_unavailable()).unwrap();
        assert!(error["recovery"].is_null());
    }

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
    fn settings_and_probe_wire_names_match_renderer_contract() {
        let load = qpanes_core::settings::SettingsLoad {
            document: qpanes_core::settings::SettingsDocument::default(),
            status: qpanes_core::settings::SettingsStatus::Unavailable,
            warnings: vec![],
        };
        let value = serde_json::to_value(load).unwrap();
        assert_eq!(value["status"], "unavailable");
        assert_eq!(value["document"]["version"], 1);
        assert!(value["document"]["session"].is_null());
        assert_eq!(
            serde_json::to_value(qpanes_core::DirectoryStatus::PermissionDenied).unwrap(),
            "permissionDenied"
        );
        assert_eq!(
            serde_json::to_value(qpanes_core::ErrorCode::InvalidSettings).unwrap(),
            "invalidSettings"
        );
        let session = serde_json::json!({
            "version": 1, "favorites": [], "shortcuts": {},
            "session": { "activeSide": "left", "left": { "activeTab": 0, "tabs": [
                { "path": null, "location": "", "name": "", "sort": "name", "direction": "ascending" }
            ] }, "right": null }
        });
        assert!(serde_json::from_value::<super::SettingsDocument>(session).is_ok());
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
