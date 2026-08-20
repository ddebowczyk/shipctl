//! Private Tauri transport for the generic Assistant Launch semantic service.

use serde::Deserialize;
use tauri::State;

use shipctl_core::assistant_launch::{
    AssistantLaunchActor, AssistantLaunchError, AssistantLaunchService,
    AssistantResourceExecuteInput, AssistantResourceExecuteResult, AssistantResourceReadInput,
    AssistantResourceReadResult, AssistantResourceWriteInput, AssistantSessionRecord,
    ResumeAssistantSessionInput, StartAssistantSessionInput, StartedAssistantSession,
    ASSISTANT_LAUNCH_INVALID_REQUEST, ASSISTANT_LAUNCH_TRANSPORT_FAILED,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateAssistantLaunchRequest<Input> {
    activation: AssistantLaunchActor,
    correlation_id: String,
    input: Input,
}

fn validate_request<Input>(
    request: &PrivateAssistantLaunchRequest<Input>,
) -> Result<(), AssistantLaunchError> {
    if request.correlation_id.trim().is_empty()
        || request.correlation_id.chars().any(char::is_control)
    {
        Err(AssistantLaunchError {
            code: ASSISTANT_LAUNCH_INVALID_REQUEST.to_string(),
            message: "The assistant launch correlation identity is invalid".to_string(),
            retryable: false,
        })
    } else {
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantSessionInput {
    record_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordAssistantSessionIdentityInput {
    record_id: String,
    provider_session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordAssistantPlacementInput {
    record_id: String,
    placement_project_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordAssistantLabelInput {
    record_id: String,
    label: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmptyAssistantLaunchInput {}

#[tauri::command]
pub fn start_assistant_session(
    request: PrivateAssistantLaunchRequest<StartAssistantSessionInput>,
    service: State<'_, AssistantLaunchService>,
) -> Result<StartedAssistantSession, AssistantLaunchError> {
    validate_request(&request)?;
    service.start_session(&request.activation, request.input)
}

#[tauri::command]
pub fn resume_assistant_session(
    request: PrivateAssistantLaunchRequest<ResumeAssistantSessionInput>,
    service: State<'_, AssistantLaunchService>,
) -> Result<StartedAssistantSession, AssistantLaunchError> {
    validate_request(&request)?;
    service.resume_session(&request.activation, request.input)
}

#[tauri::command]
pub fn record_assistant_session_identity(
    request: PrivateAssistantLaunchRequest<RecordAssistantSessionIdentityInput>,
    service: State<'_, AssistantLaunchService>,
) -> Result<AssistantSessionRecord, AssistantLaunchError> {
    validate_request(&request)?;
    service.record_session_identity(
        &request.activation,
        &request.input.record_id,
        request.input.provider_session_id,
    )
}

#[tauri::command]
pub fn mark_assistant_session_identity_failed(
    request: PrivateAssistantLaunchRequest<AssistantSessionInput>,
    service: State<'_, AssistantLaunchService>,
) -> Result<AssistantSessionRecord, AssistantLaunchError> {
    validate_request(&request)?;
    service.mark_session_identity_failed(&request.activation, &request.input.record_id)
}

#[tauri::command]
pub fn record_assistant_session_placement(
    request: PrivateAssistantLaunchRequest<RecordAssistantPlacementInput>,
    service: State<'_, AssistantLaunchService>,
) -> Result<AssistantSessionRecord, AssistantLaunchError> {
    validate_request(&request)?;
    service.record_session_placement(
        &request.activation,
        &request.input.record_id,
        request.input.placement_project_path,
    )
}

#[tauri::command]
pub fn record_assistant_session_label(
    request: PrivateAssistantLaunchRequest<RecordAssistantLabelInput>,
    service: State<'_, AssistantLaunchService>,
) -> Result<AssistantSessionRecord, AssistantLaunchError> {
    validate_request(&request)?;
    service.record_session_label(
        &request.activation,
        &request.input.record_id,
        request.input.label,
    )
}

#[tauri::command]
pub fn discard_assistant_session(
    request: PrivateAssistantLaunchRequest<AssistantSessionInput>,
    service: State<'_, AssistantLaunchService>,
) -> Result<(), AssistantLaunchError> {
    validate_request(&request)?;
    service.discard_session(&request.activation, &request.input.record_id)
}

#[tauri::command]
pub fn rearm_assistant_session(
    request: PrivateAssistantLaunchRequest<AssistantSessionInput>,
    service: State<'_, AssistantLaunchService>,
) -> Result<(), AssistantLaunchError> {
    validate_request(&request)?;
    service.rearm_session(&request.activation, &request.input.record_id)
}

#[tauri::command]
pub fn inspect_restorable_assistant_sessions(
    request: PrivateAssistantLaunchRequest<EmptyAssistantLaunchInput>,
    service: State<'_, AssistantLaunchService>,
) -> Result<Vec<AssistantSessionRecord>, AssistantLaunchError> {
    validate_request(&request)?;
    service.inspect_restorable_sessions(&request.activation)
}

#[tauri::command]
pub fn take_assistant_session_startup_warning(
    request: PrivateAssistantLaunchRequest<EmptyAssistantLaunchInput>,
    service: State<'_, AssistantLaunchService>,
) -> Result<Option<String>, AssistantLaunchError> {
    validate_request(&request)?;
    service.take_startup_warning(&request.activation)
}

#[tauri::command]
pub fn prepare_assistant_sessions_for_shutdown(
    request: PrivateAssistantLaunchRequest<EmptyAssistantLaunchInput>,
    service: State<'_, AssistantLaunchService>,
) -> Result<(), AssistantLaunchError> {
    validate_request(&request)?;
    service.prepare_for_shutdown(&request.activation)
}

#[tauri::command]
pub async fn read_assistant_launch_resource(
    request: PrivateAssistantLaunchRequest<AssistantResourceReadInput>,
    service: State<'_, AssistantLaunchService>,
) -> Result<AssistantResourceReadResult, AssistantLaunchError> {
    validate_request(&request)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.read_resource(&request.activation, request.input)
    })
    .await
    .map_err(resource_worker_error)?
}

#[tauri::command]
pub async fn write_assistant_launch_resource(
    request: PrivateAssistantLaunchRequest<AssistantResourceWriteInput>,
    service: State<'_, AssistantLaunchService>,
) -> Result<(), AssistantLaunchError> {
    validate_request(&request)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.write_resource(&request.activation, request.input)
    })
    .await
    .map_err(resource_worker_error)?
}

#[tauri::command]
pub async fn execute_assistant_launch_resource(
    request: PrivateAssistantLaunchRequest<AssistantResourceExecuteInput>,
    service: State<'_, AssistantLaunchService>,
) -> Result<AssistantResourceExecuteResult, AssistantLaunchError> {
    validate_request(&request)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.execute_resource(&request.activation, request.input)
    })
    .await
    .map_err(resource_worker_error)?
}

#[tauri::command]
pub fn release_assistant_launch_activation(
    request: PrivateAssistantLaunchRequest<EmptyAssistantLaunchInput>,
    service: State<'_, AssistantLaunchService>,
) -> Result<bool, AssistantLaunchError> {
    validate_request(&request)?;
    service.release_activation(&request.activation)
}

fn resource_worker_error(error: tauri::Error) -> AssistantLaunchError {
    AssistantLaunchError {
        code: ASSISTANT_LAUNCH_TRANSPORT_FAILED.to_string(),
        message: format!("Assistant resource worker failed: {error}"),
        retryable: false,
    }
}
