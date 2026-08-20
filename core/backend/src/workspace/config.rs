use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Global config (~/.shipctl/config.yml) ───────────────────────────

/// Legacy global configuration keys that were once parsed by the native host.
///
/// They remain permanently unavailable to generic capability-data callers so a
/// future capability cannot silently take ownership of data that the
/// TypeScript configuration runtime still needs to import. The compatibility
/// reader deliberately bypasses this reservation while the one-way migration
/// remains supported.
const RESERVED_GLOBAL_CAPABILITY_KEYS: &[&str] = &[
    "version",
    "repos",
    "groups",
    "editor",
    "projects",
    "keybindings",
    "terminal",
    "sidebar",
    "ui",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub repos: Vec<RepoEntry>,
    #[serde(default)]
    pub groups: Vec<GroupEntry>,
    /// Opaque top-level data. The native host neither defines nor validates its
    /// product grammar; the TypeScript configuration runtime imports legacy
    /// values from here and persists current records through plugin-data.
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

        if RESERVED_GLOBAL_CAPABILITY_KEYS.contains(&capability_id) {
            return Err(format!(
                "Global config key {capability_id} is permanently reserved"
            ));
        }

        Ok(())
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

// ── Per-repo workspace config (<repo>/.shipctl/workspace.yml) ───────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    pub name: String,
    /// Opaque project configuration remains a documented bootstrap exception
    /// until the workspace plugin takes ownership and imports these records
    /// into plugin-data. See the Step 05 migration note for its deletion gate.
    #[serde(default, flatten)]
    pub capability_data: HashMap<String, serde_yaml::Value>,
}

#[cfg(test)]
mod tests {
    use super::{GlobalConfig, WorkspaceConfig, RESERVED_GLOBAL_CAPABILITY_KEYS};

    #[test]
    fn global_config_preserves_legacy_configuration_as_opaque_data() {
        let config: GlobalConfig = serde_yaml::from_str(
            "version: 1\nui:\n  canvas: layman\nterminal:\n  scrollbackBytes: 123\neditor:\n  preferredEditor: zed\n",
        )
        .unwrap();

        assert_eq!(
            config.capability_data.get("ui"),
            Some(&serde_json::json!({ "canvas": "layman" })),
        );
        assert_eq!(
            config.capability_data.get("terminal"),
            Some(&serde_json::json!({ "scrollbackBytes": 123 })),
        );
        assert!(serde_yaml::to_string(&config)
            .unwrap()
            .contains("canvas: layman"));
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
    fn global_capability_data_rejects_empty_and_permanently_reserved_keys() {
        let mut config = GlobalConfig::default();

        assert!(config
            .capability_value("")
            .unwrap_err()
            .contains("must not be empty"));
        for key in RESERVED_GLOBAL_CAPABILITY_KEYS {
            assert!(config
                .replace_capability_value(key, serde_json::json!({}))
                .unwrap_err()
                .contains("permanently reserved"));
        }
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
    fn workspace_preserves_legacy_commands_as_opaque_top_level_values() {
        let workspace: WorkspaceConfig = serde_yaml::from_str(
            "name: demo\ncommands:\n  - name: dev\n    command: pnpm dev\nassistants: []\nfutureCapability:\n  enabled: true\n",
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
        assert!(workspace.capability_data.contains_key("commands"));

        let serialized = serde_yaml::to_string(&workspace).unwrap();
        assert!(serialized.contains("assistants: []"));
        assert!(serialized.contains("futureCapability:"));
        assert!(serialized.contains("enabled: true"));
    }
}
