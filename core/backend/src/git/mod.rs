//! Project-authorized Git repository operations.
//!
//! This provider owns scoped Git process and filesystem authority. It contains
//! no Git panel, workflow, or presentation policy and has no Tauri dependency.

#![forbid(unsafe_code)]

use std::collections::{BTreeSet, HashSet};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::workspace::manager::WorkspaceManager;

pub const GIT_TRANSPORT_FAILED: &str = "git.transport-failed";
pub const GIT_DENIED: &str = "git.denied";
pub const GIT_INVALID_PROJECT: &str = "git.invalid-project";
pub const GIT_INVALID_PATH: &str = "git.invalid-path";
pub const GIT_INVALID_REQUEST: &str = "git.invalid-request";
pub const GIT_NOT_REPOSITORY: &str = "git.not-repository";
pub const GIT_CONFLICT: &str = "git.conflict";
pub const GIT_ACTIVATION_DISPOSED: &str = "git.activation-disposed";

/// Host-owned authority for resolving an exact registered project root.
pub trait GitProjectCatalog: Send + Sync {
    fn registered_project_paths(&self) -> Result<Vec<String>, String>;
}

impl GitProjectCatalog for WorkspaceManager {
    fn registered_project_paths(&self) -> Result<Vec<String>, String> {
        self.list_repos()
            .map(|repos| repos.into_iter().map(|repo| repo.path).collect())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitActor {
    pub module_id: String,
    pub activation_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GitGrant {
    Read,
    Write,
}

#[derive(Clone, Debug)]
struct GitPolicy {
    module_id: &'static str,
    grants: &'static [GitGrant],
}

const READ_AND_WRITE: &[GitGrant] = &[GitGrant::Read, GitGrant::Write];
const DEFAULT_POLICIES: &[GitPolicy] = &[
    GitPolicy {
        module_id: "core",
        grants: READ_AND_WRITE,
    },
    GitPolicy {
        module_id: "shipctl.git",
        grants: READ_AND_WRITE,
    },
];

#[derive(Default)]
struct GitState {
    released_activations: HashSet<String>,
}

struct GitServiceInner {
    projects: Arc<dyn GitProjectCatalog>,
    policies: Vec<GitPolicy>,
    state: Mutex<GitState>,
}

/// The permanent native Git provider.
///
/// Project identity is still the exact registered path during the built-in
/// migration. The provider never accepts an arbitrary directory or command.
#[derive(Clone)]
pub struct GitService {
    inner: Arc<GitServiceInner>,
}

impl GitService {
    pub fn workspace(workspace: WorkspaceManager) -> Self {
        Self::new(Arc::new(workspace))
    }

    pub fn new(projects: Arc<dyn GitProjectCatalog>) -> Self {
        Self::with_policies(projects, DEFAULT_POLICIES.to_vec())
    }

    fn with_policies(projects: Arc<dyn GitProjectCatalog>, policies: Vec<GitPolicy>) -> Self {
        Self {
            inner: Arc::new(GitServiceInner {
                projects,
                policies,
                state: Mutex::new(GitState::default()),
            }),
        }
    }

    pub fn is_repository(&self, actor: &GitActor, project_id: &str) -> Result<bool, GitError> {
        let path = self.project_argument(actor, GitGrant::Read, project_id)?;
        Ok(is_git_repo(&path))
    }

    pub fn initialize_repository(
        &self,
        actor: &GitActor,
        project_id: &str,
    ) -> Result<(), GitError> {
        let path = self.project_argument(actor, GitGrant::Write, project_id)?;
        init_repo(&path).map_err(git_operation_error)
    }

    pub fn current_branch(&self, actor: &GitActor, project_id: &str) -> Result<String, GitError> {
        let path = self.project_argument(actor, GitGrant::Read, project_id)?;
        current_branch(&path).map_err(git_operation_error)
    }

    pub fn list_branches(
        &self,
        actor: &GitActor,
        project_id: &str,
    ) -> Result<Vec<String>, GitError> {
        let path = self.project_argument(actor, GitGrant::Read, project_id)?;
        list_branches(&path).map_err(git_operation_error)
    }

    pub fn push_branch(
        &self,
        actor: &GitActor,
        project_id: &str,
        branch_name: &str,
    ) -> Result<(), GitError> {
        validate_branch_name(branch_name)?;
        let path = self.project_argument(actor, GitGrant::Write, project_id)?;
        push_branch(&path, branch_name).map_err(git_operation_error)
    }

    pub fn list_worktrees(
        &self,
        actor: &GitActor,
        project_id: &str,
    ) -> Result<Vec<WorktreeEntry>, GitError> {
        let path = self.project_argument(actor, GitGrant::Read, project_id)?;
        list_worktrees(&path).map_err(git_operation_error)
    }

    pub fn create_worktree(
        &self,
        actor: &GitActor,
        project_id: &str,
        branch_name: &str,
    ) -> Result<CreatedWorktree, GitError> {
        validate_branch_name(branch_name)?;
        let path = self.project_argument(actor, GitGrant::Write, project_id)?;
        create_worktree(&path, branch_name).map_err(git_operation_error)
    }

    pub fn inspect_status(
        &self,
        actor: &GitActor,
        project_id: &str,
    ) -> Result<GitStatus, GitError> {
        let path = self.project_argument(actor, GitGrant::Read, project_id)?;
        Ok(status(&path))
    }

    pub fn list_changed_files(
        &self,
        actor: &GitActor,
        project_id: &str,
    ) -> Result<Vec<ChangedFile>, GitError> {
        let path = self.project_argument(actor, GitGrant::Read, project_id)?;
        changed_files(&path).map_err(git_operation_error)
    }

    pub fn read_file_diff(
        &self,
        actor: &GitActor,
        project_id: &str,
        relative_path: &str,
        staged: bool,
    ) -> Result<String, GitError> {
        let path = self.project_argument(actor, GitGrant::Read, project_id)?;
        file_diff(&path, relative_path, staged).map_err(git_operation_error)
    }

    pub fn read_file(
        &self,
        actor: &GitActor,
        project_id: &str,
        relative_path: &str,
        source: &str,
    ) -> Result<String, GitError> {
        let path = self.project_argument(actor, GitGrant::Read, project_id)?;
        file_contents(&path, relative_path, source).map_err(git_operation_error)
    }

    pub fn list_files(&self, actor: &GitActor, project_id: &str) -> Result<Vec<String>, GitError> {
        let path = self.project_argument(actor, GitGrant::Read, project_id)?;
        list_files(&path).map_err(git_operation_error)
    }

    pub fn stage_file(
        &self,
        actor: &GitActor,
        project_id: &str,
        relative_path: &str,
    ) -> Result<(), GitError> {
        let path = self.project_argument(actor, GitGrant::Write, project_id)?;
        stage_file(&path, relative_path).map_err(git_operation_error)
    }

    pub fn stage_all(&self, actor: &GitActor, project_id: &str) -> Result<(), GitError> {
        let path = self.project_argument(actor, GitGrant::Write, project_id)?;
        stage_all(&path).map_err(git_operation_error)
    }

    pub fn commit(
        &self,
        actor: &GitActor,
        project_id: &str,
        message: &str,
    ) -> Result<(), GitError> {
        if message.trim().is_empty() {
            return Err(git_error(
                GIT_INVALID_REQUEST,
                "Commit message cannot be empty",
            ));
        }
        let path = self.project_argument(actor, GitGrant::Write, project_id)?;
        commit(&path, message).map_err(git_operation_error)
    }

    pub fn unstage_file(
        &self,
        actor: &GitActor,
        project_id: &str,
        relative_path: &str,
    ) -> Result<(), GitError> {
        let path = self.project_argument(actor, GitGrant::Write, project_id)?;
        unstage_file(&path, relative_path).map_err(git_operation_error)
    }

    pub fn unstage_all(&self, actor: &GitActor, project_id: &str) -> Result<(), GitError> {
        let path = self.project_argument(actor, GitGrant::Write, project_id)?;
        unstage_all(&path).map_err(git_operation_error)
    }

    pub fn switch_branch(
        &self,
        actor: &GitActor,
        project_id: &str,
        branch_name: &str,
    ) -> Result<(), GitError> {
        validate_branch_name(branch_name)?;
        let path = self.project_argument(actor, GitGrant::Write, project_id)?;
        switch_branch(&path, branch_name).map_err(git_operation_error)
    }

    pub fn create_branch(
        &self,
        actor: &GitActor,
        project_id: &str,
        branch_name: &str,
    ) -> Result<(), GitError> {
        validate_branch_name(branch_name)?;
        let path = self.project_argument(actor, GitGrant::Write, project_id)?;
        create_branch(&path, branch_name).map_err(git_operation_error)
    }

    pub fn diff_stats(
        &self,
        actor: &GitActor,
        project_id: &str,
    ) -> Result<Vec<DiffFileStat>, GitError> {
        let path = self.project_argument(actor, GitGrant::Read, project_id)?;
        diff_stats(&path).map_err(git_operation_error)
    }

    pub fn release_activation(&self, actor: &GitActor) -> Result<bool, GitError> {
        self.validate_actor(actor)?;
        let mut state =
            self.inner.state.lock().map_err(|_| {
                git_error(GIT_TRANSPORT_FAILED, "Git activation state is unavailable")
            })?;
        Ok(state
            .released_activations
            .insert(actor.activation_id.clone()))
    }

    fn project_argument(
        &self,
        actor: &GitActor,
        grant: GitGrant,
        project_id: &str,
    ) -> Result<String, GitError> {
        self.authorize(actor, grant)?;
        if project_id.trim().is_empty() {
            return Err(git_error(
                GIT_INVALID_PROJECT,
                "Project identity cannot be empty",
            ));
        }
        let registered = self
            .inner
            .projects
            .registered_project_paths()
            .map_err(|message| git_error(GIT_TRANSPORT_FAILED, message))?
            .into_iter()
            .find(|registered| registered == project_id)
            .ok_or_else(|| {
                git_error(
                    GIT_INVALID_PROJECT,
                    format!("Project is not registered: {project_id}"),
                )
            })?;
        let canonical = PathBuf::from(&registered).canonicalize().map_err(|error| {
            git_error(
                GIT_INVALID_PROJECT,
                format!("Could not resolve registered project {registered}: {error}"),
            )
        })?;
        root_argument(&canonical).map_err(|message| git_error(GIT_INVALID_PROJECT, message))
    }

    fn authorize(&self, actor: &GitActor, grant: GitGrant) -> Result<(), GitError> {
        self.validate_actor(actor)?;
        let state =
            self.inner.state.lock().map_err(|_| {
                git_error(GIT_TRANSPORT_FAILED, "Git activation state is unavailable")
            })?;
        if state.released_activations.contains(&actor.activation_id) {
            return Err(git_error(
                GIT_ACTIVATION_DISPOSED,
                "The module activation is no longer active",
            ));
        }
        let allowed =
            self.inner.policies.iter().any(|policy| {
                policy.module_id == actor.module_id && policy.grants.contains(&grant)
            });
        if allowed {
            Ok(())
        } else {
            Err(git_error(
                GIT_DENIED,
                format!(
                    "Module {} is not authorized for this Git operation",
                    actor.module_id
                ),
            ))
        }
    }

    fn validate_actor(&self, actor: &GitActor) -> Result<(), GitError> {
        if actor.module_id.trim().is_empty()
            || actor.activation_id.trim().is_empty()
            || actor.module_id.chars().any(char::is_control)
            || actor.activation_id.chars().any(char::is_control)
        {
            return Err(git_error(
                GIT_INVALID_REQUEST,
                "Git activation identity is invalid",
            ));
        }
        if self
            .inner
            .policies
            .iter()
            .any(|policy| policy.module_id == actor.module_id)
        {
            Ok(())
        } else {
            Err(git_error(
                GIT_DENIED,
                format!("Module {} has no Git capability grant", actor.module_id),
            ))
        }
    }
}

fn validate_branch_name(branch_name: &str) -> Result<(), GitError> {
    if branch_name.trim().is_empty() {
        Err(git_error(
            GIT_INVALID_REQUEST,
            "Branch name cannot be empty",
        ))
    } else {
        Ok(())
    }
}

fn git_operation_error(message: String) -> GitError {
    let normalized = message.to_lowercase();
    let code = if normalized.contains("not a git repository") {
        GIT_NOT_REPOSITORY
    } else if normalized.contains("path")
        && (normalized.contains("invalid")
            || normalized.contains("outside")
            || normalized.contains("relative")
            || normalized.contains("within the project"))
    {
        GIT_INVALID_PATH
    } else if normalized.contains("permission")
        || normalized.contains("denied")
        || normalized.contains("not permitted")
        || normalized.contains("not allowed")
    {
        GIT_DENIED
    } else if normalized.contains("conflict") || normalized.contains("lock") {
        GIT_CONFLICT
    } else {
        GIT_TRANSPORT_FAILED
    };
    git_error(code, message)
}

fn git_error(code: &str, message: impl Into<String>) -> GitError {
    GitError {
        code: code.to_string(),
        message: message.into(),
        retryable: false,
    }
}

fn normalized_relative_path(file_path: &str) -> Result<PathBuf, String> {
    if file_path.trim().is_empty() {
        return Err("File path is required".to_string());
    }

    let mut normalized = PathBuf::new();
    for component in Path::new(file_path).components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "File path must stay within the project: {file_path}"
                ));
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err("File path is required".to_string());
    }
    Ok(normalized)
}

