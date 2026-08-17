//! Private Tauri transport for the public Skill Installation service.

use serde::Deserialize;
use tauri::State;

use shipctl_core::skill_installation::{
    SkillInstallationActor, SkillInstallationError, SkillInstallationService,
    SkillInstallationState, SKILL_INSTALLATION_INVALID_REQUEST,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateSkillInstallationRequest<Input> {
    activation: SkillInstallationActor,
    correlation_id: String,
    input: Input,
}

fn validate_request<Input>(
    request: &PrivateSkillInstallationRequest<Input>,
) -> Result<(), SkillInstallationError> {
    if request.correlation_id.trim().is_empty()
        || request.correlation_id.chars().any(char::is_control)
    {
        Err(SkillInstallationError {
            code: SKILL_INSTALLATION_INVALID_REQUEST.to_string(),
            message: "The skill installation correlation identity is invalid".to_string(),
            retryable: false,
        })
    } else {
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectSkillInstallationsInput {
    project_id: String,
    skill_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallSkillSourceInput {
    project_id: String,
    skill_id: String,
    markdown: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveSkillInstallationInput {
    project_id: String,
    skill_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseSkillInstallationActivationInput {}

#[tauri::command]
pub fn inspect_skill_installations(
    request: PrivateSkillInstallationRequest<InspectSkillInstallationsInput>,
    service: State<'_, SkillInstallationService>,
) -> Result<Vec<SkillInstallationState>, SkillInstallationError> {
    validate_request(&request)?;
    service.inspect(
        &request.activation,
        &request.input.project_id,
        &request.input.skill_ids,
    )
}

#[tauri::command]
pub fn install_skill_source(
    request: PrivateSkillInstallationRequest<InstallSkillSourceInput>,
    service: State<'_, SkillInstallationService>,
) -> Result<(), SkillInstallationError> {
    validate_request(&request)?;
    service.install(
        &request.activation,
        &request.input.project_id,
        &request.input.skill_id,
        &request.input.markdown,
    )
}

#[tauri::command]
pub fn remove_skill_installation(
    request: PrivateSkillInstallationRequest<RemoveSkillInstallationInput>,
    service: State<'_, SkillInstallationService>,
) -> Result<(), SkillInstallationError> {
    validate_request(&request)?;
    service.remove(
        &request.activation,
        &request.input.project_id,
        &request.input.skill_id,
    )
}

#[tauri::command]
pub fn release_skill_installation_activation(
    request: PrivateSkillInstallationRequest<ReleaseSkillInstallationActivationInput>,
    service: State<'_, SkillInstallationService>,
) -> Result<(), SkillInstallationError> {
    validate_request(&request)?;
    service.release_activation(&request.activation)
}
