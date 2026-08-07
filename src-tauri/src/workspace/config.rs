use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

// ── Global config (~/.shep/config.yml) ──────────────────────────────

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
    pub usage: UsageSettings,
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
            usage: UsageSettings::default(),
            capability_data: HashMap::new(),
        }
    }
}

impl GlobalConfig {
    pub fn capability_value(&self, capability_id: &str) -> Result<Option<serde_json::Value>, String> {
        self.assert_capability_id(capability_id)?;
        Ok(self.capability_data.get(capability_id).cloned())
    }

    pub fn replace_capability_value(
        &mut self,
        capability_id: &str,
        value: serde_json::Value,
    ) -> Result<(), String> {
        self.assert_capability_id(capability_id)?;
        self.capability_data.insert(capability_id.to_string(), value);
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
        let host_owned = host_value
            .as_mapping()
            .is_some_and(|mapping| {
                mapping.contains_key(serde_yaml::Value::String(capability_id.to_string()))
            });
        if host_owned {
            return Err(format!("Global config key {capability_id} is host-owned data"));
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
    #[serde(default = "default_scrollback")]
    pub scrollback: u32,
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
}

fn default_cursor_style() -> String {
    "block".to_string()
}

fn default_scrollback() -> u32 {
    10000
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
            scrollback: default_scrollback(),
            font_family: default_font_family(),
            font_size: default_font_size(),
            url_allowlist: default_url_allowlist(),
        }
    }
}

pub fn normalize_terminal_settings(settings: &mut TerminalSettings) {
    settings.url_allowlist = normalize_url_allowlist(&settings.url_allowlist);
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
pub struct ProviderBudgetConfig {
    #[serde(default = "default_true")]
    pub show: bool,
    #[serde(default = "default_budget_mode_subscription", rename = "budgetMode")]
    pub budget_mode: String,
    #[serde(default, rename = "monthlyBudget")]
    pub monthly_budget: Option<f64>,
}

fn default_budget_mode_subscription() -> String {
    "subscription".to_string()
}

impl ProviderBudgetConfig {
    fn default_subscription() -> Self {
        ProviderBudgetConfig {
            show: true,
            budget_mode: "subscription".to_string(),
            monthly_budget: None,
        }
    }

    fn default_custom() -> Self {
        ProviderBudgetConfig {
            show: true,
            budget_mode: "custom".to_string(),
            monthly_budget: None,
        }
    }
}

fn default_provider_subscription() -> ProviderBudgetConfig {
    ProviderBudgetConfig::default_subscription()
}

fn default_provider_custom() -> ProviderBudgetConfig {
    ProviderBudgetConfig::default_custom()
}

fn default_provider_custom_hidden() -> ProviderBudgetConfig {
    ProviderBudgetConfig {
        show: false,
        ..ProviderBudgetConfig::default_custom()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageSettings {
    #[serde(default = "default_provider_subscription")]
    pub claude: ProviderBudgetConfig,
    #[serde(default = "default_provider_subscription")]
    pub codex: ProviderBudgetConfig,
    #[serde(default = "default_provider_subscription")]
    pub antigravity: ProviderBudgetConfig,
    #[serde(default = "default_provider_subscription")]
    pub gemini: ProviderBudgetConfig,
    #[serde(default = "default_provider_custom")]
    pub opencode: ProviderBudgetConfig,
    #[serde(default = "default_provider_custom_hidden")]
    pub pi: ProviderBudgetConfig,
}

impl Default for UsageSettings {
    fn default() -> Self {
        UsageSettings {
            claude: ProviderBudgetConfig::default_subscription(),
            codex: ProviderBudgetConfig::default_subscription(),
            antigravity: ProviderBudgetConfig::default_subscription(),
            gemini: ProviderBudgetConfig {
                show: false,
                ..ProviderBudgetConfig::default_subscription()
            },
            opencode: ProviderBudgetConfig {
                monthly_budget: Some(100.0),
                ..ProviderBudgetConfig::default_custom()
            },
            pi: ProviderBudgetConfig::default_custom(),
        }
    }
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

// ── Per-repo workspace config (<repo>/.shep/workspace.yml) ──────────

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
    use super::{GlobalConfig, ProjectSettings, WorkspaceConfig};

    #[test]
    fn global_config_preserves_capability_owned_top_level_values() {
        let mut config: GlobalConfig = serde_yaml::from_str(
            "version: 1\nfutureCapability:\n  density: compact\n",
        )
        .unwrap();

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

        assert!(config.capability_value("").unwrap_err().contains("must not be empty"));
        assert!(config
            .replace_capability_value("terminal", serde_json::json!({}))
            .unwrap_err()
            .contains("host-owned"));
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
}