fn authorized_file_argument(file_path: &str) -> Result<String, String> {
    normalized_relative_path(file_path).map(|path| path.to_string_lossy().to_string())
}

fn authorized_working_file(root: &Path, file_path: &str) -> Result<PathBuf, String> {
    let relative = normalized_relative_path(file_path)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Cannot resolve project root {}: {error}", root.display()))?;
    let candidate = canonical_root.join(relative);
    let canonical_file = candidate
        .canonicalize()
        .map_err(|error| format!("Cannot read {file_path}: {error}"))?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err(format!(
            "File path must stay within the project: {file_path}"
        ));
    }
    Ok(canonical_file)
}

fn root_argument(root: &Path) -> Result<String, String> {
    root.to_str()
        .map(ToString::to_string)
        .ok_or_else(|| format!("Project path is not valid UTF-8: {}", root.display()))
}

#[derive(serde::Serialize, Clone, Default)]
pub struct GitStatus {
    pub is_git_repo: bool,
    pub branch: String,
    pub dirty: bool,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub ahead: u32,
    pub behind: u32,
    /// If this is a worktree, the name of the parent repo (derived from its path)
    pub worktree_parent: Option<String>,
}

pub fn status(path: &str) -> GitStatus {
    let output = match Command::new("git")
        .args(["-C", path, "status", "--porcelain=v2", "--branch"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return GitStatus::default(),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut branch = String::new();
    let mut ahead: u32 = 0;
    let mut behind: u32 = 0;
    let mut staged: u32 = 0;
    let mut unstaged: u32 = 0;
    let mut untracked: u32 = 0;

    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            branch = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // Format: +N -M
            for token in rest.split_whitespace() {
                if let Some(n) = token.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = token.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            // Changed entry: XY columns at index 2..4
            let xy: Vec<u8> = line.as_bytes().get(2..4).unwrap_or(b"..").to_vec();
            if xy[0] != b'.' {
                staged += 1;
            }
            if xy[1] != b'.' {
                unstaged += 1;
            }
        } else if line.starts_with("u ") {
            // Unmerged entry — count as both
            staged += 1;
            unstaged += 1;
        } else if line.starts_with("? ") {
            untracked += 1;
        }
    }

    let dirty = staged > 0 || unstaged > 0 || untracked > 0;

    // Detect if this is a worktree by checking if .git is a file (not a directory)
    let git_path = std::path::Path::new(path).join(".git");
    let worktree_parent = if git_path.is_file() {
        // This is a worktree — resolve the main repo path via git-common-dir
        Command::new("git")
            .args(["-C", path, "rev-parse", "--git-common-dir"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    let common = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    // common is something like /path/to/main-repo/.git
                    // Get the parent directory name
                    std::path::Path::new(&common)
                        .parent()
                        .and_then(|p| p.file_name())
                        .map(|n| n.to_string_lossy().to_string())
                } else {
                    None
                }
            })
    } else {
        None
    };

    GitStatus {
        is_git_repo: true,
        branch,
        dirty,
        staged,
        unstaged,
        untracked,
        ahead,
        behind,
        worktree_parent,
    }
}

