use super::config::{GroupEntry, RegisteredRepo, RepoInfo, WorkspaceConfig};
use super::loader;
use crate::state::paths::ShipctlPaths;
use crate::state::DurableWriteBarrier;
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

    /// Compatibility-only opaque legacy read for TypeScript configuration
    /// migration. This is not a native configuration API.
    pub fn read_global_configuration_value(
        &self,
        key: &str,
    ) -> Result<Option<serde_json::Value>, String> {
        loader::read_global_configuration_value(&self.store, key)
    }

    /// Temporary workspace bootstrap compatibility read. Delete once the
    /// workspace plugin imports existing documents into plugin-data.
    pub fn read_project_configuration_value(
        &self,
        repo_path: &str,
        key: &str,
    ) -> Result<Option<serde_json::Value>, String> {
        loader::read_project_configuration_value(repo_path, key)
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
