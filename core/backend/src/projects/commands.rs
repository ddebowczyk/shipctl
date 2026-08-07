use tauri::State;

use crate::projects::watcher::GitWatcher;
use crate::workspace::config::{GroupEntry, RegisteredRepo, RepoInfo, WorkspaceConfig};
use crate::workspace::manager::WorkspaceManager;

#[tauri::command]
pub fn list_repos(workspace: State<'_, WorkspaceManager>) -> Result<Vec<RepoInfo>, String> {
    workspace.list_repos()
}

#[tauri::command]
pub fn register_repo(
    repo_path: &str,
    workspace: State<'_, WorkspaceManager>,
) -> Result<RegisteredRepo, String> {
    workspace.register_repo(repo_path)
}

#[tauri::command]
pub fn unregister_repo(
    repo_path: &str,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    workspace.unregister_repo(repo_path)
}

#[tauri::command]
pub fn load_workspace(
    repo_path: &str,
    workspace: State<'_, WorkspaceManager>,
) -> Result<WorkspaceConfig, String> {
    workspace.load_workspace(repo_path)
}

#[tauri::command]
pub fn save_workspace(
    repo_path: &str,
    config: WorkspaceConfig,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    workspace.save_workspace(repo_path, &config)
}

// ── Groups ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_groups(workspace: State<'_, WorkspaceManager>) -> Result<Vec<GroupEntry>, String> {
    workspace.list_groups()
}

#[tauri::command]
pub fn create_group(
    name: &str,
    workspace: State<'_, WorkspaceManager>,
) -> Result<GroupEntry, String> {
    workspace.create_group(name)
}

#[tauri::command]
pub fn rename_group(
    group_id: &str,
    new_name: &str,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    workspace.rename_group(group_id, new_name)
}

#[tauri::command]
pub fn delete_group(group_id: &str, workspace: State<'_, WorkspaceManager>) -> Result<(), String> {
    workspace.delete_group(group_id)
}

#[tauri::command]
pub fn move_repo_to_group(
    repo_path: &str,
    group_id: Option<&str>,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    workspace.move_repo_to_group(repo_path, group_id)
}

// ── Filesystem watcher ─────────────────────────────────────────────

#[tauri::command]
pub fn watch_repo(path: &str, watcher: State<'_, GitWatcher>) -> Result<(), String> {
    watcher.watch(path)
}

#[tauri::command]
pub fn unwatch_repo(path: &str, watcher: State<'_, GitWatcher>) -> Result<(), String> {
    watcher.unwatch(path)
}