pub fn is_git_repo(path: &str) -> bool {
    Command::new("git")
        .args(["-C", path, "rev-parse", "--git-dir"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn init_repo(path: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["-C", path, "init", "-b", "main"])
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if stderr.contains("unknown switch `b'") || stderr.contains("unknown option `b'") {
        let fallback = Command::new("git")
            .args(["-C", path, "init"])
            .output()
            .map_err(|e| e.to_string())?;

        if fallback.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&fallback.stderr).to_string())
        }
    } else {
        Err(stderr)
    }
}

pub fn current_branch(path: &str) -> Result<String, String> {
    let output = Command::new("git")
        .args(["-C", path, "branch", "--show-current"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn list_branches(path: &str) -> Result<Vec<String>, String> {
    let output = Command::new("git")
        .args(["-C", path, "branch", "--format=%(refname:short)"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let branches = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();

    Ok(branches)
}

pub fn push_branch(path: &str, branch: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["-C", path, "push", "-u", "origin", branch])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

// ── Worktree listing ─────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: Option<String>,
    pub is_main: bool,
}

#[derive(serde::Serialize, Clone)]
pub struct CreatedWorktree {
    pub path: String,
    pub branch: String,
}

pub fn list_worktrees(path: &str) -> Result<Vec<WorktreeEntry>, String> {
    let output = Command::new("git")
        .args(["-C", path, "worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;

    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            let canonical_path = Path::new(rest)
                .canonicalize()
                .unwrap_or_else(|_| Path::new(rest).to_path_buf())
                .to_string_lossy()
                .to_string();
            // Flush previous entry
            if let Some(p) = current_path.take() {
                entries.push(WorktreeEntry {
                    path: p,
                    branch: current_branch.take(),
                    is_main: entries.is_empty(),
                });
            }
            current_path = Some(canonical_path);
            current_branch = None;
        } else if let Some(rest) = line.strip_prefix("branch refs/heads/") {
            current_branch = Some(rest.to_string());
        }
        // We ignore HEAD, bare, detached, etc.
    }

    // Flush last entry
    if let Some(p) = current_path.take() {
        entries.push(WorktreeEntry {
            path: p,
            branch: current_branch.take(),
            is_main: entries.is_empty(),
        });
    }

    Ok(entries)
}

pub fn create_worktree(path: &str, branch_name: &str) -> Result<CreatedWorktree, String> {
    let branch_name = branch_name.trim();
    if branch_name.is_empty() {
        return Err("Branch name is required".to_string());
    }

    let validate = Command::new("git")
        .args(["-C", path, "check-ref-format", "--branch", branch_name])
        .output()
        .map_err(|e| e.to_string())?;
    if !validate.status.success() {
        let stderr = String::from_utf8_lossy(&validate.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Invalid branch name: {branch_name}")
        } else {
            stderr
        });
    }

    // Always derive the output path from the main repo, not the calling worktree,
    // so all worktrees end up in the same .shipctl-worktrees/<repo>/ directory.
    let main_repo_path = {
        let out = Command::new("git")
            .args(["-C", path, "worktree", "list", "--porcelain"])
            .output()
            .map_err(|e| format!("Failed to list worktrees: {e}"))?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        stdout
            .lines()
            .find_map(|l| {
                l.strip_prefix("worktree ")
                    .map(|p| std::path::PathBuf::from(p.trim()))
            })
            .ok_or_else(|| "Could not determine main repo path".to_string())?
    }
    .canonicalize()
    .map_err(|error| format!("Could not resolve main repo path: {error}"))?;

    let repo_name = main_repo_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Could not determine repo name".to_string())?;
    let repo_parent = main_repo_path
        .parent()
        .ok_or_else(|| "Could not determine repo parent".to_string())?;

    let branch_slug = branch_name
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => c,
            _ => '-',
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let branch_slug = if branch_slug.is_empty() {
        "worktree".to_string()
    } else {
        branch_slug
    };

    let worktrees_root = repo_parent.join(".shipctl-worktrees");
    reject_symlink(&worktrees_root, "worktree root")?;
    std::fs::create_dir_all(&worktrees_root)
        .map_err(|error| format!("Failed to create worktree root: {error}"))?;

    let repo_worktrees = worktrees_root.join(repo_name);
    reject_symlink(&repo_worktrees, "repository worktree directory")?;
    std::fs::create_dir_all(&repo_worktrees)
        .map_err(|error| format!("Failed to create worktree directory: {error}"))?;
    let authorized_destination_root = repo_worktrees
        .canonicalize()
        .map_err(|error| format!("Could not resolve worktree directory: {error}"))?;
    let worktree_path = authorized_destination_root.join(branch_slug);

    if worktree_path.exists() {
        return Err(format!(
            "Worktree path already exists: {}",
            worktree_path.display()
        ));
    }

    let worktree_path_string = worktree_path.to_string_lossy().to_string();
    let output = Command::new("git")
        .args([
            "-C",
            path,
            "worktree",
            "add",
            "-b",
            branch_name,
            &worktree_path_string,
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(CreatedWorktree {
        path: worktree_path_string,
        branch: branch_name.to_string(),
    })
}

fn reject_symlink(path: &Path, label: &str) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "Refusing to use symlinked {label}: {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not inspect {}: {error}", path.display())),
    }
}

// ── Changed files (porcelain v2 parsing) ────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct ChangedFile {
    pub path: String,
    pub status: String,
    pub area: String,
    pub old_path: Option<String>,
}

