use std::path::Path;
use std::process::Command;
use tauri::State;
use url::Url;

use shipctl_core::workspace::config::normalize_terminal_settings;
use shipctl_core::workspace::manager::WorkspaceManager;

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

/// Open a URL externally, but only if its scheme is on the user's allowlist.
#[tauri::command]
pub fn open_url(url: &str, workspace: State<'_, WorkspaceManager>) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|_| "Invalid URL".to_string())?;
    let scheme = parsed.scheme().to_ascii_lowercase();

    let mut settings = workspace.load_terminal_settings()?;
    normalize_terminal_settings(&mut settings);

    if !settings
        .url_allowlist
        .iter()
        .any(|allowed| allowed == &scheme)
    {
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
