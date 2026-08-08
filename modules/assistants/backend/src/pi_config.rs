use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::{PiConfig, PiSettings};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PiAuthEntry {
    #[serde(rename = "type")]
    entry_type: String,
    key: String,
}

fn pi_agent_dir() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?
        .join(".pi")
        .join("agent"))
}

fn pi_settings_path() -> Result<PathBuf, String> {
    Ok(pi_agent_dir()?.join("settings.json"))
}

fn pi_auth_path() -> Result<PathBuf, String> {
    Ok(pi_agent_dir()?.join("auth.json"))
}

pub fn get_pi_config() -> Result<PiConfig, String> {
    let configured_providers = load_configured_providers()?;

    // Copy any pre-rename Keychain entries across the first time we see them.
    // Best-effort: a provider whose key cannot be copied still lists, it just
    // keeps resolving through its legacy entry.
    for provider in &configured_providers {
        let _ = migrate_legacy_api_key(provider);
    }

    // Read settings after migration so a rewritten auth entry is reflected.
    let settings = load_pi_settings()?;
    Ok(PiConfig {
        settings,
        configured_providers,
    })
}

fn load_pi_settings() -> Result<PiSettings, String> {
    let path = pi_settings_path()?;
    if !path.exists() {
        return Ok(PiSettings::default());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read pi settings: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse pi settings: {e}"))
}

fn load_configured_providers() -> Result<Vec<String>, String> {
    let path = pi_auth_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read pi auth: {e}"))?;
    let auth: HashMap<String, PiAuthEntry> = serde_json::from_str(&content).unwrap_or_default();
    let mut providers: Vec<String> = auth.keys().cloned().collect();
    providers.sort();
    Ok(providers)
}

pub fn save_pi_settings(settings: PiSettings) -> Result<(), String> {
    let dir = pi_agent_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create ~/.pi/agent dir: {e}"))?;

    let path = pi_settings_path()?;

    // Merge with existing to preserve fields we don't manage (e.g. theme, extensions)
    let mut merged: serde_json::Value = if path.exists() {
        let content =
            fs::read_to_string(&path).map_err(|e| format!("Failed to read pi settings: {e}"))?;
        serde_json::from_str(&content)
            .unwrap_or_else(|_| serde_json::Value::Object(Default::default()))
    } else {
        serde_json::Value::Object(Default::default())
    };

    if let Some(obj) = merged.as_object_mut() {
        match &settings.default_provider {
            Some(v) => {
                obj.insert(
                    "defaultProvider".to_string(),
                    serde_json::Value::String(v.clone()),
                );
            }
            None => {
                obj.remove("defaultProvider");
            }
        }
        match &settings.default_model {
            Some(v) => {
                obj.insert(
                    "defaultModel".to_string(),
                    serde_json::Value::String(v.clone()),
                );
            }
            None => {
                obj.remove("defaultModel");
            }
        }
        match &settings.default_thinking_level {
            Some(v) => {
                obj.insert(
                    "defaultThinkingLevel".to_string(),
                    serde_json::Value::String(v.clone()),
                );
            }
            None => {
                obj.remove("defaultThinkingLevel");
            }
        }
    }

    let json = serde_json::to_string_pretty(&merged)
        .map_err(|e| format!("Failed to serialize pi settings: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write pi settings: {e}"))
}

// Keychain identity for stored provider API keys.
//
// Pre-rename keys live under `shep-pi`. They are *copied* to `shipctl-pi` on
// demand and the originals are left in place, so an installed `shep` build
// keeps working with its own credentials. Nothing here ever deletes a legacy
// entry — only `delete_pi_api_key`, acting on an explicit user request,
// removes anything, and then only the current-name entry.
const KEYCHAIN_ACCOUNT: &str = "shipctl-pi";
const LEGACY_KEYCHAIN_ACCOUNT: &str = "shep-pi";

fn service_name(provider: &str) -> String {
    format!("{KEYCHAIN_ACCOUNT}-{provider}")
}

fn legacy_service_name(provider: &str) -> String {
    format!("{LEGACY_KEYCHAIN_ACCOUNT}-{provider}")
}

fn keychain_password(account: &str, service: &str) -> Option<String> {
    let output = Command::new("security")
        .args(["find-generic-password", "-a", account, "-s", service, "-w"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let secret = String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string();
    (!secret.is_empty()).then_some(secret)
}

fn write_keychain(provider: &str, api_key: &str) -> Result<String, String> {
    let service = service_name(provider);
    let output = Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-a",
            KEYCHAIN_ACCOUNT,
            "-s",
            &service,
            "-w",
            api_key,
        ])
        .output()
        .map_err(|e| format!("Failed to run security command: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to save API key to Keychain: {stderr}"));
    }

    Ok(service)
}

fn auth_command(service: &str) -> String {
    format!("!security find-generic-password -a {KEYCHAIN_ACCOUNT} -ws {service}")
}

/// Copy a provider's pre-rename Keychain entry to the current name, once.
///
/// Returns `true` when a legacy key was found and copied. The legacy entry is
/// left untouched so the old build keeps working.
pub fn migrate_legacy_api_key(provider: &str) -> Result<bool, String> {
    validate_provider_id(provider)?;
    if keychain_password(KEYCHAIN_ACCOUNT, &service_name(provider)).is_some() {
        return Ok(false);
    }
    let Some(secret) = keychain_password(LEGACY_KEYCHAIN_ACCOUNT, &legacy_service_name(provider))
    else {
        return Ok(false);
    };

    let service = write_keychain(provider, &secret)?;
    update_auth_entry(provider, &auth_command(&service))?;
    Ok(true)
}

pub fn save_pi_api_key(provider: &str, api_key: &str) -> Result<(), String> {
    validate_provider_id(provider)?;
    let service = write_keychain(provider, api_key)?;
    update_auth_entry(provider, &auth_command(&service))
}

pub fn delete_pi_api_key(provider: &str) -> Result<(), String> {
    validate_provider_id(provider)?;
    let service = service_name(provider);

    // Ignore errors — key may not exist in Keychain
    let _ = Command::new("security")
        .args([
            "delete-generic-password",
            "-a",
            KEYCHAIN_ACCOUNT,
            "-s",
            &service,
        ])
        .output();

    remove_auth_entry(provider)
}

fn validate_provider_id(provider: &str) -> Result<(), String> {
    if provider.is_empty()
        || !provider
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("Invalid provider id: {provider}"));
    }
    Ok(())
}

fn update_auth_entry(provider: &str, key_ref: &str) -> Result<(), String> {
    let dir = pi_agent_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create ~/.pi/agent dir: {e}"))?;

    let path = pi_auth_path()?;
    let mut auth: HashMap<String, PiAuthEntry> = if path.exists() {
        let content =
            fs::read_to_string(&path).map_err(|e| format!("Failed to read pi auth: {e}"))?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        HashMap::new()
    };

    auth.insert(
        provider.to_string(),
        PiAuthEntry {
            entry_type: "api_key".to_string(),
            key: key_ref.to_string(),
        },
    );

    let json = serde_json::to_string_pretty(&auth)
        .map_err(|e| format!("Failed to serialize pi auth: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write pi auth: {e}"))
}

fn remove_auth_entry(provider: &str) -> Result<(), String> {
    let path = pi_auth_path()?;
    if !path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read pi auth: {e}"))?;
    let mut auth: HashMap<String, PiAuthEntry> = serde_json::from_str(&content).unwrap_or_default();
    auth.remove(provider);

    let json = serde_json::to_string_pretty(&auth)
        .map_err(|e| format!("Failed to serialize pi auth: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write pi auth: {e}"))
}
