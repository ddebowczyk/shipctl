use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{Emitter, State};
use url::Url;

use crate::assistant_sessions::{
    providers, AssistantProvider, AssistantSessionRecord, AssistantSessionRegistry,
    PrepareAssistantSession, SessionMode,
};
use crate::fonts::{self, FontFaceData, FontFamily};
use crate::git;
use crate::git::{ChangedFile, CreatedWorktree, DiffFileStat, GitStatus, WorktreeEntry};
use crate::pty::manager::PtyManager;
use crate::pty::session::{PtyColorTheme, PtyOutput};
use crate::usage::{
    LocalUsageDetails, ProviderUsageSnapshot, UsageDb, UsageOverview, UsageProjectAliasReviewItem,
};
use crate::watcher::GitWatcher;
use crate::workspace::config::{
    normalize_terminal_settings, EditorSettings, GroupEntry, KeybindingSettings, ProjectSettings,
    RegisteredRepo, RepoInfo, SidebarSettings, TerminalSettings, UsageSettings, WorkspaceConfig,
};
use crate::workspace::manager::WorkspaceManager;

// ── Workspace commands ──────────────────────────────────────────────

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

#[tauri::command]
pub fn get_editor_settings(
    workspace: State<'_, WorkspaceManager>,
) -> Result<EditorSettings, String> {
    workspace.load_editor_settings()
}

#[tauri::command]
pub fn get_project_settings(
    workspace: State<'_, WorkspaceManager>,
) -> Result<ProjectSettings, String> {
    workspace.load_project_settings()
}

#[tauri::command]
pub fn save_editor_settings(
    settings: EditorSettings,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    workspace.save_editor_settings(&settings)
}

#[tauri::command]
pub fn save_project_settings(
    settings: ProjectSettings,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    workspace.save_project_settings(&settings)
}

#[tauri::command]
pub fn get_keybinding_settings(
    workspace: State<'_, WorkspaceManager>,
) -> Result<KeybindingSettings, String> {
    workspace.load_keybinding_settings()
}

#[tauri::command]
pub fn save_keybinding_settings(
    settings: KeybindingSettings,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    workspace.save_keybinding_settings(&settings)
}

#[tauri::command]
pub fn get_terminal_settings(
    workspace: State<'_, WorkspaceManager>,
) -> Result<TerminalSettings, String> {
    let mut settings = workspace.load_terminal_settings()?;
    normalize_terminal_settings(&mut settings);
    Ok(settings)
}

#[tauri::command]
pub fn save_terminal_settings(
    mut settings: TerminalSettings,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    normalize_terminal_settings(&mut settings);
    workspace.save_terminal_settings(&settings)
}

#[tauri::command]
pub fn get_sidebar_settings(
    workspace: State<'_, WorkspaceManager>,
) -> Result<SidebarSettings, String> {
    workspace.load_sidebar_settings()
}

#[tauri::command]
pub fn list_monospace_families() -> Vec<FontFamily> {
    fonts::list_monospace_families()
}

