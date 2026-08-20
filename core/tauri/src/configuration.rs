use tauri::State;

use shipctl_core::workspace::manager::WorkspaceManager;

/// An opaque compatibility value consumed by the TypeScript configuration
/// migration. Native code does not interpret its schema or defaults.
#[derive(serde::Serialize)]
pub struct LegacyConfigurationValue {
    pub value: serde_json::Value,
}

/// Read a legacy global configuration field while TypeScript performs its
/// one-way import into `shipctl.host` plugin-data records.
#[tauri::command]
pub fn read_global_configuration_value(
    key: String,
    workspace: State<'_, WorkspaceManager>,
) -> Result<Option<LegacyConfigurationValue>, String> {
    workspace
        .read_global_configuration_value(&key)
        .map(|value| value.map(|value| LegacyConfigurationValue { value }))
}

/// Temporary workspace bootstrap exception. Delete this command when the
/// workspace plugin is activated and imports workspace documents into its own
/// plugin-data namespace.
#[tauri::command]
pub fn read_project_configuration_value(
    project_id: String,
    key: String,
    workspace: State<'_, WorkspaceManager>,
) -> Result<Option<LegacyConfigurationValue>, String> {
    workspace
        .read_project_configuration_value(&project_id, &key)
        .map(|value| value.map(|value| LegacyConfigurationValue { value }))
}
