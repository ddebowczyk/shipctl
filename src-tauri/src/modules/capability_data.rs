use tauri::State;

use shipctl_core::workspace::manager::WorkspaceManager;

#[tauri::command]
pub fn get_global_capability_data(
    capability_id: &str,
    workspace: State<'_, WorkspaceManager>,
) -> Result<Option<serde_json::Value>, String> {
    workspace.load_global_capability_data(capability_id)
}

#[tauri::command]
pub fn replace_global_capability_data(
    capability_id: &str,
    value: serde_json::Value,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    workspace.replace_global_capability_data(capability_id, value)
}