pub fn changed_files(path: &str) -> Result<Vec<ChangedFile>, String> {
    // `--untracked-files=all` expands untracked directories into their
    // individual file entries. Without this, git returns `foo/` as a
    // single directory entry when a whole folder is untracked, and that
    // trailing-slash "folder" leaks into our file list. Gitignored files
    // inside the directory are still excluded.
    let output = Command::new("git")
        .args([
            "-C",
            path,
            "status",
            "--porcelain=v2",
            "--untracked-files=all",
            "-z",
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files = Vec::new();

    // -z uses NUL as delimiter; split on NUL
    let entries: Vec<&str> = stdout.split('\0').collect();
    let mut i = 0;

    while i < entries.len() {
        let entry = entries[i];
        if entry.is_empty() {
            i += 1;
            continue;
        }

        if entry.starts_with("1 ") {
            // Ordinary changed entry: 1 XY sub mH mI mW hH hI path
            let parts: Vec<&str> = entry.splitn(9, ' ').collect();
            if parts.len() >= 9 {
                let xy = parts[1].as_bytes();
                if xy.len() < 2 {
                    i += 1;
                    continue;
                }
                let file_path = parts[8].to_string();

                if xy[0] != b'.' {
                    files.push(ChangedFile {
                        path: file_path.clone(),
                        status: status_letter(xy[0]),
                        area: "staged".to_string(),
                        old_path: None,
                    });
                }
                if xy[1] != b'.' {
                    files.push(ChangedFile {
                        path: file_path,
                        status: status_letter(xy[1]),
                        area: "unstaged".to_string(),
                        old_path: None,
                    });
                }
            }
            i += 1;
        } else if entry.starts_with("2 ") {
            // Rename/copy entry: 2 XY sub mH mI mW hH hI Xscore path\0origPath
            let parts: Vec<&str> = entry.splitn(10, ' ').collect();
            if parts.len() >= 10 {
                let xy = parts[1].as_bytes();
                if xy.len() < 2 {
                    i += 1;
                    continue;
                }
                let file_path = parts[9].to_string();
                // The original path follows as the next NUL-delimited field
                let old_path = entries.get(i + 1).map(|s| s.to_string());

                if xy[0] != b'.' {
                    files.push(ChangedFile {
                        path: file_path.clone(),
                        status: "R".to_string(),
                        area: "staged".to_string(),
                        old_path: old_path.clone(),
                    });
                }
                if xy[1] != b'.' {
                    files.push(ChangedFile {
                        path: file_path,
                        status: "R".to_string(),
                        area: "unstaged".to_string(),
                        old_path,
                    });
                }
                i += 2; // skip the old_path entry
            } else {
                i += 1;
            }
        } else if entry.starts_with("u ") {
            // Unmerged entry: u XY sub m1 m2 m3 mW h1 h2 h3 path
            let parts: Vec<&str> = entry.splitn(11, ' ').collect();
            if parts.len() >= 11 {
                let file_path = parts[10].to_string();
                files.push(ChangedFile {
                    path: file_path.clone(),
                    status: "U".to_string(),
                    area: "unstaged".to_string(),
                    old_path: None,
                });
            }
            i += 1;
        } else if let Some(rest) = entry.strip_prefix("? ") {
            let file_path = rest.to_string();
            files.push(ChangedFile {
                path: file_path,
                status: "?".to_string(),
                area: "untracked".to_string(),
                old_path: None,
            });
            i += 1;
        } else {
            i += 1;
        }
    }

    Ok(files)
}

fn status_letter(byte: u8) -> String {
    match byte {
        b'M' => "M",
        b'A' => "A",
        b'D' => "D",
        b'R' => "R",
        b'C' => "C",
        b'T' => "T",
        _ => "M",
    }
    .to_string()
}

/// Maximum file size we'll return for preview. This is intentionally aligned
/// with the frontend's practical rendering budget so we don't send giant file
/// contents over IPC only to freeze the UI trying to paint them.
const MAX_FILE_PREVIEW_BYTES: u64 = 200 * 1024; // 200 KB

fn decode_preview_bytes(bytes: Vec<u8>, file_path: &str) -> Result<String, String> {
    String::from_utf8(bytes)
        .map_err(|_| format!("Binary or non-UTF-8 file cannot be previewed: {file_path}"))
}

/// List all files known to git in this repo — tracked files plus untracked
/// files that aren't gitignored. Uses the same flags `git status` uses
/// internally, so the result matches what a user would consider "files in
/// the project" (no node_modules, target/, etc.). We also include root-level
/// `.env`, `.env.*`, and `.envrc` files so common local config remains
/// inspectable even when ignored by git.
pub fn list_files(path: &str) -> Result<Vec<String>, String> {
    let output = Command::new("git")
        .args([
            "-C",
            path,
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files = stdout
        .lines()
        .map(|s| s.to_string())
        .collect::<BTreeSet<_>>();

    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                continue;
            };
            if !is_root_env_file(name) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_file() {
                continue;
            }
            files.insert(name.to_string());
        }
    }

    Ok(files.into_iter().collect())
}

fn is_root_env_file(name: &str) -> bool {
    name == ".env" || name == ".envrc" || name.starts_with(".env.")
}

/// Read a file's contents for preview in the file-viewer mode. `source`
/// selects which version:
/// - "working" — read from the working tree (on disk)
/// - "staged"  — read from the git index (`git show :path`)
/// - "head"    — read from HEAD (`git show HEAD:path`), used for deleted files
pub fn file_contents(path: &str, file_path: &str, source: &str) -> Result<String, String> {
    let root = Path::new(path);
    let file_argument = authorized_file_argument(file_path)?;
    match source {
        "working" => {
            let full_path = authorized_working_file(root, &file_argument)?;
            let metadata = std::fs::metadata(&full_path)
                .map_err(|e| format!("Cannot read {file_path}: {e}"))?;
            if metadata.len() > MAX_FILE_PREVIEW_BYTES {
                return Err(format!(
                    "File too large to preview ({} bytes, limit {})",
                    metadata.len(),
                    MAX_FILE_PREVIEW_BYTES
                ));
            }
            let bytes =
                std::fs::read(&full_path).map_err(|e| format!("Cannot read {file_path}: {e}"))?;
            decode_preview_bytes(bytes, file_path)
        }
        "staged" | "head" => {
            let spec = if source == "staged" {
                format!(":{file_argument}")
            } else {
                format!("HEAD:{file_argument}")
            };
            let output = Command::new("git")
                .args(["-C", path, "show", &spec])
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).to_string());
            }
            if (output.stdout.len() as u64) > MAX_FILE_PREVIEW_BYTES {
                return Err(format!(
                    "File too large to preview ({} bytes, limit {})",
                    output.stdout.len(),
                    MAX_FILE_PREVIEW_BYTES
                ));
            }
            decode_preview_bytes(output.stdout, file_path)
        }
        _ => Err(format!("Unknown source: {source}")),
    }
}

