use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use tauri::ipc::Channel;
use tauri::State;
use url::Url;

use crate::fonts::{self, FontFaceData, FontFamily};
use crate::pty::manager::PtyManager;
use crate::pty::session::{PtyColorTheme, PtyOutput};
use crate::watcher::GitWatcher;
use crate::workspace::config::{
    normalize_terminal_settings, EditorSettings, GroupEntry, KeybindingSettings, ProjectSettings,
    RegisteredRepo, RepoInfo, SidebarSettings, TerminalSettings, WorkspaceConfig,
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
) -> Result<(), String> {
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
