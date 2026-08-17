//! Private Tauri transport for the public Git semantic service.

use serde::Deserialize;
use tauri::State;

use shipctl_core::git::{
    ChangedFile, CreatedWorktree, DiffFileStat, GitActor, GitError, GitService, GitStatus,
    WorktreeEntry, GIT_INVALID_REQUEST,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateGitRequest<Input> {
    activation: GitActor,
    correlation_id: String,
    input: Input,
}

fn validate_request<Input>(request: &PrivateGitRequest<Input>) -> Result<(), GitError> {
    if request.correlation_id.trim().is_empty()
        || request.correlation_id.chars().any(char::is_control)
    {
        Err(GitError {
            code: GIT_INVALID_REQUEST.to_string(),
            message: "The Git correlation identity is invalid".to_string(),
            retryable: false,
        })
    } else {
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitProjectInput {
    project_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitBranchInput {
    project_id: String,
    branch_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitFileInput {
    project_id: String,
    relative_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitReadDiffInput {
    project_id: String,
    relative_path: String,
    staged: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitReadFileInput {
    project_id: String,
    relative_path: String,
    source: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCommitInput {
    project_id: String,
    message: String,
}

#[tauri::command]
pub fn git_is_repository(
    request: PrivateGitRequest<GitProjectInput>,
    service: State<'_, GitService>,
) -> Result<bool, GitError> {
    validate_request(&request)?;
    service.is_repository(&request.activation, &request.input.project_id)
}

#[tauri::command]
pub fn git_initialize_repository(
    request: PrivateGitRequest<GitProjectInput>,
    service: State<'_, GitService>,
) -> Result<(), GitError> {
    validate_request(&request)?;
    service.initialize_repository(&request.activation, &request.input.project_id)
}

#[tauri::command]
pub fn git_current_branch(
    request: PrivateGitRequest<GitProjectInput>,
    service: State<'_, GitService>,
) -> Result<String, GitError> {
    validate_request(&request)?;
    service.current_branch(&request.activation, &request.input.project_id)
}

#[tauri::command]
pub fn git_list_branches(
    request: PrivateGitRequest<GitProjectInput>,
    service: State<'_, GitService>,
) -> Result<Vec<String>, GitError> {
    validate_request(&request)?;
    service.list_branches(&request.activation, &request.input.project_id)
}

#[tauri::command]
pub fn git_push_branch(
    request: PrivateGitRequest<GitBranchInput>,
    service: State<'_, GitService>,
) -> Result<(), GitError> {
    validate_request(&request)?;
    service.push_branch(
        &request.activation,
        &request.input.project_id,
        &request.input.branch_name,
    )
}

#[tauri::command]
pub fn git_list_worktrees(
    request: PrivateGitRequest<GitProjectInput>,
    service: State<'_, GitService>,
) -> Result<Vec<WorktreeEntry>, GitError> {
    validate_request(&request)?;
    service.list_worktrees(&request.activation, &request.input.project_id)
}

#[tauri::command]
pub fn git_create_worktree(
    request: PrivateGitRequest<GitBranchInput>,
    service: State<'_, GitService>,
) -> Result<CreatedWorktree, GitError> {
    validate_request(&request)?;
    service.create_worktree(
        &request.activation,
        &request.input.project_id,
        &request.input.branch_name,
    )
}

#[tauri::command]
pub fn git_inspect_status(
    request: PrivateGitRequest<GitProjectInput>,
    service: State<'_, GitService>,
) -> Result<GitStatus, GitError> {
    validate_request(&request)?;
    service.inspect_status(&request.activation, &request.input.project_id)
}

#[tauri::command]
pub fn git_list_changed_files(
    request: PrivateGitRequest<GitProjectInput>,
    service: State<'_, GitService>,
) -> Result<Vec<ChangedFile>, GitError> {
    validate_request(&request)?;
    service.list_changed_files(&request.activation, &request.input.project_id)
}

#[tauri::command]
pub fn git_read_file_diff(
    request: PrivateGitRequest<GitReadDiffInput>,
    service: State<'_, GitService>,
) -> Result<String, GitError> {
    validate_request(&request)?;
    service.read_file_diff(
        &request.activation,
        &request.input.project_id,
        &request.input.relative_path,
        request.input.staged,
    )
}

#[tauri::command]
pub fn git_read_file(
    request: PrivateGitRequest<GitReadFileInput>,
    service: State<'_, GitService>,
) -> Result<String, GitError> {
    validate_request(&request)?;
    service.read_file(
        &request.activation,
        &request.input.project_id,
        &request.input.relative_path,
        &request.input.source,
    )
}

#[tauri::command]
pub fn git_list_files(
    request: PrivateGitRequest<GitProjectInput>,
    service: State<'_, GitService>,
) -> Result<Vec<String>, GitError> {
    validate_request(&request)?;
    service.list_files(&request.activation, &request.input.project_id)
}

#[tauri::command]
pub fn git_stage_file(
    request: PrivateGitRequest<GitFileInput>,
    service: State<'_, GitService>,
) -> Result<(), GitError> {
    validate_request(&request)?;
    service.stage_file(
        &request.activation,
        &request.input.project_id,
        &request.input.relative_path,
    )
}

#[tauri::command]
pub fn git_stage_all(
    request: PrivateGitRequest<GitProjectInput>,
    service: State<'_, GitService>,
) -> Result<(), GitError> {
    validate_request(&request)?;
    service.stage_all(&request.activation, &request.input.project_id)
}

#[tauri::command]
pub fn git_commit(
    request: PrivateGitRequest<GitCommitInput>,
    service: State<'_, GitService>,
) -> Result<(), GitError> {
    validate_request(&request)?;
    service.commit(
        &request.activation,
        &request.input.project_id,
        &request.input.message,
    )
}

#[tauri::command]
pub fn git_unstage_file(
    request: PrivateGitRequest<GitFileInput>,
    service: State<'_, GitService>,
) -> Result<(), GitError> {
    validate_request(&request)?;
    service.unstage_file(
        &request.activation,
        &request.input.project_id,
        &request.input.relative_path,
    )
}

#[tauri::command]
pub fn git_unstage_all(
    request: PrivateGitRequest<GitProjectInput>,
    service: State<'_, GitService>,
) -> Result<(), GitError> {
    validate_request(&request)?;
    service.unstage_all(&request.activation, &request.input.project_id)
}

#[tauri::command]
pub fn git_switch_branch(
    request: PrivateGitRequest<GitBranchInput>,
    service: State<'_, GitService>,
) -> Result<(), GitError> {
    validate_request(&request)?;
    service.switch_branch(
        &request.activation,
        &request.input.project_id,
        &request.input.branch_name,
    )
}

#[tauri::command]
pub fn git_create_branch(
    request: PrivateGitRequest<GitBranchInput>,
    service: State<'_, GitService>,
) -> Result<(), GitError> {
    validate_request(&request)?;
    service.create_branch(
        &request.activation,
        &request.input.project_id,
        &request.input.branch_name,
    )
}

#[tauri::command]
pub fn git_diff_stats(
    request: PrivateGitRequest<GitProjectInput>,
    service: State<'_, GitService>,
) -> Result<Vec<DiffFileStat>, GitError> {
    validate_request(&request)?;
    service.diff_stats(&request.activation, &request.input.project_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseGitActivationInput {}

#[tauri::command]
pub fn release_git_activation(
    request: PrivateGitRequest<ReleaseGitActivationInput>,
    service: State<'_, GitService>,
) -> Result<bool, GitError> {
    validate_request(&request)?;
    service.release_activation(&request.activation)
}
