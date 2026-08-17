//! Private Tauri transport for the public semantic-terminal service.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value as JsonValue;
use tauri::{
    ipc::{Channel, Response},
    State,
};

use shipctl_core::semantic_terminal::{
    SemanticTerminalActor, SemanticTerminalError, SemanticTerminalEventSink,
    SemanticTerminalService, SEMANTIC_TERMINALS_INVALID_REQUEST,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateSemanticTerminalRequest<Input> {
    activation: SemanticTerminalActor,
    correlation_id: String,
    input: Input,
}

fn validate_request<Input>(
    request: &PrivateSemanticTerminalRequest<Input>,
) -> Result<(), SemanticTerminalError> {
    if request.correlation_id.trim().is_empty()
        || request.correlation_id.chars().any(char::is_control)
    {
        Err(SemanticTerminalError {
            code: SEMANTIC_TERMINALS_INVALID_REQUEST.to_string(),
            message: "The semantic terminal correlation identity is invalid".to_string(),
            retryable: false,
        })
    } else {
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotSemanticTerminalInput {
    terminal_id: String,
}

#[tauri::command]
pub fn get_semantic_terminal_snapshot(
    request: PrivateSemanticTerminalRequest<SnapshotSemanticTerminalInput>,
    service: State<'_, SemanticTerminalService>,
) -> Result<JsonValue, SemanticTerminalError> {
    validate_request(&request)?;
    service.snapshot(&request.activation, &request.input.terminal_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachSemanticTerminalInput {
    terminal_id: String,
    claims_resize: bool,
}

#[tauri::command]
pub fn attach_semantic_terminal(
    request: PrivateSemanticTerminalRequest<AttachSemanticTerminalInput>,
    on_event: Channel<Response>,
    service: State<'_, SemanticTerminalService>,
) -> Result<JsonValue, SemanticTerminalError> {
    validate_request(&request)?;
    let sink: SemanticTerminalEventSink = Arc::new(move |event| {
        let json = serde_json::to_string(&event)
            .map_err(|error| format!("Semantic terminal event encoding failed: {error}"))?;
        on_event
            .send(Response::new(json))
            .map_err(|error| format!("Semantic terminal attachment channel closed: {error}"))
    });
    service.attach(
        &request.activation,
        &request.input.terminal_id,
        request.input.claims_resize,
        sink,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreditSemanticTerminalScreenInput {
    attachment_id: String,
    committed_sequence: u64,
}

#[tauri::command]
pub fn credit_semantic_terminal_screen(
    request: PrivateSemanticTerminalRequest<CreditSemanticTerminalScreenInput>,
    service: State<'_, SemanticTerminalService>,
) -> Result<(), SemanticTerminalError> {
    validate_request(&request)?;
    service.credit_screen(
        &request.activation,
        &request.input.attachment_id,
        request.input.committed_sequence,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DetachSemanticTerminalInput {
    attachment_id: String,
}

#[tauri::command]
pub fn detach_semantic_terminal(
    request: PrivateSemanticTerminalRequest<DetachSemanticTerminalInput>,
    service: State<'_, SemanticTerminalService>,
) -> Result<(), SemanticTerminalError> {
    validate_request(&request)?;
    service.detach(&request.activation, &request.input.attachment_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResizeSemanticTerminalInput {
    terminal_id: String,
    attachment_id: String,
    columns: u16,
    rows: u16,
}

#[tauri::command]
pub fn resize_semantic_terminal(
    request: PrivateSemanticTerminalRequest<ResizeSemanticTerminalInput>,
    service: State<'_, SemanticTerminalService>,
) -> Result<(), SemanticTerminalError> {
    validate_request(&request)?;
    service.resize(
        &request.activation,
        &request.input.terminal_id,
        &request.input.attachment_id,
        request.input.columns,
        request.input.rows,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputSemanticTerminalInput {
    terminal_id: String,
    input: JsonValue,
}

#[tauri::command]
pub fn input_semantic_terminal(
    request: PrivateSemanticTerminalRequest<InputSemanticTerminalInput>,
    service: State<'_, SemanticTerminalService>,
) -> Result<JsonValue, SemanticTerminalError> {
    validate_request(&request)?;
    service.input(
        &request.activation,
        &request.input.terminal_id,
        request.input.input,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistorySemanticTerminalInput {
    terminal_id: String,
    start_row: u32,
    rows: u32,
}

#[tauri::command]
pub fn history_semantic_terminal(
    request: PrivateSemanticTerminalRequest<HistorySemanticTerminalInput>,
    service: State<'_, SemanticTerminalService>,
) -> Result<JsonValue, SemanticTerminalError> {
    validate_request(&request)?;
    service.history(
        &request.activation,
        &request.input.terminal_id,
        request.input.start_row,
        request.input.rows,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnchorSemanticTerminalInput {
    terminal_id: String,
    space: JsonValue,
    at: JsonValue,
}

#[tauri::command]
pub fn anchor_semantic_terminal(
    request: PrivateSemanticTerminalRequest<AnchorSemanticTerminalInput>,
    service: State<'_, SemanticTerminalService>,
) -> Result<JsonValue, SemanticTerminalError> {
    validate_request(&request)?;
    service.anchor(
        &request.activation,
        &request.input.terminal_id,
        request.input.space,
        request.input.at,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SemanticTerminalAnchorInput {
    terminal_id: String,
    anchor_id: JsonValue,
}

#[tauri::command]
pub fn resolve_semantic_terminal_anchor(
    request: PrivateSemanticTerminalRequest<SemanticTerminalAnchorInput>,
    service: State<'_, SemanticTerminalService>,
) -> Result<JsonValue, SemanticTerminalError> {
    validate_request(&request)?;
    service.resolve_anchor(
        &request.activation,
        &request.input.terminal_id,
        request.input.anchor_id,
    )
}

#[tauri::command]
pub fn release_semantic_terminal_anchor(
    request: PrivateSemanticTerminalRequest<SemanticTerminalAnchorInput>,
    service: State<'_, SemanticTerminalService>,
) -> Result<JsonValue, SemanticTerminalError> {
    validate_request(&request)?;
    service.release_anchor(
        &request.activation,
        &request.input.terminal_id,
        request.input.anchor_id,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectSemanticTerminalInput {
    terminal_id: String,
    request: JsonValue,
}

#[tauri::command]
pub fn select_semantic_terminal(
    request: PrivateSemanticTerminalRequest<SelectSemanticTerminalInput>,
    service: State<'_, SemanticTerminalService>,
) -> Result<JsonValue, SemanticTerminalError> {
    validate_request(&request)?;
    service.select(
        &request.activation,
        &request.input.terminal_id,
        request.input.request,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectSemanticTerminalPasteInput {
    text: String,
}

#[tauri::command]
pub fn is_semantic_terminal_paste_safe(
    request: PrivateSemanticTerminalRequest<InspectSemanticTerminalPasteInput>,
    service: State<'_, SemanticTerminalService>,
) -> Result<bool, SemanticTerminalError> {
    validate_request(&request)?;
    service.inspect_paste(&request.activation, &request.input.text)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SemanticTerminalPublicationStatsInput {
    terminal_id: String,
}

#[tauri::command]
pub fn get_semantic_terminal_publication_stats(
    request: PrivateSemanticTerminalRequest<SemanticTerminalPublicationStatsInput>,
    service: State<'_, SemanticTerminalService>,
) -> Result<JsonValue, SemanticTerminalError> {
    validate_request(&request)?;
    service.publication_stats(&request.activation, &request.input.terminal_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetSemanticTerminalAppMemoryInput {}

#[tauri::command]
pub fn get_semantic_terminal_app_memory(
    request: PrivateSemanticTerminalRequest<GetSemanticTerminalAppMemoryInput>,
    service: State<'_, SemanticTerminalService>,
) -> Result<JsonValue, SemanticTerminalError> {
    validate_request(&request)?;
    service.app_memory(&request.activation)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseSemanticTerminalActivationInput {}

#[tauri::command]
pub fn release_semantic_terminal_activation(
    request: PrivateSemanticTerminalRequest<ReleaseSemanticTerminalActivationInput>,
    service: State<'_, SemanticTerminalService>,
) -> Result<usize, SemanticTerminalError> {
    validate_request(&request)?;
    service.release_activation(&request.activation)
}
