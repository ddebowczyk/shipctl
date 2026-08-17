//! Pi provider settings and compatibility credential references.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::{PiConfig, PiSettings};

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
