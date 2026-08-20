use std::collections::HashSet;
use std::path::Path;
use std::process::Command;
use url::Url;

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

/// Open a URL externally if the caller's TypeScript-owned configuration allows
/// its scheme. Native code validates only the generic URL/token boundary.
#[tauri::command]
pub fn open_url(url: &str, allowed_schemes: Vec<String>) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|_| "Invalid URL".to_string())?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    let allowed_schemes = normalize_url_schemes(&allowed_schemes);
    if !allowed_schemes.contains(&scheme) {
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

/// Launch a chosen editor. The preferred-editor policy is resolved by the
/// TypeScript configuration runtime before this operating-system adapter.
#[tauri::command]
pub fn open_in_editor(repo_path: &str, editor_id: String) -> Result<(), String> {
    if !Path::new(repo_path).is_dir() {
        return Err(format!("Directory does not exist: {repo_path}"));
    }

    open_path_in_editor(repo_path, &editor_id)
}

fn normalize_url_schemes(schemes: &[String]) -> HashSet<String> {
    schemes
        .iter()
        .filter_map(|scheme| {
            let candidate = scheme.trim().trim_end_matches(':').to_ascii_lowercase();
            is_valid_url_scheme_token(&candidate).then_some(candidate)
        })
        .collect()
}

fn is_valid_url_scheme_token(scheme: &str) -> bool {
    let mut chars = scheme.chars();
    match chars.next() {
        Some(ch) if ch.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
}

fn open_path_in_editor(repo_path: &str, editor_id: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app_name =
            editor_app_name(editor_id).ok_or_else(|| format!("Unsupported editor: {editor_id}"))?;

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

#[cfg(target_os = "macos")]
fn editor_app_name(editor_id: &str) -> Option<&'static str> {
    match editor_id {
        "vscode" => Some("Visual Studio Code"),
        "zed" => Some("Zed"),
        "cursor" => Some("Cursor"),
        "sublime_text" => Some("Sublime Text"),
        _ => None,
    }
}