#[tauri::command]
pub async fn load_font_family(family: String) -> Vec<FontFaceData> {
    // Font file reads can total 10+ MB for a large family. Run on the blocking
    // thread pool so the Tauri runtime isn't stalled.
    tauri::async_runtime::spawn_blocking(move || fonts::load_font_family(&family))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub fn open_in_editor(
    repo_path: &str,
    editor_override: Option<String>,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    if !Path::new(repo_path).is_dir() {
        return Err(format!("Directory does not exist: {repo_path}"));
    }

    let editor_id = match editor_override {
        Some(editor_id) => editor_id,
        None => workspace
            .load_editor_settings()?
            .preferred_editor
            .ok_or_else(|| "Set a preferred editor in Settings before launching.".to_string())?,
    };

    open_path_in_editor(repo_path, &editor_id)
}

#[tauri::command]
pub fn reveal_in_finder(path: &str) -> Result<(), String> {
    if !Path::new(path).exists() {
        return Err(format!("Path does not exist: {path}"));
    }

    let status = Command::new("open")
        .arg(path)
        .status()
        .map_err(|e| format!("Failed to open Finder: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("Finder exited with status: {status}"))
    }
}

#[tauri::command]
pub fn open_url(url: &str, workspace: State<'_, WorkspaceManager>) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|_| "Invalid URL".to_string())?;
    let scheme = parsed.scheme().to_ascii_lowercase();

    let mut settings = workspace.load_terminal_settings()?;
    normalize_terminal_settings(&mut settings);

    if !settings.url_allowlist.iter().any(|allowed| allowed == &scheme) {
        return Err(format!("URL scheme '{scheme}' is not allowed"));
    }

    let status = Command::new("open")
        .arg(url)
        .status()
        .map_err(|e| format!("Failed to open URL: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("open exited with status: {status}"))
    }
}

// ── Group commands ─────────────────────────────────────────────────

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
pub fn delete_group(
    group_id: &str,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
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

// ── PTY commands ────────────────────────────────────────────────────

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn spawn_pty(
    command: &str,
    args: Option<Vec<String>>,
    cwd: &str,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
    color_theme: PtyColorTheme,
    on_data: Channel<PtyOutput>,
    pty_manager: State<'_, PtyManager>,
) -> Result<u32, String> {
    pty_manager.spawn(command, args, cwd, env, cols, rows, color_theme, on_data)
}

#[tauri::command]
pub fn write_pty(
    pty_id: u32,
    data: &str,
    pty_manager: State<'_, PtyManager>,
) -> Result<(), String> {
    pty_manager.write(pty_id, data.as_bytes())
}

#[tauri::command]
pub fn update_pty_color_theme(
    color_theme: PtyColorTheme,
    pty_manager: State<'_, PtyManager>,
) -> Result<(), String> {
    pty_manager.set_color_theme(color_theme)
}

#[tauri::command]
pub fn resize_pty(
    pty_id: u32,
    cols: u16,
    rows: u16,
    pty_manager: State<'_, PtyManager>,
) -> Result<(), String> {
    pty_manager.resize(pty_id, cols, rows)
}

#[tauri::command]
pub fn kill_pty(pty_id: u32, pty_manager: State<'_, PtyManager>) -> Result<(), String> {
    pty_manager.kill(pty_id)
}

// ── Assistant session restore commands ─────────────────────────────

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnAssistantSessionRequest {
    provider: AssistantProvider,
    launch_repo_path: String,
    placement_project_path: String,
    label: String,
    session_mode: SessionMode,
    model: Option<String>,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
    color_theme: PtyColorTheme,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnedAssistantSession {
    pty_id: u32,
    record: AssistantSessionRecord,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeAssistantSessionRequest {
    record_id: String,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
    color_theme: PtyColorTheme,
}

fn provider_spawn_error(provider: AssistantProvider, spawn_error: String) -> String {
    let (command, display_name) = match provider {
        AssistantProvider::Claude => ("claude", "Claude Code"),
        AssistantProvider::Codex => ("codex", "Codex"),
    };
    let version = Command::new(command)
        .arg("--version")
        .output()
        .ok()
        .and_then(|output| {
            let text = if output.stdout.is_empty() {
                String::from_utf8_lossy(&output.stderr).trim().to_string()
            } else {
                String::from_utf8_lossy(&output.stdout).trim().to_string()
            };
            (!text.is_empty()).then_some(text)
        });

    match version {
        Some(version) => format!(
            "Could not start {display_name}: {spawn_error}. Detected {version}; update {display_name} and try again."
        ),
        None => format!(
            "Could not start {display_name}: {spawn_error}. {display_name} was not found on Shep's PATH; install it or restart Shep after updating your shell setup."
        ),
    }
}

/// Persist the restore record before creating the provider process.
///
/// The frontend never supplies an executable command or argument list for a
/// restorable assistant. The provider adapter is the allowlisted authority for
/// both launch semantics and future resume semantics.
#[tauri::command]
pub fn spawn_assistant_session(
    request: SpawnAssistantSessionRequest,
    on_data: Channel<PtyOutput>,
    pty_manager: State<'_, PtyManager>,
    registry: State<'_, AssistantSessionRegistry>,
) -> Result<SpawnedAssistantSession, String> {
    let prepared = registry.prepare(PrepareAssistantSession {
        provider: request.provider,
        launch_repo_path: request.launch_repo_path,
        placement_project_path: request.placement_project_path,
        label: request.label,
        session_mode: request.session_mode,
        model: request.model,
    })?;
    let launch = providers::prepare_new_session(
        prepared.provider,
        prepared.session_mode,
        prepared.model.as_deref(),
        prepared.provider_session_id.as_deref(),
    )?;
    let pty_id = match pty_manager.spawn(
        &launch.command,
        Some(launch.args),
        &prepared.launch_repo_path,
        request.env,
        request.cols,
        request.rows,
        request.color_theme,
        on_data,
    ) {
        Ok(pty_id) => pty_id,
        Err(error) => {
            let _ = registry.discard(&prepared.record_id);
            return Err(provider_spawn_error(prepared.provider, error));
        }
    };

    let record = if prepared.provider == AssistantProvider::Claude {
        let session_id = prepared
            .provider_session_id
            .clone()
            .expect("Claude records always receive a UUID before spawn");
        match registry.confirm_capture(&prepared.record_id, session_id) {
            Ok(record) => record,
            Err(error) => {
                let _ = pty_manager.kill(pty_id);
                let _ = registry.discard(&prepared.record_id);
                return Err(error);
            }
        }
    } else {
        prepared
    };

    Ok(SpawnedAssistantSession { pty_id, record })
}

/// Restart only an already-captured provider session. If this fails the record
/// remains intact for a later retry; it is never converted into a fresh agent.
#[tauri::command]
pub fn resume_assistant_session(
    request: ResumeAssistantSessionRequest,
    on_data: Channel<PtyOutput>,
    pty_manager: State<'_, PtyManager>,
    registry: State<'_, AssistantSessionRegistry>,
) -> Result<SpawnedAssistantSession, String> {
    // Validate the immutable provider arguments before disarming the record.
    // A malformed old manifest therefore remains available for the recovery UI.
    let candidate = registry.get_restorable(&request.record_id)?;
    let provider_session_id = candidate
        .provider_session_id
        .as_deref()
        .expect("ready assistant records always contain a provider session id");
    let launch = providers::prepare_resume_session(
        candidate.provider,
        provider_session_id,
        candidate.session_mode,
        candidate.model.as_deref(),
    )?;
    let record = registry.claim_for_restore(&request.record_id)?;
    let pty_id = match pty_manager.spawn(
        &launch.command,
        Some(launch.args),
        &record.launch_repo_path,
        request.env,
        request.cols,
        request.rows,
        request.color_theme,
        on_data,
    ) {
        Ok(pty_id) => pty_id,
        Err(error) => {
            if let Err(rearm_error) = registry.rearm_for_restore(&record.record_id) {
                return Err(format!(
                    "{} The saved session could not be re-armed for retry: {rearm_error}",
                    provider_spawn_error(record.provider, error)
                ));
            }
            return Err(provider_spawn_error(record.provider, error));
        }
    };

    Ok(SpawnedAssistantSession { pty_id, record })
}

#[tauri::command]
pub fn prepare_assistant_session(
    request: PrepareAssistantSession,
    registry: State<'_, AssistantSessionRegistry>,
) -> Result<AssistantSessionRecord, String> {
    registry.prepare(request)
}

#[tauri::command]
pub fn confirm_assistant_session_capture(
    record_id: &str,
    provider_session_id: String,
    registry: State<'_, AssistantSessionRegistry>,
) -> Result<AssistantSessionRecord, String> {
    registry.confirm_capture(record_id, provider_session_id)
}

#[tauri::command]
pub fn try_capture_codex_assistant_session(
    record_id: &str,
    registry: State<'_, AssistantSessionRegistry>,
) -> Result<Option<AssistantSessionRecord>, String> {
    registry.try_capture_codex_session(record_id)
}

#[tauri::command]
pub fn fail_assistant_session_capture(
    record_id: &str,
    registry: State<'_, AssistantSessionRegistry>,
) -> Result<AssistantSessionRecord, String> {
    registry.mark_capture_failed(record_id)
}

#[tauri::command]
pub fn update_assistant_session_placement(
    record_id: &str,
    placement_project_path: String,
    registry: State<'_, AssistantSessionRegistry>,
) -> Result<AssistantSessionRecord, String> {
    registry.update_placement(record_id, placement_project_path)
}

#[tauri::command]
pub fn update_assistant_session_label(
    record_id: &str,
    label: String,
    registry: State<'_, AssistantSessionRegistry>,
) -> Result<AssistantSessionRecord, String> {
    registry.update_label(record_id, label)
}

#[tauri::command]
pub fn discard_assistant_session(
    record_id: &str,
    registry: State<'_, AssistantSessionRegistry>,
) -> Result<(), String> {
    registry.discard(record_id)
}

#[tauri::command]
pub fn rearm_assistant_session(
    record_id: &str,
    registry: State<'_, AssistantSessionRegistry>,
) -> Result<(), String> {
    registry.rearm_for_restore(record_id)
}

#[tauri::command]
pub fn list_restorable_assistant_sessions(
    registry: State<'_, AssistantSessionRegistry>,
) -> Vec<AssistantSessionRecord> {
    registry.list_restorable()
}

#[tauri::command]
pub fn take_assistant_session_startup_warning(
    registry: State<'_, AssistantSessionRegistry>,
) -> Option<String> {
    registry.take_startup_warning()
}

#[tauri::command]
pub fn begin_assistant_session_preserving_shutdown(
    registry: State<'_, AssistantSessionRegistry>,
) -> Result<(), String> {
    registry.begin_preserving_shutdown()
}

// ── App lifecycle commands ────────────────────────────────────────

#[tauri::command]
pub fn get_pty_session_count(pty_manager: State<'_, PtyManager>) -> usize {
    pty_manager.session_count()
}

#[tauri::command]
pub fn shutdown_and_quit(
    app: tauri::AppHandle,
    pty_manager: State<'_, PtyManager>,
    watcher: State<'_, GitWatcher>,
    registry: State<'_, AssistantSessionRegistry>,
) -> Result<(), String> {
    // Freeze the durable manifest before any termination signal. This retains
    // eligible records and prevents PTY exit callbacks from deleting them
    // during the normal shutdown path.
    registry.try_capture_pending_codex_sessions();
    registry.begin_preserving_shutdown()?;
    if !pty_manager.begin_shutdown() {
        return Ok(());
    }
    watcher.shutdown();
    pty_manager.kill_all();
    app.exit(0);
    Ok(())
}

// ── File watcher commands ─────────────────────────────────────────

#[tauri::command]
pub fn watch_repo(path: &str, watcher: State<'_, GitWatcher>) -> Result<(), String> {
    watcher.watch(path)
}

#[tauri::command]
pub fn unwatch_repo(path: &str, watcher: State<'_, GitWatcher>) -> Result<(), String> {
    watcher.unwatch(path)
}

// ── Git commands (async — runs on Tauri thread pool, not main thread) ──

#[tauri::command]
pub async fn is_git_repo(path: String) -> bool {
    git::is_git_repo(&path)
}

#[tauri::command]
pub async fn git_init(path: String) -> Result<(), String> {
    git::init_repo(&path)
}

#[tauri::command]
pub async fn git_current_branch(path: String) -> Result<String, String> {
    git::current_branch(&path)
}

#[tauri::command]
pub async fn git_list_branches(path: String) -> Result<Vec<String>, String> {
    git::list_branches(&path)
}

#[tauri::command]
pub async fn git_push_branch(path: String, branch: String) -> Result<(), String> {
    git::push_branch(&path, &branch)
}

#[tauri::command]
pub async fn git_list_worktrees(path: String) -> Result<Vec<WorktreeEntry>, String> {
    git::list_worktrees(&path)
}

#[tauri::command]
pub async fn git_create_worktree(path: String, branch_name: String) -> Result<CreatedWorktree, String> {
    git::create_worktree(&path, &branch_name)
}

#[tauri::command]
pub async fn git_status(path: String) -> GitStatus {
    git::status(&path)
}

#[tauri::command]
pub async fn git_changed_files(path: String) -> Result<Vec<ChangedFile>, String> {
    git::changed_files(&path)
}

#[tauri::command]
pub async fn git_file_diff(path: String, file_path: String, staged: bool) -> Result<String, String> {
    git::file_diff(&path, &file_path, staged)
}

#[tauri::command]
pub async fn git_file_contents(path: String, file_path: String, source: String) -> Result<String, String> {
    git::file_contents(&path, &file_path, &source)
}

#[tauri::command]
pub async fn git_list_files(path: String) -> Result<Vec<String>, String> {
    git::list_files(&path)
}

#[tauri::command]
pub async fn git_stage_file(path: String, file_path: String) -> Result<(), String> {
    git::stage_file(&path, &file_path)
}

#[tauri::command]
pub async fn git_stage_all(path: String) -> Result<(), String> {
    git::stage_all(&path)
}

#[tauri::command]
pub async fn git_commit(path: String, message: String) -> Result<(), String> {
    git::commit(&path, &message)
}

#[tauri::command]
pub async fn git_unstage_file(path: String, file_path: String) -> Result<(), String> {
    git::unstage_file(&path, &file_path)
}

#[tauri::command]
pub async fn git_unstage_all(path: String) -> Result<(), String> {
    git::unstage_all(&path)
}

#[tauri::command]
pub async fn git_switch_branch(path: String, branch_name: String) -> Result<(), String> {
    git::switch_branch(&path, &branch_name)
}

#[tauri::command]
pub async fn git_create_branch(path: String, branch_name: String) -> Result<(), String> {
    git::create_branch(&path, &branch_name)
}

#[tauri::command]
pub async fn git_diff_stats(path: String) -> Result<Vec<DiffFileStat>, String> {
    git::diff_stats(&path)
}

// ── System commands ────────────────────────────────────────────────

#[tauri::command]
pub fn get_username() -> String {
    std::env::var("USER").unwrap_or_default()
}

#[tauri::command]
pub fn get_home_directory() -> Result<String, String> {
    dirs::home_dir()
        .map(|path| path.to_string_lossy().to_string())
        .ok_or_else(|| "Could not find home directory".to_string())
}

#[tauri::command]
pub fn get_default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

#[tauri::command]
pub fn get_computer_name() -> String {
    Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub fn check_command_exists(command: &str) -> bool {
    Command::new("which")
        .arg(command)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn get_all_usage_snapshots(
    db: State<'_, UsageDb>,
    workspace: State<'_, WorkspaceManager>,
) -> Result<Vec<ProviderUsageSnapshot>, String> {
    let enabled = enabled_providers(&workspace);
    Ok(crate::usage::get_all_usage_snapshots(&db, &enabled))
}

#[tauri::command]
pub async fn get_usage_snapshot(
    db: State<'_, UsageDb>,
    workspace: State<'_, WorkspaceManager>,
    provider: String,
) -> Result<ProviderUsageSnapshot, String> {
    let enabled = enabled_providers(&workspace);
    crate::usage::get_usage_snapshot(&db, &provider, &enabled)
}

fn enabled_providers(workspace: &State<'_, WorkspaceManager>) -> crate::usage::EnabledProviders {
    let settings = workspace.load_usage_settings().unwrap_or_default();
    crate::usage::EnabledProviders {
        claude: settings.claude.show,
        codex: settings.codex.show,
        gemini: settings.gemini.show,
        antigravity: settings.antigravity.show,
    }
}

#[tauri::command]
pub fn get_usage_settings(
    workspace: State<'_, WorkspaceManager>,
) -> Result<UsageSettings, String> {
    workspace.load_usage_settings()
}

#[tauri::command]
pub fn save_usage_settings(
    settings: UsageSettings,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    workspace.save_usage_settings(&settings)
}

#[tauri::command]
pub async fn get_usage_details(db: State<'_, UsageDb>, provider: String, window: String) -> Result<LocalUsageDetails, String> {
    crate::usage::get_windowed_details(&db, &provider, &window)
}

#[tauri::command]
pub async fn get_usage_overview(db: State<'_, UsageDb>, window: String) -> Result<UsageOverview, String> {
    crate::usage::get_usage_overview(&db, &window)
}

#[tauri::command]
pub async fn get_project_alias_review_queue(
    db: State<'_, UsageDb>,
) -> Result<Vec<UsageProjectAliasReviewItem>, String> {
    Ok(crate::usage::get_project_alias_review_queue(&db))
}

#[tauri::command]
pub async fn get_models_for_provider(
    db: State<'_, UsageDb>,
    provider: String,
) -> Result<Vec<String>, String> {
    match provider.as_str() {
        "pi" => Ok(sort_cli_models(&db, query_cli_models("pi", &["--list-models"], parse_pi_models))),
        "opencode" => Ok(sort_cli_models(&db, query_cli_models("opencode", &["models"], parse_opencode_models))),
        _ => Ok(crate::usage::get_models_for_provider(&db, &provider)),
    }
}

fn query_cli_models(
    cmd: &str,
    args: &[&str],
    parser: fn(&str) -> Vec<String>,
) -> Vec<String> {
    let mut child = match Command::new(cmd)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return Vec::new(),
    };

    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Vec::new();
    };

    let reader = thread::spawn(move || {
        let mut text = String::new();
        stdout.read_to_string(&mut text).map(|_| text).ok()
    });

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = reader.join().ok().flatten();
                if !status.success() {
                    return Vec::new();
                }
                return output.map(|text| parser(&text)).unwrap_or_default();
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Vec::new();
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Vec::new();
            }
        }
    }
}

fn sort_cli_models(db: &UsageDb, models: Vec<String>) -> Vec<String> {
    let conn = db.conn.lock().unwrap();
    let mut dated: Vec<(String, String)> = models
        .into_iter()
        .map(|name| {
            let date = name.split_once('/')
                .and_then(|(provider, model)| {
                    conn.query_row(
                        "SELECT COALESCE(release_date, '2000-01-01') FROM model_pricing WHERE provider = ?1 AND model_pattern = ?2",
                        rusqlite::params![provider, model],
                        |row| row.get::<_, String>(0),
                    ).ok()
                })
                .unwrap_or_else(|| "2000-01-01".to_string());
            (name, date)
        })
        .collect();
    dated.sort_by(|a, b| b.1.cmp(&a.1));
    dated.into_iter().map(|(name, _)| name).collect()
}

/// Parse `pi --list-models` table: "provider  model  context  ..."
fn parse_pi_models(text: &str) -> Vec<String> {
    text.lines()
        .skip(1) // header row
        .filter_map(|line| {
            let mut cols = line.split_whitespace();
            let provider = cols.next()?;
            let model = cols.next()?;
            Some(format!("{provider}/{model}"))
        })
        .collect()
}

/// Parse `opencode models` output: "provider/model" per line
fn parse_opencode_models(text: &str) -> Vec<String> {
    text.lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

#[tauri::command]
pub fn refresh_usage_data(db: State<'_, UsageDb>, app: tauri::AppHandle) {
    let db = db.inner().clone();
    std::thread::spawn(move || {
        crate::usage::run_background_ingest(&db);
        let _ = app.emit("usage-ingest-complete", ());
    });
}

// ── Memory diagnostics (dev only) ──────────────────────────────────

#[derive(serde::Serialize)]
pub struct MemoryStats {
    /// Shep (Rust backend) resident memory in bytes
    pub app_rss: u64,
    /// Total resident memory of all child processes (CLI tools) in bytes
    pub children_rss: u64,
}

#[tauri::command]
pub async fn get_memory_stats(pty_manager: State<'_, PtyManager>) -> Result<MemoryStats, String> {
    let app_pid = std::process::id() as i32;
    let app_rss = rss_for_pid(app_pid);

    // Sum RSS of all child process trees
    let child_pids = pty_manager.child_pids();
    let mut children_rss: u64 = 0;
    for pid in child_pids {
        let pid = pid as i32;
        // The direct child + its descendants
        children_rss += rss_for_pid(pid);
        if let Ok(output) = Command::new("pgrep").arg("-P").arg(pid.to_string()).output() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if let Ok(child) = line.trim().parse::<i32>() {
                    children_rss += rss_for_pid(child);
                }
            }
        }
    }

    Ok(MemoryStats { app_rss, children_rss })
}

/// Get resident set size (RSS) for a single PID using `ps`.
fn rss_for_pid(pid: i32) -> u64 {
    // ps -o rss= returns RSS in kilobytes
    Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|kb| kb * 1024)
        .unwrap_or(0)
}

fn open_path_in_editor(repo_path: &str, editor_id: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app_name = editor_app_name(editor_id)
            .ok_or_else(|| format!("Unsupported editor: {editor_id}"))?;

        let status = Command::new("open")
            .args(["-a", app_name, repo_path])
            .status()
            .map_err(|e| format!("Failed to launch {app_name}: {e}"))?;

        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "Launching {app_name} failed with exit status {:?}",
                status.code()
            ))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = repo_path;
        let _ = editor_id;
        Err("Open in editor is currently only implemented for macOS.".to_string())
    }
}

fn editor_app_name(editor_id: &str) -> Option<&'static str> {
    match editor_id {
        "vscode" => Some("Visual Studio Code"),
        "zed" => Some("Zed"),
        "cursor" => Some("Cursor"),
        "sublime_text" => Some("Sublime Text"),
        _ => None,
    }
}

// ── Pi config commands ─────────────────────────────────────────────

#[tauri::command]
pub fn get_pi_config() -> Result<crate::pi_config::PiConfig, String> {
    crate::pi_config::get_pi_config()
}

#[tauri::command]
pub fn save_pi_settings(settings: crate::pi_config::PiSettings) -> Result<(), String> {
    crate::pi_config::save_pi_settings(settings)
}

#[tauri::command]
pub fn save_pi_api_key(provider: String, api_key: String) -> Result<(), String> {
    crate::pi_config::save_pi_api_key(&provider, &api_key)
}

#[tauri::command]
pub fn delete_pi_api_key(provider: String) -> Result<(), String> {
    crate::pi_config::delete_pi_api_key(&provider)
}
