//! Private Tauri transport for the public Plugin Data semantic service.

use serde::Deserialize;
use tauri::State;

use shipctl_core::plugin_data::{
    PluginDataActor, PluginDataMigrationReceipt, PluginDataMigrationTransaction, PluginDataRecord,
    PluginDataScope, PluginDataService, PluginDataWrite,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivatePluginDataRequest<Input> {
    activation: PluginDataActor,
    correlation_id: String,
    input: Input,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadPluginDataInput {
    scope: PluginDataScope,
    key: String,
}

fn validate_correlation_id(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        Err("plugin-data.invalid-request: Correlation ID is invalid".to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn read_plugin_data_record(
    request: PrivatePluginDataRequest<ReadPluginDataInput>,
    service: State<'_, PluginDataService>,
) -> Result<Option<PluginDataRecord>, String> {
    validate_correlation_id(&request.correlation_id)?;
    service.read_record(
        &request.activation,
        &request.input.scope,
        &request.input.key,
    )
}

#[tauri::command]
pub fn write_plugin_data_record(
    request: PrivatePluginDataRequest<PluginDataWrite>,
    service: State<'_, PluginDataService>,
) -> Result<PluginDataRecord, String> {
    validate_correlation_id(&request.correlation_id)?;
    service.write_record(&request.activation, request.input)
}

#[tauri::command]
pub fn migrate_plugin_data_records(
    request: PrivatePluginDataRequest<PluginDataMigrationTransaction>,
    service: State<'_, PluginDataService>,
) -> Result<PluginDataMigrationReceipt, String> {
    validate_correlation_id(&request.correlation_id)?;
    service.migrate_records(&request.activation, request.input)
}
