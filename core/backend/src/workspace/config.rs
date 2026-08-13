use serde::{Deserialize, Serialize};

use crate::terminal_host::retention::{TerminalRetentionPolicy, RETENTION_DEFAULT_BYTES};
use std::collections::{HashMap, HashSet};

// ── Global config (~/.shipctl/config.yml) ───────────────────────────

/// The main canvas implementation selected when Shipctl starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CanvasAdapter {
    Legacy,
    Layman,
}

impl Default for CanvasAdapter {
    fn default() -> Self {
        Self::Legacy
    }
}

impl CanvasAdapter {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Legacy => "legacy",
            Self::Layman => "layman",
        }
    }
}

/// Host-owned composition settings. These never enter capability data or
/// per-session UI state because they select the application shell itself.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UiSettings {
    #[serde(default)]
    pub canvas: CanvasAdapter,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub repos: Vec<RepoEntry>,
    #[serde(default)]
    pub groups: Vec<GroupEntry>,
    #[serde(default)]
    pub projects: ProjectSettings,
    #[serde(default)]
    pub editor: EditorSettings,
    #[serde(default)]
    pub keybindings: KeybindingSettings,
    #[serde(default)]
    pub terminal: TerminalSettings,
    #[serde(default)]
    pub sidebar: SidebarSettings,
    #[serde(default)]
    pub ui: UiSettings,
    /// Capability-owned top-level values remain human-editable without expanding the host schema.
    #[serde(default, flatten)]
    pub capability_data: HashMap<String, serde_json::Value>,
}

fn default_version() -> u32 {
    1
}

impl Default for GlobalConfig {
    fn default() -> Self {
        GlobalConfig {
            version: 1,
            repos: Vec::new(),
            groups: Vec::new(),
            projects: ProjectSettings::default(),
            editor: EditorSettings::default(),
            keybindings: KeybindingSettings::default(),
            terminal: TerminalSettings::default(),
            sidebar: SidebarSettings::default(),
            ui: UiSettings::default(),
            capability_data: HashMap::new(),
        }
    }
}

impl GlobalConfig {
    pub fn capability_value(
        &self,
        capability_id: &str,
    ) -> Result<Option<serde_json::Value>, String> {
        self.assert_capability_id(capability_id)?;
        Ok(self.capability_data.get(capability_id).cloned())
    }

    pub fn replace_capability_value(
        &mut self,
        capability_id: &str,
        value: serde_json::Value,
    ) -> Result<(), String> {
        self.assert_capability_id(capability_id)?;
        self.capability_data
            .insert(capability_id.to_string(), value);
        Ok(())
    }