pub fn file_diff(path: &str, file_path: &str, staged: bool) -> Result<String, String> {
    let file_path = authorized_file_argument(file_path)?;
    let output = if staged {
        Command::new("git")
            .args(["-C", path, "diff", "--cached", "--", &file_path])
            .output()
            .map_err(|e| e.to_string())?
    } else {
        // Try normal diff first
        let result = Command::new("git")
            .args(["-C", path, "diff", "--", &file_path])
            .output()
            .map_err(|e| e.to_string())?;

        if result.status.success() && result.stdout.is_empty() {
            // Might be untracked — use diff against /dev/null
            Command::new("git")
                .args(["-C", path, "diff", "--no-index", "/dev/null", &file_path])
                .output()
                .map_err(|e| e.to_string())?
        } else {
            result
        }
    };

    // --no-index returns exit code 1 for differences, which is normal
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ── Per-file diff stats ──────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct DiffFileStat {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
}

fn parse_numstat_line(line: &str, fallback_path: Option<&str>) -> Option<DiffFileStat> {
    let parts: Vec<&str> = line.splitn(3, '\t').collect();
    if parts.len() != 3 {
        return None;
    }
    // Binary files report "-" instead of a count — treat as 0.
    let additions: u32 = parts[0].parse().unwrap_or(0);
    let deletions: u32 = parts[1].parse().unwrap_or(0);
    Some(DiffFileStat {
        path: fallback_path.unwrap_or(parts[2]).to_string(),
        additions,
        deletions,
    })
}

/// Returns addition/deletion line counts per changed file. Uses `git diff HEAD
/// --numstat` (all changes vs HEAD) so staged and unstaged changes are combined.
/// Falls back to `--cached` on repos with no HEAD yet (first commit pending).
pub fn diff_stats(path: &str) -> Result<Vec<DiffFileStat>, String> {
    let output = Command::new("git")
        .args(["-C", path, "diff", "HEAD", "--numstat"])
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = if output.status.success() {
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        let cached = Command::new("git")
            .args(["-C", path, "diff", "--cached", "--numstat"])
            .output()
            .map_err(|e| e.to_string())?;
        if !cached.status.success() {
            return Ok(vec![]);
        }
        String::from_utf8_lossy(&cached.stdout).to_string()
    };

    let mut stats: Vec<DiffFileStat> = stdout
        .lines()
        .filter_map(|line| parse_numstat_line(line, None))
        .collect();

    for file in changed_files(path)?
        .into_iter()
        .filter(|file| file.area == "untracked")
    {
        let output = Command::new("git")
            .args([
                "-C",
                path,
                "diff",
                "--no-index",
                "--numstat",
                "/dev/null",
                &file.path,
            ])
            .output()
            .map_err(|e| e.to_string())?;

        if output.stdout.is_empty() {
            continue;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        stats.extend(
            stdout
                .lines()
                .filter_map(|line| parse_numstat_line(line, Some(&file.path))),
        );
    }

    Ok(stats)
}

pub fn stage_file(path: &str, file_path: &str) -> Result<(), String> {
    let file_path = authorized_file_argument(file_path)?;
    let output = Command::new("git")
        .args(["-C", path, "add", "--", &file_path])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

pub fn stage_all(path: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["-C", path, "add", "-A"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

pub fn commit(path: &str, message: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["-C", path, "commit", "-m", message])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(())
}

pub fn unstage_file(path: &str, file_path: &str) -> Result<(), String> {
    let file_path = authorized_file_argument(file_path)?;
    let output = Command::new("git")
        .args(["-C", path, "restore", "--staged", "--", &file_path])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

pub fn unstage_all(path: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["-C", path, "restore", "--staged", "."])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(())
}

pub fn switch_branch(path: &str, branch_name: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["-C", path, "switch", branch_name])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(())
}

pub fn create_branch(path: &str, branch_name: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["-C", path, "switch", "-c", branch_name])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(())
}

#[cfg(test)]
mod provider_tests {
    use super::*;
    use proptest::prelude::*;
    use std::fs;

    struct TestCatalog {
        paths: Vec<String>,
    }

    impl GitProjectCatalog for TestCatalog {
        fn registered_project_paths(&self) -> Result<Vec<String>, String> {
            Ok(self.paths.clone())
        }
    }

    fn actor(module_id: &str, activation_id: &str) -> GitActor {
        GitActor {
            module_id: module_id.to_string(),
            activation_id: activation_id.to_string(),
        }
    }

    fn service(root: &Path) -> GitService {
        GitService::new(Arc::new(TestCatalog {
            paths: vec![root.to_string_lossy().to_string()],
        }))
    }

    proptest! {
        #[test]
        fn architecture_provider_git_parity_property(
            file_name in "[a-z][a-z0-9_-]{0,15}\\.txt",
            contents in any::<String>(),
        ) {
            let root = tempfile::tempdir().unwrap();
            let project_id = root.path().to_string_lossy().to_string();
            init_repo(&project_id).unwrap();
            fs::write(root.path().join(&file_name), contents).unwrap();
            let provider = service(root.path());
            let actor = actor("shipctl.git", "parity");

            let raw_status = status(&project_id);
            let provided_status = provider.inspect_status(&actor, &project_id).unwrap();
            prop_assert_eq!(provided_status.is_git_repo, raw_status.is_git_repo);
            prop_assert_eq!(provided_status.branch, raw_status.branch);
            prop_assert_eq!(provided_status.dirty, raw_status.dirty);
            prop_assert_eq!(provided_status.staged, raw_status.staged);
            prop_assert_eq!(provided_status.unstaged, raw_status.unstaged);
            prop_assert_eq!(provided_status.untracked, raw_status.untracked);
            prop_assert_eq!(
                provider.list_files(&actor, &project_id).unwrap(),
                list_files(&project_id).unwrap(),
            );
            prop_assert_eq!(
                provider.list_changed_files(&actor, &project_id).unwrap().len(),
                changed_files(&project_id).unwrap().len(),
            );
        }

        #[test]
        fn architecture_provider_git_authority_property(
            module_index in 0usize..3,
            write in any::<bool>(),
            disposed in any::<bool>(),
            registered_scope in any::<bool>(),
        ) {
            let root = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let provider = service(root.path());
            let modules = ["core", "shipctl.git", "shipctl.unknown"];
            let candidate = actor(modules[module_index], "authority");
            let known = module_index < 2;
            if disposed && known {
                provider.release_activation(&candidate).unwrap();
            }
            let project_id = if registered_scope {
                root.path().to_string_lossy().to_string()
            } else {
                outside.path().to_string_lossy().to_string()
            };
            let result = if write {
                provider.initialize_repository(&candidate, &project_id).map(|_| ())
            } else {
                provider.is_repository(&candidate, &project_id).map(|_| ())
            };

            let expected_code = if !known {
                Some(GIT_DENIED)
            } else if disposed {
                Some(GIT_ACTIVATION_DISPOSED)
            } else if !registered_scope {
                Some(GIT_INVALID_PROJECT)
            } else {
                None
            };
            match expected_code {
                Some(code) => prop_assert_eq!(result.unwrap_err().code, code),
                None => prop_assert!(result.is_ok()),
            }
            prop_assert!(!outside.path().join(".git").exists());
        }

        #[test]
        fn architecture_provider_git_ownership_property(release_first in any::<bool>()) {
            let root = tempfile::tempdir().unwrap();
            let project_id = root.path().to_string_lossy().to_string();
            let provider = service(root.path());
            let first = actor("shipctl.git", "first");
            let second = actor("shipctl.git", "second");
            let (released, live) = if release_first {
                (&first, &second)
            } else {
                (&second, &first)
            };

            prop_assert!(provider.release_activation(released).unwrap());
            let disposed = provider.is_repository(released, &project_id).unwrap_err();
            prop_assert_eq!(disposed.code, GIT_ACTIVATION_DISPOSED);
            prop_assert!(!provider.is_repository(live, &project_id).unwrap());
        }
    }
}
