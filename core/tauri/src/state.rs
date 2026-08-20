use serde_json::Value;
use tauri::State;

use shipctl_core::state::ui::{UiState, UiStateStore};

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
