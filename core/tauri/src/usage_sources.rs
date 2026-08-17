//! Private Tauri transport for the public Usage Sources semantic service.

use serde::Deserialize;
use tauri::State;

use shipctl_core::usage_sources::{
    InspectUsageSourcesInput, RefreshUsageSourcesInput, UsageSourceDataset, UsageSourcesActor,
    UsageSourcesError, UsageSourcesRefreshReceipt, UsageSourcesService,
    USAGE_SOURCES_INVALID_REQUEST, USAGE_SOURCES_TRANSPORT_FAILED,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateUsageSourcesRequest<Input> {
    activation: UsageSourcesActor,
    correlation_id: String,
    input: Input,
}

fn validate_request<Input>(
    request: &PrivateUsageSourcesRequest<Input>,
) -> Result<(), UsageSourcesError> {
    if request.correlation_id.trim().is_empty()
        || request.correlation_id.chars().any(char::is_control)
    {
        Err(UsageSourcesError {
            code: USAGE_SOURCES_INVALID_REQUEST.to_string(),
            message: "The usage source correlation identity is invalid".to_string(),
            retryable: false,
        })
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn inspect_usage_sources(
    request: PrivateUsageSourcesRequest<InspectUsageSourcesInput>,
    service: State<'_, UsageSourcesService>,
) -> Result<UsageSourceDataset, UsageSourcesError> {
    validate_request(&request)?;
    service.inspect_sources(&request.activation, request.input)
}

#[tauri::command]
pub async fn refresh_usage_sources(
    request: PrivateUsageSourcesRequest<RefreshUsageSourcesInput>,
    service: State<'_, UsageSourcesService>,
) -> Result<UsageSourcesRefreshReceipt, UsageSourcesError> {
    validate_request(&request)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.refresh_sources(&request.activation, request.input)
    })
    .await
    .map_err(|error| UsageSourcesError {
        code: USAGE_SOURCES_TRANSPORT_FAILED.to_string(),
        message: format!("Usage source refresh worker failed: {error}"),
        retryable: false,
    })?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseUsageSourcesActivationInput {}

#[tauri::command]
pub fn release_usage_sources_activation(
    request: PrivateUsageSourcesRequest<ReleaseUsageSourcesActivationInput>,
    service: State<'_, UsageSourcesService>,
) -> Result<bool, UsageSourcesError> {
    validate_request(&request)?;
    service.release_activation(&request.activation)
}
