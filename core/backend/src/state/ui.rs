use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use shipctl_module_api::DurableWriteBarrier;
use uuid::Uuid;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiState {
    pub last_repo_path: Option<String>,
    pub theme_id: Option<String>,
    pub custom_theme: Option<serde_json::Value>,
}

pub struct UiStateStore {
    path: PathBuf,
    lock: Mutex<()>,
    durable_writes: DurableWriteBarrier,
}

impl UiStateStore {
    pub fn new(path: PathBuf) -> Self {
        Self::new_with_barrier(path, DurableWriteBarrier::default())
    }

    pub fn new_with_barrier(path: PathBuf, durable_writes: DurableWriteBarrier) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
            durable_writes,
        }
    }

    pub fn load(&self) -> Result<UiState, String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "UI state lock is poisoned".to_string())?;
        read_at(&self.path)
    }

    pub fn set_last_repo_path(&self, path: Option<String>) -> Result<UiState, String> {
        self.mutate(|state| state.last_repo_path = path)
    }

    pub fn save_appearance(
        &self,
        theme_id: String,
        custom_theme: Option<serde_json::Value>,
    ) -> Result<UiState, String> {
        self.mutate(|state| {
            state.theme_id = Some(theme_id);
            state.custom_theme = custom_theme;
        })
    }

    fn mutate(&self, mutation: impl FnOnce(&mut UiState)) -> Result<UiState, String> {
        let _durable_update = self.durable_writes.enter_update()?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "UI state lock is poisoned".to_string())?;
        let mut state = read_at(&self.path)?;
        mutation(&mut state);
        write_at(&self.path, &state)?;
        Ok(state)
    }
}

#[tauri::command]
pub fn get_ui_state(store: tauri::State<'_, UiStateStore>) -> Result<UiState, String> {
    store.load()
}

#[tauri::command]
pub fn set_last_repo_path(
    path: Option<String>,
    store: tauri::State<'_, UiStateStore>,
) -> Result<UiState, String> {
    store.set_last_repo_path(path)
}

#[tauri::command]
pub fn save_appearance_state(
    theme_id: String,
    custom_theme: Option<serde_json::Value>,
    store: tauri::State<'_, UiStateStore>,
) -> Result<UiState, String> {
    store.save_appearance(theme_id, custom_theme)
}

fn read_at(path: &Path) -> Result<UiState, String> {
    if !path.exists() {
        return Ok(UiState::default());
    }
    let source = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read UI state {}: {error}", path.display()))?;
    serde_json::from_str(&source)
        .map_err(|error| format!("Failed to parse UI state {}: {error}", path.display()))
}

fn write_at(path: &Path, state: &UiState) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "UI state path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create UI state directory: {error}"))?;
    let temporary = parent.join(format!(".ui-state-{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("Failed to serialize UI state: {error}"))?;
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Failed to stage UI state {}: {error}", temporary.display()))?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("Failed to commit UI state {}: {error}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn independent_stores_do_not_observe_each_other() {
        let root = std::env::temp_dir().join(format!("shipctl-ui-state-{}", Uuid::new_v4()));
        let first = UiStateStore::new(root.join("first/ui-state.json"));
        let second = UiStateStore::new(root.join("second/ui-state.json"));

        first.set_last_repo_path(Some("/alpha".into())).unwrap();
        second
            .save_appearance("light".into(), Some(serde_json::json!({"id": "custom"})))
            .unwrap();

        assert_eq!(
            first.load().unwrap().last_repo_path.as_deref(),
            Some("/alpha")
        );
        assert_eq!(first.load().unwrap().theme_id, None);
        assert_eq!(second.load().unwrap().last_repo_path, None);
        assert_eq!(second.load().unwrap().theme_id.as_deref(), Some("light"));
    }
}
