//! Private Tauri transport for the public Processes semantic service.

use serde::Deserialize;
use tauri::State;

use shipctl_core::processes::{
    CommandInspection, InspectCommandInput, InspectListeningProcessesInput,
    ListeningProcessInspection, ProcessesActor, ProcessesError, ProcessesService,
    TerminateInspectedProcessInput, TerminatedProcess, PROCESSES_INVALID_REQUEST,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateProcessesRequest<Input> {
    activation: ProcessesActor,
    correlation_id: String,
    input: Input,
}

fn validate_request<Input>(request: &PrivateProcessesRequest<Input>) -> Result<(), ProcessesError> {
    if request.correlation_id.trim().is_empty()
        || request.correlation_id.chars().any(char::is_control)
    {
        Err(ProcessesError {
            code: PROCESSES_INVALID_REQUEST.to_string(),
            message: "The process correlation identity is invalid".to_string(),
            retryable: false,
        })
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn inspect_listening_processes(
    request: PrivateProcessesRequest<InspectListeningProcessesInput>,
    service: State<'_, ProcessesService>,
) -> Result<Vec<ListeningProcessInspection>, ProcessesError> {
    validate_request(&request)?;
    service.inspect_listening_processes(&request.activation, request.input)
}

#[tauri::command]
pub fn terminate_inspected_process(
    request: PrivateProcessesRequest<TerminateInspectedProcessInput>,
    service: State<'_, ProcessesService>,
) -> Result<TerminatedProcess, ProcessesError> {
    validate_request(&request)?;
    service.terminate_inspected_process(&request.activation, request.input)
}

#[tauri::command]
pub fn inspect_process_command(
    request: PrivateProcessesRequest<InspectCommandInput>,
    service: State<'_, ProcessesService>,
) -> Result<CommandInspection, ProcessesError> {
    validate_request(&request)?;
    service.inspect_command(&request.activation, request.input)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseProcessInspectionsInput {}

#[tauri::command]
pub fn release_process_inspections(
    request: PrivateProcessesRequest<ReleaseProcessInspectionsInput>,
    service: State<'_, ProcessesService>,
) -> Result<usize, ProcessesError> {
    validate_request(&request)?;
    service.release_activation(&request.activation)
}
