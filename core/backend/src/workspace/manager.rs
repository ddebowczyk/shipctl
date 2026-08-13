use super::config::{
    CanvasAdapter, EditorSettings, GroupEntry, KeybindingSettings, ProjectSettings, RegisteredRepo,
    RepoInfo, SidebarSettings, TerminalSettings, WorkspaceConfig,
};
use super::loader;
use crate::state::paths::ShipctlPaths;
use shipctl_module_api::DurableWriteBarrier;
use std::sync::Arc;

#[derive(Clone)]
pub struct WorkspaceManager {
    store: Arc<loader::GlobalStore>,
}

impl WorkspaceManager {
    pub fn new(paths: ShipctlPaths) -> Self {
        Self::new_with_barrier(paths, DurableWriteBarrier::default())
    }

    pub fn new_with_barrier(paths: ShipctlPaths, durable_writes: DurableWriteBarrier) -> Self {
        Self {
            store: Arc::new(loader::GlobalStore::new_with_barrier(paths, durable_writes)),
        }
    }

    pub fn migrate(&self) -> Result<(), String> {
        loader::migrate_old_projects(&self.store)
    }

    pub fn backfill_global_config_defaults(&self) -> Result<(), String> {
        loader::backfill_global_config_defaults(&self.store)
    }

    pub fn load_canvas_adapter(&self) -> Result<CanvasAdapter, String> {
        Ok(loader::load_global_config(&self.store)?.ui.canvas)
    }

    pub fn list_repos(&self) -> Result<Vec<RepoInfo>, String> {
        loader::list_repos(&self.store)
    }

    pub fn register_repo(&self, repo_path: &str) -> Result<RegisteredRepo, String> {
        loader::register_repo(&self.store, repo_path)
    }

    pub fn unregister_repo(&self, repo_path: &str) -> Result<(), String> {
        loader::unregister_repo(&self.store, repo_path)
    }

    pub fn load_workspace(&self, repo_path: &str) -> Result<WorkspaceConfig, String> {
        loader::load_repo_workspace(repo_path)
    }

    pub fn save_workspace(&self, repo_path: &str, config: &WorkspaceConfig) -> Result<(), String> {
        loader::save_repo_workspace(repo_path, config)
    }

    pub fn load_editor_settings(&self) -> Result<EditorSettings, String> {
        loader::load_editor_settings(&self.store)
    }

    pub fn load_project_settings(&self) -> Result<ProjectSettings, String> {
        loader::load_project_settings(&self.store)
    }

    pub fn save_editor_settings(&self, settings: &EditorSettings) -> Result<(), String> {
        loader::save_editor_settings(&self.store, settings)
    }

    pub fn save_project_settings(&self, settings: &ProjectSettings) -> Result<(), String> {
        loader::save_project_settings(&self.store, settings)
    }

    pub fn load_keybinding_settings(&self) -> Result<KeybindingSettings, String> {
        loader::load_keybinding_settings(&self.store)
    }

    pub fn save_keybinding_settings(&self, settings: &KeybindingSettings) -> Result<(), String> {
        loader::save_keybinding_settings(&self.store, settings)
    }

    pub fn load_terminal_settings(&self) -> Result<TerminalSettings, String> {
        loader::load_terminal_settings(&self.store)
    }

    pub fn save_terminal_settings(&self, settings: &TerminalSettings) -> Result<(), String> {
        loader::save_terminal_settings(&self.store, settings)
    }

    pub fn load_sidebar_settings(&self) -> Result<SidebarSettings, String> {
        loader::load_sidebar_settings(&self.store)
    }

    pub fn load_global_capability_data(
        &self,
        capability_id: &str,
    ) -> Result<Option<serde_json::Value>, String> {
        loader::load_global_capability_data(&self.store, capability_id)
    }

    pub fn replace_global_capability_data(
        &self,
        capability_id: &str,
        value: serde_json::Value,
    ) -> Result<(), String> {
        loader::replace_global_capability_data(&self.store, capability_id, value)
    }

    pub fn list_groups(&self) -> Result<Vec<GroupEntry>, String> {
        loader::list_groups(&self.store)
    }

    pub fn create_group(&self, name: &str) -> Result<GroupEntry, String> {
        loader::create_group(&self.store, name)
    }

    pub fn rename_group(&self, group_id: &str, new_name: &str) -> Result<(), String> {
        loader::rename_group(&self.store, group_id, new_name)
    }

    pub fn delete_group(&self, group_id: &str) -> Result<(), String> {
        loader::delete_group(&self.store, group_id)
    }

    pub fn move_repo_to_group(
        &self,
        repo_path: &str,
        group_id: Option<&str>,
    ) -> Result<(), String> {
        loader::move_repo_to_group(&self.store, repo_path, group_id)
    }
}
