//! Private Tauri transport for the public Project Documents semantic service.

use serde::Deserialize;
use tauri::State;

use shipctl_core::project_documents::{
    DiscoverProjectDocumentsInput, ProjectDocument, ProjectDocumentsActor, ProjectDocumentsError,
    ProjectDocumentsService, ReadProjectDocumentInput, WriteProjectDocumentInput,
    PROJECT_DOCUMENTS_INVALID_REQUEST,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateProjectDocumentsRequest<Input> {
    activation: ProjectDocumentsActor,
    correlation_id: String,
    input: Input,
}

fn validate_request<Input>(
    request: &PrivateProjectDocumentsRequest<Input>,
) -> Result<(), ProjectDocumentsError> {
    if request.correlation_id.trim().is_empty()
        || request.correlation_id.chars().any(char::is_control)
    {
        Err(ProjectDocumentsError {
            code: PROJECT_DOCUMENTS_INVALID_REQUEST.to_string(),
            message: "The project document correlation identity is invalid".to_string(),
            retryable: false,
        })
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn discover_project_documents(
    request: PrivateProjectDocumentsRequest<DiscoverProjectDocumentsInput>,
    service: State<'_, ProjectDocumentsService>,
) -> Result<Vec<ProjectDocument>, ProjectDocumentsError> {
    validate_request(&request)?;
    service.discover_documents(&request.activation, request.input)
}

#[tauri::command]
pub fn read_project_document(
    request: PrivateProjectDocumentsRequest<ReadProjectDocumentInput>,
    service: State<'_, ProjectDocumentsService>,
) -> Result<ProjectDocument, ProjectDocumentsError> {
    validate_request(&request)?;
    service.read_document(&request.activation, request.input)
}

#[tauri::command]
pub fn write_project_document(
    request: PrivateProjectDocumentsRequest<WriteProjectDocumentInput>,
    service: State<'_, ProjectDocumentsService>,
) -> Result<ProjectDocument, ProjectDocumentsError> {
    validate_request(&request)?;
    service.write_document(&request.activation, request.input)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseProjectDocumentsActivationInput {}

#[tauri::command]
pub fn release_project_documents_activation(
    request: PrivateProjectDocumentsRequest<ReleaseProjectDocumentsActivationInput>,
    service: State<'_, ProjectDocumentsService>,
) -> Result<bool, ProjectDocumentsError> {
    validate_request(&request)?;
    service.release_activation(&request.activation)
}
