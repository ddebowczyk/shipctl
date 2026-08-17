//! Private Tauri transport for the public Credential Store semantic service.

use serde::Deserialize;
use tauri::State;

use shipctl_core::credentials::{
    CredentialStoreActor, CredentialStoreError, CredentialStoreService,
    CREDENTIAL_STORE_INVALID_REQUEST,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateCredentialStoreRequest<Input> {
    activation: CredentialStoreActor,
    correlation_id: String,
    input: Input,
}

fn validate_request<Input>(
    request: &PrivateCredentialStoreRequest<Input>,
) -> Result<(), CredentialStoreError> {
    if request.correlation_id.trim().is_empty()
        || request.correlation_id.chars().any(char::is_control)
    {
        Err(CredentialStoreError {
            code: CREDENTIAL_STORE_INVALID_REQUEST.to_string(),
            message: "The credential-store correlation identity is invalid".to_string(),
            retryable: false,
        })
    } else {
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectCredentialInput {
    credential_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveCredentialInput {
    credential_id: String,
    secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmptyCredentialStoreInput {}

#[tauri::command]
pub fn inspect_credential(
    request: PrivateCredentialStoreRequest<InspectCredentialInput>,
    service: State<'_, CredentialStoreService>,
) -> Result<bool, CredentialStoreError> {
    validate_request(&request)?;
    service
        .has_credential(&request.activation, request.input.credential_id)
        .map(|status| status.configured)
}

#[tauri::command]
pub fn save_credential(
    request: PrivateCredentialStoreRequest<SaveCredentialInput>,
    service: State<'_, CredentialStoreService>,
) -> Result<(), CredentialStoreError> {
    validate_request(&request)?;
    service
        .save_credential(
            &request.activation,
            request.input.credential_id,
            request.input.secret,
        )
        .map(|_| ())
}

#[tauri::command]
pub fn delete_credential(
    request: PrivateCredentialStoreRequest<InspectCredentialInput>,
    service: State<'_, CredentialStoreService>,
) -> Result<(), CredentialStoreError> {
    validate_request(&request)?;
    service
        .delete_credential(&request.activation, request.input.credential_id)
        .map(|_| ())
}

#[tauri::command]
pub fn release_credential_store_activation(
    request: PrivateCredentialStoreRequest<EmptyCredentialStoreInput>,
    service: State<'_, CredentialStoreService>,
) -> Result<bool, CredentialStoreError> {
    validate_request(&request)?;
    service.release_activation(&request.activation)
}
