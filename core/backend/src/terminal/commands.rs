use std::collections::HashMap;
use std::process::Command;
use tauri::ipc::Channel;
use tauri::State;

use crate::terminal::manager::PtyManager;
use crate::terminal::session::{PtyColorTheme, PtyOutput};
use crate::workspace::config::{normalize_terminal_settings, TerminalSettings};
use crate::workspace::manager::WorkspaceManager;

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
pub fn acknowledge_pty_output(
    pty_id: u32,
    bytes: usize,
    pty_manager: State<'_, PtyManager>,
) -> Result<(), String> {
    pty_manager.acknowledge_output(pty_id, bytes)
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

#[tauri::command]
pub fn get_pty_session_count(pty_manager: State<'_, PtyManager>) -> usize {
    pty_manager.session_count()
}

// ── Terminal settings ──────────────────────────────────────────────

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
        if let Ok(output) = Command::new("pgrep")
            .arg("-P")
            .arg(pid.to_string())
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if let Ok(child) = line.trim().parse::<i32>() {
                    children_rss += rss_for_pid(child);
                }
            }
        }
    }

    Ok(MemoryStats {
        app_rss,
        children_rss,
    })
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