    fn assert_capability_id(&self, capability_id: &str) -> Result<(), String> {
        if capability_id.trim().is_empty() {
            return Err("Global capability ID must not be empty".to_string());
        }

        let mut host_document = self.clone();
        host_document.capability_data.clear();
        let host_value = serde_yaml::to_value(host_document)
            .map_err(|error| format!("Failed to inspect global config ownership: {error}"))?;
        let host_owned = host_value.as_mapping().is_some_and(|mapping| {
            mapping.contains_key(serde_yaml::Value::String(capability_id.to_string()))
        });
        if host_owned {
            return Err(format!(
                "Global config key {capability_id} is host-owned data"
            ));
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EditorSettings {
    #[serde(default, rename = "preferredEditor")]
    pub preferred_editor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSettings {
    #[serde(default = "default_true", rename = "autoImportWorktrees")]
    pub auto_import_worktrees: bool,
    #[serde(default = "default_true", rename = "showAgentSessionsInSidebar")]
    pub show_agent_sessions_in_sidebar: bool,
    /// Capability-owned settings remain human-editable without expanding the host schema.
    #[serde(default, flatten)]
    pub extensions: HashMap<String, serde_json::Value>,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        ProjectSettings {
            auto_import_worktrees: true,
            show_agent_sessions_in_sidebar: true,
            extensions: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeybindingSettings {
    #[serde(default = "default_true", rename = "shiftEnterNewline")]
    pub shift_enter_newline: bool,
    #[serde(default = "default_true", rename = "optionDeleteWord")]
    pub option_delete_word: bool,
    #[serde(default = "default_true", rename = "cmdKClear")]
    pub cmd_k_clear: bool,
}

fn default_true() -> bool {
    true
}

impl Default for KeybindingSettings {
    fn default() -> Self {
        KeybindingSettings {
            shift_enter_newline: true,
            option_delete_word: true,
            cmd_k_clear: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSettings {
    #[serde(default = "default_cursor_style", rename = "cursorStyle")]
    pub cursor_style: String,
    #[serde(default = "default_true", rename = "cursorBlink")]
    pub cursor_blink: bool,
    /// Host scrollback retention budget in bytes. Ghostty measures history in
    /// bytes, so a row-named field here would be a lie the user cannot check.
    #[serde(default = "default_scrollback_bytes", rename = "scrollbackBytes")]
    pub scrollback_bytes: usize,
    #[serde(default = "default_font_family", rename = "fontFamily")]
    pub font_family: String,
    #[serde(default = "default_font_size", rename = "fontSize")]
    pub font_size: u32,
    #[serde(
        default = "default_url_allowlist",
        rename = "urlAllowlist",
        alias = "allowedUrlSchemes"
    )]
    pub url_allowlist: Vec<String>,
    /// Ask before forwarding paste text that the host classifies as unsafe.
    /// This stays off unless the user enables it in the global config file.
    #[serde(default, rename = "confirmUnsafePaste")]
    pub confirm_unsafe_paste: bool,
}

fn default_cursor_style() -> String {
    "block".to_string()
}

fn default_scrollback_bytes() -> usize {
    RETENTION_DEFAULT_BYTES
}

fn default_font_family() -> String {
    "MesloLGS NF".to_string()
}

fn default_font_size() -> u32 {
    14
}

fn default_url_allowlist() -> Vec<String> {
    vec!["http".to_string(), "https".to_string()]
}

impl Default for TerminalSettings {
    fn default() -> Self {
        TerminalSettings {
            cursor_style: default_cursor_style(),
            cursor_blink: true,
            scrollback_bytes: default_scrollback_bytes(),
            font_family: default_font_family(),
            font_size: default_font_size(),
            url_allowlist: default_url_allowlist(),
            confirm_unsafe_paste: false,
        }
    }
}

pub fn normalize_terminal_settings(settings: &mut TerminalSettings) {
    settings.url_allowlist = normalize_url_allowlist(&settings.url_allowlist);
    settings.scrollback_bytes =
        TerminalRetentionPolicy::from_bytes(settings.scrollback_bytes).bytes();
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidebarSettings {
    #[serde(default = "default_sidebar_font_size", rename = "fontSize")]
    pub font_size: u32,
    #[serde(default = "default_sidebar_font_family", rename = "fontFamily")]
    pub font_family: String,
    #[serde(default = "default_sidebar_width")]
    pub width: u32,
}

fn default_sidebar_font_size() -> u32 {
    13
}

fn default_sidebar_font_family() -> String {
    "SF Pro Display, IBM Plex Sans, Segoe UI, sans-serif".to_string()
}

fn default_sidebar_width() -> u32 {
    288
}

impl Default for SidebarSettings {
    fn default() -> Self {
        SidebarSettings {
            font_size: default_sidebar_font_size(),
            font_family: default_sidebar_font_family(),
            width: default_sidebar_width(),
        }
    }
}

pub fn normalize_sidebar_settings(settings: &mut SidebarSettings) {
    settings.font_size = settings.font_size.clamp(10, 24);
    settings.width = settings.width.clamp(224, 560);

    let trimmed = settings.font_family.trim();
    settings.font_family = if trimmed.is_empty() {
        default_sidebar_font_family()
    } else {
        trimmed.to_string()
    };
}

fn normalize_url_allowlist(schemes: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for scheme in ["http", "https"] {
        seen.insert(scheme.to_string());
        normalized.push(scheme.to_string());
    }

    for scheme in schemes {
        let candidate = scheme.trim().trim_end_matches(':').to_ascii_lowercase();
        if !is_valid_url_scheme_token(&candidate) {
            continue;
        }
        if seen.insert(candidate.clone()) {
            normalized.push(candidate);
        }
    }

    normalized
}

fn is_valid_url_scheme_token(scheme: &str) -> bool {
    let mut chars = scheme.chars();
    match chars.next() {
        Some(ch) if ch.is_ascii_alphabetic() => {}
        _ => return false,
    }

    chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoEntry {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub order: u32,
}

// ── Repo info returned to frontend ──────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisteredRepo {
    pub path: String,
    pub workspace: WorkspaceConfig,
}

// ── Per-repo workspace config (<repo>/.shipctl/workspace.yml) ───────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandConfig {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub autostart: bool,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    pub name: String,
    #[serde(default)]
    pub commands: Vec<CommandConfig>,
    /// Module-owned top-level values remain human-editable without expanding host schema.
    #[serde(default, flatten)]
    pub capability_data: HashMap<String, serde_yaml::Value>,
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_terminal_settings, CanvasAdapter, GlobalConfig, ProjectSettings,
        TerminalSettings, WorkspaceConfig, RETENTION_DEFAULT_BYTES,
    };

    #[test]
    fn global_config_defaults_canvas_to_legacy_when_ui_is_absent() {
        let config: GlobalConfig = serde_yaml::from_str("version: 1\n").unwrap();

        assert_eq!(config.ui.canvas, CanvasAdapter::Legacy);
    }

    #[test]
    fn global_config_accepts_layman_canvas_selection() {
        let config: GlobalConfig = serde_yaml::from_str("ui:\n  canvas: layman\n").unwrap();

        assert_eq!(config.ui.canvas, CanvasAdapter::Layman);
    }

    #[test]
    fn global_config_rejects_an_unknown_canvas_selection() {
        let error = serde_yaml::from_str::<GlobalConfig>("ui:\n  canvas: mosaic\n")
            .unwrap_err()
            .to_string();

        assert!(error.contains("mosaic"));
        assert!(error.contains("legacy"));
        assert!(error.contains("layman"));
    }

    #[test]
    fn global_config_round_trips_the_canvas_selection() {
        let config: GlobalConfig = serde_yaml::from_str("ui:\n  canvas: layman\n").unwrap();
        let yaml = serde_yaml::to_string(&config).unwrap();
        let restored: GlobalConfig = serde_yaml::from_str(&yaml).unwrap();

        assert!(yaml.contains("ui:"));
        assert!(yaml.contains("canvas: layman"));
        assert_eq!(restored.ui.canvas, CanvasAdapter::Layman);
    }

    #[test]
    fn global_config_preserves_capability_owned_top_level_values() {
        let mut config: GlobalConfig =
            serde_yaml::from_str("version: 1\nfutureCapability:\n  density: compact\n").unwrap();

        assert_eq!(
            config.capability_value("futureCapability").unwrap(),
            Some(serde_json::json!({ "density": "compact" })),
        );
        config
            .replace_capability_value("anotherCapability", serde_json::json!({ "enabled": true }))
            .unwrap();

        let serialized = serde_yaml::to_string(&config).unwrap();
        assert!(serialized.contains("futureCapability:"));
        assert!(serialized.contains("density: compact"));
        assert!(serialized.contains("anotherCapability:"));
        assert!(serialized.contains("enabled: true"));
    }

    #[test]
    fn global_capability_data_rejects_empty_and_host_owned_keys() {
        let mut config = GlobalConfig::default();

        assert!(config
            .capability_value("")
            .unwrap_err()
            .contains("must not be empty"));
        assert!(config
            .replace_capability_value("terminal", serde_json::json!({}))
            .unwrap_err()
            .contains("host-owned"));
        assert!(config
            .replace_capability_value("ui", serde_json::json!({}))
            .unwrap_err()
            .contains("host-owned"));
    }

    #[test]
    fn usage_document_is_opaque_capability_data() {
        let config: GlobalConfig = serde_yaml::from_str(
            "version: 1\nusage:\n  claude:\n    show: false\n    futureOption: preserved\n",
        )
        .unwrap();

        assert_eq!(
            config.capability_value("usage").unwrap(),
            Some(serde_json::json!({
                "claude": {
                    "show": false,
                    "futureOption": "preserved"
                }
            }))
        );
        assert!(serde_yaml::to_string(&config)
            .unwrap()
            .contains("futureOption: preserved"));
    }

    #[test]
    fn project_settings_preserve_capability_owned_values_without_host_fields() {
        let settings: ProjectSettings = serde_yaml::from_str(
            "autoImportWorktrees: true\nshowAgentSessionsInSidebar: false\nexampleModuleValue: compact\n",
        )
        .unwrap();

        assert_eq!(
            settings.extensions.get("exampleModuleValue"),
            Some(&serde_json::Value::String("compact".to_string())),
        );

        let serialized = serde_yaml::to_string(&settings).unwrap();
        assert!(serialized.contains("exampleModuleValue: compact"));
    }

    #[test]
    fn workspace_preserves_capability_owned_top_level_values() {
        let workspace: WorkspaceConfig = serde_yaml::from_str(
            "name: demo\ncommands: []\nassistants: []\nfutureCapability:\n  enabled: true\n",
        )
        .unwrap();

        assert_eq!(
            workspace.capability_data.get("futureCapability"),
            Some(&serde_yaml::Value::Mapping(serde_yaml::Mapping::from_iter(
                [(
                    serde_yaml::Value::String("enabled".to_string()),
                    serde_yaml::Value::Bool(true),
                )]
            ))),
        );
        assert_eq!(
            workspace.capability_data.get("assistants"),
            Some(&serde_yaml::Value::Sequence(Vec::new())),
        );

        let serialized = serde_yaml::to_string(&workspace).unwrap();
        assert!(serialized.contains("assistants: []"));
        assert!(serialized.contains("futureCapability:"));
        assert!(serialized.contains("enabled: true"));
    }

    /// A settings file written before the rename holds a row count under the
    /// old key. A row count cannot become a byte budget, so the load path
    /// drops it and the user gets the default budget the settings panel shows.
    #[test]
    fn a_settings_file_from_before_the_rename_loads_the_default_byte_budget() {
        let mut settings: TerminalSettings =
            serde_yaml::from_str("cursorStyle: bar\nscrollback: 10000\n").unwrap();
        normalize_terminal_settings(&mut settings);

        assert_eq!(settings.cursor_style, "bar");
        assert_eq!(settings.scrollback_bytes, RETENTION_DEFAULT_BYTES);
    }

    /// The host preserves a byte budget. A selected driver decides whether it
    /// has a narrower valid range.
    #[test]
    fn persisted_byte_budgets_remain_driver_owned_values() {
        let mut too_large: TerminalSettings =
            serde_yaml::from_str(&format!("scrollbackBytes: {}\n", usize::MAX)).unwrap();
        normalize_terminal_settings(&mut too_large);
        assert_eq!(too_large.scrollback_bytes, usize::MAX);

        let mut in_domain: TerminalSettings = serde_yaml::from_str("scrollbackBytes: 0\n").unwrap();
        normalize_terminal_settings(&mut in_domain);
        assert_eq!(in_domain.scrollback_bytes, 0);
    }

    #[test]
    fn unsafe_paste_confirmation_is_opt_in_and_round_trips_in_yaml() {
        let default_settings: TerminalSettings = serde_yaml::from_str("{}").unwrap();
        assert!(!default_settings.confirm_unsafe_paste);

        let enabled: TerminalSettings = serde_yaml::from_str("confirmUnsafePaste: true\n").unwrap();
        assert!(enabled.confirm_unsafe_paste);
        assert!(serde_yaml::to_string(&enabled)
            .unwrap()
            .contains("confirmUnsafePaste: true"));
    }
}
