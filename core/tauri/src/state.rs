use serde_json::Value;
use tauri::{Emitter, State};

use shipctl_core::state::ui::{UiState, UiStateStore};
use shipctl_core::state::workspace_document::{
    WorkspaceDocumentRecord, WorkspaceDocumentSaveResult, WorkspaceDocumentStore,
};
use shipctl_core::state::workspace_layout::{
    WorkspaceLayoutRecord, WorkspaceLayoutSaveResult, WorkspaceLayoutStore,
    WORKSPACE_LAYOUT_CHANGED_EVENT,
};

#[tauri::command]
pub fn get_ui_state(store: State<'_, UiStateStore>) -> Result<UiState, String> {
    store.load()
}

#[tauri::command]
pub fn set_last_repo_path(
    path: Option<String>,
    store: State<'_, UiStateStore>,
) -> Result<UiState, String> {
    store.set_last_repo_path(path)
}

#[tauri::command]
pub fn save_appearance_state(
    theme_id: String,
    custom_theme: Option<Value>,
    store: State<'_, UiStateStore>,
) -> Result<UiState, String> {
    store.save_appearance(theme_id, custom_theme)
}

#[tauri::command]
pub fn load_workspace_layout(
    workspace_id: String,
    store: State<'_, WorkspaceLayoutStore>,
) -> Result<Option<WorkspaceLayoutRecord>, String> {
    store.load(&workspace_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_workspace_layout(
    app: tauri::AppHandle,
    workspace_id: String,
    expected_revision: u64,
    origin_id: String,
    snapshot: Value,
    store: State<'_, WorkspaceLayoutStore>,
) -> Result<WorkspaceLayoutSaveResult, String> {
    let result = store
        .save(workspace_id, expected_revision, origin_id, snapshot)
        .map_err(|error| error.to_string())?;

    if let WorkspaceLayoutSaveResult::Saved { record } = &result {
        if let Err(error) = app.emit(WORKSPACE_LAYOUT_CHANGED_EVENT, record) {
            // The record is already durable. Returning an error here would make
            // a renderer retry a write that did succeed.
            log::error!(
                target: "shipctl::canvas_layout",
                "CANVAS_LAYOUT_EVENT_EMIT_FAILED: {error}"
            );
        }
    }

    Ok(result)
}

#[tauri::command]
pub fn load_workspace_document(
    workspace_id: String,
    store: State<'_, WorkspaceDocumentStore>,
) -> Result<Option<WorkspaceDocumentRecord>, String> {
    store.load(&workspace_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_workspace_document(
    workspace_id: String,
    expected_revision: u64,
    record: WorkspaceDocumentRecord,
    store: State<'_, WorkspaceDocumentStore>,
) -> Result<WorkspaceDocumentSaveResult, String> {
    store
        .save(workspace_id, expected_revision, record)
        .map_err(|error| error.to_string())
}
