//! Generic native authority for assistant process and recovery sessions.
//!
//! Product launch policy, transcript interpretation, model discovery, and
//! configuration belong to trusted TypeScript plugins. This module owns only
//! durable records, terminal lifetime, admission-scoped resources, and the
//! process boundary those plugins are granted.

#![forbid(unsafe_code)]

mod manifest;
mod resources;
mod snapshot;

use crate::state::DurableWriteBarrier;
use crate::terminal_host::TerminalColorTheme;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::terminal_host::{
    default_terminal_driver_id, TerminalId, TerminalLaunchRequest, TerminalLaunchTarget,
    TerminalMetadata, TerminalOwner, TerminalService,
};

pub use resources::{
    AssistantResourceExecuteCompletion, AssistantResourceExecuteInput,
    AssistantResourceExecuteResult, AssistantResourceFile, AssistantResourceReadInput,
    AssistantResourceReadRequest, AssistantResourceReadResult, AssistantResourceWriteInput,
};
pub use snapshot::AssistantSnapshotProvider;

const MAX_LABEL_LENGTH: usize = 256;
const MAX_MODEL_LENGTH: usize = 256;
const MAX_PROVIDER_LENGTH: usize = 128;
const MAX_MODE_LENGTH: usize = 128;
const MAX_SESSION_ID_LENGTH: usize = 512;
const MAX_PROGRAM_LENGTH: usize = 128;
const MAX_ARGUMENTS: usize = 128;
const MAX_ARGUMENT_LENGTH: usize = 4_096;

pub const ASSISTANT_LAUNCH_TRANSPORT_FAILED: &str = "assistant-launch.transport-failed";
pub const ASSISTANT_LAUNCH_DENIED: &str = "assistant-launch.denied";
pub const ASSISTANT_LAUNCH_INVALID_REQUEST: &str = "assistant-launch.invalid-request";
pub const ASSISTANT_LAUNCH_LAUNCH_FAILED: &str = "assistant-launch.launch-failed";
pub const ASSISTANT_LAUNCH_SESSION_NOT_FOUND: &str = "assistant-launch.session-not-found";
pub const ASSISTANT_LAUNCH_SESSION_NOT_RECOVERABLE: &str =
    "assistant-launch.session-not-recoverable";
pub const ASSISTANT_LAUNCH_ACTIVATION_DISPOSED: &str = "assistant-launch.activation-disposed";

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub enum AssistantLaunchGrant {
    #[serde(rename = "assistant.launch")]
    Launch,
    #[serde(rename = "assistant.session-record")]
    SessionRecord,
    #[serde(rename = "assistant.resource.read")]
    ResourceRead,
    #[serde(rename = "assistant.resource.write")]
    ResourceWrite,
    #[serde(rename = "assistant.resource.execute")]
    ResourceExecute,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantLaunchActor {
    pub module_id: String,
    pub activation_id: String,
    #[serde(default)]
    pub effective_grants: BTreeSet<AssistantLaunchGrant>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantLaunchError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureState {
    Pending,
    Assigned,
    Ready,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSessionRecord {
    pub record_id: String,
    /// Opaque plugin policy identity. Native code must never branch on it.
    pub provider: String,
    /// Kept private by the frontend adapter and substituted only at resume.
    pub provider_session_id: Option<String>,
    pub launch_repo_path: String,
    pub placement_project_path: String,
    pub label: String,
    /// Opaque plugin policy data, retained for UI and restore policy.
    pub session_mode: String,
    pub model: Option<String>,
    pub capture_state: CaptureState,
    /// Records are only armed after a confirmed normal shutdown.
    #[serde(default)]
    pub restore_on_next_launch: bool,
    pub started_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareAssistantSession {
    pub provider: String,
    pub launch_repo_path: String,
    pub placement_project_path: String,
    pub label: String,
    pub session_mode: String,
    pub model: Option<String>,
    #[serde(default)]
    pub initial_session_identity: Option<String>,
}

#[derive(Default)]
struct RegistryState {
    manifest: manifest::AssistantSessionManifest,
    preserving_shutdown: bool,
    startup_warning: Option<String>,
}

/// Backend-owned manifest for assistant tabs that can survive a normal relaunch.
///
/// Every mutation is persisted under the state lock, so a successful API call
/// means the durable manifest is already up to date.
pub struct AssistantSessionRegistry {
    path: PathBuf,
    state: Mutex<RegistryState>,
    durable_writes: DurableWriteBarrier,
}

impl AssistantSessionRegistry {
    pub fn new(path: PathBuf) -> Self {
        Self::new_at(path)
    }

    pub fn new_with_barrier(path: PathBuf, durable_writes: DurableWriteBarrier) -> Self {
        Self::new_at_with_barrier(path, durable_writes)
    }

    pub fn prepare(
        &self,
        request: PrepareAssistantSession,
    ) -> Result<AssistantSessionRecord, String> {
        let launch_repo_path = canonical_directory(&request.launch_repo_path, "launch directory")?;
        let placement_project_path =
            canonical_directory(&request.placement_project_path, "placement project")?;
        let provider = required_text(
            request.provider,
            "Assistant policy identity",
            MAX_PROVIDER_LENGTH,
        )?;
        let session_mode = required_text(
            request.session_mode,
            "Assistant session mode",
            MAX_MODE_LENGTH,
        )?;
        let label = required_text(request.label, "Session label", MAX_LABEL_LENGTH)?;
        let model = request
            .model
            .map(|model| required_text(model, "Model", MAX_MODEL_LENGTH))
            .transpose()?;
        let initial_session_identity = request
            .initial_session_identity
            .map(|identity| {
                required_text(
                    identity,
                    "Assistant session identity",
                    MAX_SESSION_ID_LENGTH,
                )
            })
            .transpose()?;
        let now = now_epoch_seconds();
        let record = AssistantSessionRecord {
            record_id: Uuid::new_v4().to_string(),
            provider,
            provider_session_id: initial_session_identity.clone(),
            launch_repo_path,
            placement_project_path,
            label,
            session_mode,
            model,
            capture_state: if initial_session_identity.is_some() {
                CaptureState::Assigned
            } else {
                CaptureState::Pending
            },
            restore_on_next_launch: false,
            started_at: now,
            updated_at: now,
        };
        self.mutate(|state| {
            state.manifest.sessions.push(record.clone());
            Ok(record.clone())
        })
    }

    pub fn confirm_capture(
        &self,
        record_id: &str,
        provider_session_id: String,
    ) -> Result<AssistantSessionRecord, String> {
        let provider_session_id = required_text(
            provider_session_id,
            "Assistant session identity",
            MAX_SESSION_ID_LENGTH,
        )?;
        self.mutate(|state| {
            let record = find_record_mut(state, record_id)?;
            if record.capture_state != CaptureState::Pending
                && !(record.capture_state == CaptureState::Assigned
                    && record.provider_session_id.as_deref() == Some(provider_session_id.as_str()))
            {
                return Err("Assistant session capture is no longer pending".to_string());
            }
            record.provider_session_id = Some(provider_session_id.clone());
            record.capture_state = CaptureState::Ready;
            record.updated_at = now_epoch_seconds();
            Ok(record.clone())
        })
    }

    pub fn mark_capture_failed(&self, record_id: &str) -> Result<AssistantSessionRecord, String> {
        self.mutate(|state| {
            let record = find_record_mut(state, record_id)?;
            if record.capture_state == CaptureState::Ready {
                return Err("A ready assistant session cannot be marked failed".to_string());
            }
            record.capture_state = CaptureState::Failed;
            record.updated_at = now_epoch_seconds();
            Ok(record.clone())
        })
    }

    pub fn update_placement(
        &self,
        record_id: &str,
        placement_project_path: String,
    ) -> Result<AssistantSessionRecord, String> {
        let placement_project_path =
            canonical_directory(&placement_project_path, "placement project")?;
        self.mutate(|state| {
            let record = find_record_mut(state, record_id)?;
            record.placement_project_path = placement_project_path.clone();
            record.updated_at = now_epoch_seconds();
            Ok(record.clone())
        })
    }

    pub fn update_label(
        &self,
        record_id: &str,
        label: String,
    ) -> Result<AssistantSessionRecord, String> {
        let label = required_text(label, "Session label", MAX_LABEL_LENGTH)?;
        self.mutate(|state| {
            let record = find_record_mut(state, record_id)?;
            record.label = label.clone();
            record.updated_at = now_epoch_seconds();
            Ok(record.clone())
        })
    }

    pub fn discard(&self, record_id: &str) -> Result<(), String> {
        self.mutate(|state| {
            let previous_len = state.manifest.sessions.len();
            state
                .manifest
                .sessions
                .retain(|record| record.record_id != record_id);
            if state.manifest.sessions.len() == previous_len {
                return Ok(());
            }
            Ok(())
        })
    }

    pub fn list_restorable(&self) -> Vec<AssistantSessionRecord> {
        self.state
            .lock()
            .map(|state| {
                state
                    .manifest
                    .sessions
                    .iter()
                    .filter(|record| {
                        matches!(
                            record.capture_state,
                            CaptureState::Assigned | CaptureState::Ready
                        ) && record.provider_session_id.is_some()
                            && record.restore_on_next_launch
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn get_restorable(&self, record_id: &str) -> Result<AssistantSessionRecord, String> {
        self.state
            .lock()
            .map_err(|_| "Assistant session registry lock was poisoned".to_string())?
            .manifest
            .sessions
            .iter()
            .find(|record| {
                record.record_id == record_id
                    && matches!(
                        record.capture_state,
                        CaptureState::Assigned | CaptureState::Ready
                    )
                    && record.provider_session_id.is_some()
                    && record.restore_on_next_launch
            })
            .cloned()
            .ok_or_else(|| "Assistant restore record is not ready".to_string())
    }

    /// Atomically disarm one record before attempting a restore spawn.
    pub fn claim_for_restore(&self, record_id: &str) -> Result<AssistantSessionRecord, String> {
        let _durable_update = self.durable_writes.enter_update()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Assistant session registry lock was poisoned".to_string())?;
        if state.preserving_shutdown {
            return Err("Assistant restore records are frozen during shutdown".to_string());
        }
        let record = find_record_mut(&mut state, record_id)?;
        if !matches!(
            record.capture_state,
            CaptureState::Assigned | CaptureState::Ready
        ) || record.provider_session_id.is_none()
            || !record.restore_on_next_launch
        {
            return Err("Assistant restore record is not ready".to_string());
        }
        let previous_updated_at = record.updated_at;
        record.restore_on_next_launch = false;
        record.updated_at = now_epoch_seconds();
        let claimed = record.clone();
        if let Err(error) = manifest::write_atomically(&self.path, &state.manifest) {
            let record = find_record_mut(&mut state, record_id)?;
            record.restore_on_next_launch = true;
            record.updated_at = previous_updated_at;
            return Err(error);
        }
        Ok(claimed)
    }

    pub fn rearm_for_restore(&self, record_id: &str) -> Result<(), String> {
        self.mutate(|state| {
            let record = find_record_mut(state, record_id)?;
            if !matches!(
                record.capture_state,
                CaptureState::Assigned | CaptureState::Ready
            ) || record.provider_session_id.is_none()
            {
                return Err("Assistant restore record is not ready".to_string());
            }
            record.restore_on_next_launch = true;
            record.updated_at = now_epoch_seconds();
            Ok(())
        })
    }

    pub fn begin_preserving_shutdown(&self) -> Result<(), String> {
        let _durable_update = self.durable_writes.enter_update()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Assistant session registry lock was poisoned".to_string())?;
        state.manifest.sessions.retain(|record| {
            matches!(
                record.capture_state,
                CaptureState::Assigned | CaptureState::Ready
            ) && record.provider_session_id.is_some()
        });
        for record in &mut state.manifest.sessions {
            record.restore_on_next_launch = true;
            record.updated_at = now_epoch_seconds();
        }
        state.preserving_shutdown = true;
        if let Err(error) = manifest::write_atomically(&self.path, &state.manifest) {
            state.preserving_shutdown = false;
            return Err(error);
        }
        Ok(())
    }

    pub fn take_startup_warning(&self) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|mut state| state.startup_warning.take())
    }

    fn new_at(path: PathBuf) -> Self {
        Self::new_at_with_barrier(path, DurableWriteBarrier::default())
    }

    fn new_at_with_barrier(path: PathBuf, durable_writes: DurableWriteBarrier) -> Self {
        let mut startup_warning = None;
        let manifest = if path.exists() {
            match manifest::read(&path) {
                Ok(manifest) => manifest,
                Err(error) => {
                    let quarantine_reason =
                        if error.contains("newer") || error.contains("Unsupported") {
                            "unsupported"
                        } else {
                            "corrupt"
                        };
                    match manifest::quarantine(&path, quarantine_reason) {
                        Ok(quarantined) => {
                            startup_warning = Some(format!(
                                "Saved assistant sessions were isolated because the restore manifest could not be read ({error}). Backup: {}",
                                quarantined.display()
                            ));
                        }
                        Err(quarantine_error) => {
                            startup_warning = Some(format!(
                                "Saved assistant sessions could not be read ({error}) or isolated ({quarantine_error})."
                            ));
                        }
                    }
                    manifest::AssistantSessionManifest::default()
                }
            }
        } else {
            manifest::AssistantSessionManifest::default()
        };
        Self {
            path,
            durable_writes,
            state: Mutex::new(RegistryState {
                manifest,
                preserving_shutdown: false,
                startup_warning,
            }),
        }
    }

    fn mutate<T>(
        &self,
        mutation: impl FnOnce(&mut RegistryState) -> Result<T, String>,
    ) -> Result<T, String> {
        let _durable_update = self.durable_writes.enter_update()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Assistant session registry lock was poisoned".to_string())?;
        if state.preserving_shutdown {
            return Err("Assistant restore records are frozen during shutdown".to_string());
        }
        let result = mutation(&mut state)?;
        manifest::write_atomically(&self.path, &state.manifest)?;
        Ok(result)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum AssistantProcessPlaceholder {
    CapturedSessionId,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum AssistantProcessArgument {
    Text(String),
    Placeholder(AssistantProcessPlaceholder),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantProcessLaunch {
    pub program: String,
    pub arguments: Vec<AssistantProcessArgument>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartAssistantSessionInput {
    pub module_session_id: String,
    pub provider: String,
    pub launch_repo_path: String,
    pub placement_project_path: String,
    pub label: String,
    pub session_mode: String,
    pub model: Option<String>,
    pub launch: AssistantProcessLaunch,
    #[serde(default)]
    pub initial_session_identity: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    pub color_theme: TerminalColorTheme,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedAssistantSession {
    pub terminal_id: String,
    pub record: AssistantSessionRecord,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResumeAssistantSessionInput {
    pub record_id: String,
    pub launch: AssistantProcessLaunch,
    pub module_session_id: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    pub color_theme: TerminalColorTheme,
}

#[derive(Default)]
struct AssistantLaunchProviderState {
    released_activations: HashSet<(String, String)>,
}

struct AssistantLaunchServiceInner {
    registry: AssistantSessionRegistry,
    terminals: TerminalService,
    state: Mutex<AssistantLaunchProviderState>,
}

/// Tauri-free assistant launch and recovery authority.
#[derive(Clone)]
pub struct AssistantLaunchService {
    inner: Arc<AssistantLaunchServiceInner>,
}

impl AssistantLaunchService {
    pub fn new(
        terminals: TerminalService,
        manifest_path: PathBuf,
        durable_writes: DurableWriteBarrier,
    ) -> Self {
        Self {
            inner: Arc::new(AssistantLaunchServiceInner {
                registry: AssistantSessionRegistry::new_with_barrier(manifest_path, durable_writes),
                terminals,
                state: Mutex::new(AssistantLaunchProviderState::default()),
            }),
        }
    }

    pub fn start_session(
        &self,
        actor: &AssistantLaunchActor,
        request: StartAssistantSessionInput,
    ) -> Result<StartedAssistantSession, AssistantLaunchError> {
        self.authorize(actor, AssistantLaunchGrant::Launch)?;
        validate_terminal_request(&request.module_session_id, request.cols, request.rows)?;
        let launch = materialize_new_launch(request.launch).map_err(invalid_or_transport_error)?;
        let prepared = self
            .inner
            .registry
            .prepare(PrepareAssistantSession {
                provider: request.provider,
                launch_repo_path: request.launch_repo_path,
                placement_project_path: request.placement_project_path,
                label: request.label,
                session_mode: request.session_mode,
                model: request.model,
                initial_session_identity: request.initial_session_identity,
            })
            .map_err(invalid_or_transport_error)?;
        let terminal_id = match self.spawn_terminal(
            &prepared,
            actor.module_id.clone(),
            request.module_session_id,
            request.env,
            request.cols,
            request.rows,
            request.color_theme,
            launch,
        ) {
            Ok(terminal_id) => terminal_id,
            Err(error) => {
                let _ = self.inner.registry.discard(&prepared.record_id);
                return Err(AssistantLaunchError {
                    code: ASSISTANT_LAUNCH_LAUNCH_FAILED.to_string(),
                    message: format!("Could not start assistant process: {error}"),
                    retryable: false,
                });
            }
        };
        Ok(StartedAssistantSession {
            terminal_id: terminal_id.to_string(),
            record: prepared,
        })
    }

    pub fn resume_session(
        &self,
        actor: &AssistantLaunchActor,
        request: ResumeAssistantSessionInput,
    ) -> Result<StartedAssistantSession, AssistantLaunchError> {
        self.authorize(actor, AssistantLaunchGrant::Launch)?;
        validate_terminal_request(&request.module_session_id, request.cols, request.rows)?;
        let candidate = self
            .inner
            .registry
            .get_restorable(&request.record_id)
            .map_err(invalid_or_transport_error)?;
        let provider_session_id = candidate.provider_session_id.as_deref().ok_or_else(|| {
            invalid_or_transport_error("Assistant restore record is not ready".to_string())
        })?;
        let launch = materialize_resume_launch(request.launch, provider_session_id)
            .map_err(invalid_or_transport_error)?;
        let record = self
            .inner
            .registry
            .claim_for_restore(&request.record_id)
            .map_err(invalid_or_transport_error)?;
        let terminal_id = match self.spawn_terminal(
            &record,
            actor.module_id.clone(),
            request.module_session_id,
            request.env,
            request.cols,
            request.rows,
            request.color_theme,
            launch,
        ) {
            Ok(terminal_id) => terminal_id,
            Err(error) => {
                if let Err(rearm_error) = self.inner.registry.rearm_for_restore(&record.record_id) {
                    return Err(AssistantLaunchError {
                        code: ASSISTANT_LAUNCH_LAUNCH_FAILED.to_string(),
                        message: format!(
                            "Could not resume assistant process: {error}. The saved session could not be re-armed for retry: {rearm_error}"
                        ),
                        retryable: false,
                    });
                }
                return Err(AssistantLaunchError {
                    code: ASSISTANT_LAUNCH_LAUNCH_FAILED.to_string(),
                    message: format!("Could not resume assistant process: {error}"),
                    retryable: false,
                });
            }
        };
        Ok(StartedAssistantSession {
            terminal_id: terminal_id.to_string(),
            record,
        })
    }

    pub fn record_session_identity(
        &self,
        actor: &AssistantLaunchActor,
        record_id: &str,
        provider_session_id: String,
    ) -> Result<AssistantSessionRecord, AssistantLaunchError> {
        self.authorize(actor, AssistantLaunchGrant::SessionRecord)?;
        self.inner
            .registry
            .confirm_capture(record_id, provider_session_id)
            .map_err(invalid_or_transport_error)
    }

    pub fn mark_session_identity_failed(
        &self,
        actor: &AssistantLaunchActor,
        record_id: &str,
    ) -> Result<AssistantSessionRecord, AssistantLaunchError> {
        self.authorize(actor, AssistantLaunchGrant::SessionRecord)?;
        self.inner
            .registry
            .mark_capture_failed(record_id)
            .map_err(invalid_or_transport_error)
    }

    pub fn record_session_placement(
        &self,
        actor: &AssistantLaunchActor,
        record_id: &str,
        placement_project_path: String,
    ) -> Result<AssistantSessionRecord, AssistantLaunchError> {
        self.authorize(actor, AssistantLaunchGrant::SessionRecord)?;
        self.inner
            .registry
            .update_placement(record_id, placement_project_path)
            .map_err(invalid_or_transport_error)
    }

    pub fn record_session_label(
        &self,
        actor: &AssistantLaunchActor,
        record_id: &str,
        label: String,
    ) -> Result<AssistantSessionRecord, AssistantLaunchError> {
        self.authorize(actor, AssistantLaunchGrant::SessionRecord)?;
        self.inner
            .registry
            .update_label(record_id, label)
            .map_err(invalid_or_transport_error)
    }

    pub fn discard_session(
        &self,
        actor: &AssistantLaunchActor,
        record_id: &str,
    ) -> Result<(), AssistantLaunchError> {
        self.authorize(actor, AssistantLaunchGrant::SessionRecord)?;
        self.inner
            .registry
            .discard(record_id)
            .map_err(invalid_or_transport_error)
    }

    pub fn rearm_session(
        &self,
        actor: &AssistantLaunchActor,
        record_id: &str,
    ) -> Result<(), AssistantLaunchError> {
        self.authorize(actor, AssistantLaunchGrant::SessionRecord)?;
        self.inner
            .registry
            .rearm_for_restore(record_id)
            .map_err(invalid_or_transport_error)
    }

    pub fn inspect_restorable_sessions(
        &self,
        actor: &AssistantLaunchActor,
    ) -> Result<Vec<AssistantSessionRecord>, AssistantLaunchError> {
        self.authorize(actor, AssistantLaunchGrant::SessionRecord)?;
        Ok(self.inner.registry.list_restorable())
    }

    pub fn take_startup_warning(
        &self,
        actor: &AssistantLaunchActor,
    ) -> Result<Option<String>, AssistantLaunchError> {
        self.authorize(actor, AssistantLaunchGrant::SessionRecord)?;
        Ok(self.inner.registry.take_startup_warning())
    }

    pub fn prepare_for_shutdown(
        &self,
        actor: &AssistantLaunchActor,
    ) -> Result<(), AssistantLaunchError> {
        self.authorize(actor, AssistantLaunchGrant::SessionRecord)?;
        self.inner
            .registry
            .begin_preserving_shutdown()
            .map_err(invalid_or_transport_error)
    }

    pub fn read_resource(
        &self,
        actor: &AssistantLaunchActor,
        input: AssistantResourceReadInput,
    ) -> Result<AssistantResourceReadResult, AssistantLaunchError> {
        self.authorize(actor, AssistantLaunchGrant::ResourceRead)?;
        resources::read(input).map_err(invalid_or_transport_error)
    }

    pub fn write_resource(
        &self,
        actor: &AssistantLaunchActor,
        input: AssistantResourceWriteInput,
    ) -> Result<(), AssistantLaunchError> {
        self.authorize(actor, AssistantLaunchGrant::ResourceWrite)?;
        resources::write(input).map_err(invalid_or_transport_error)
    }

    pub fn execute_resource(
        &self,
        actor: &AssistantLaunchActor,
        input: AssistantResourceExecuteInput,
    ) -> Result<AssistantResourceExecuteResult, AssistantLaunchError> {
        self.authorize(actor, AssistantLaunchGrant::ResourceExecute)?;
        resources::execute(input).map_err(invalid_or_transport_error)
    }

    pub fn release_activation(
        &self,
        actor: &AssistantLaunchActor,
    ) -> Result<bool, AssistantLaunchError> {
        validate_actor(actor)?;
        let mut state = self.inner.state.lock().map_err(|_| AssistantLaunchError {
            code: ASSISTANT_LAUNCH_TRANSPORT_FAILED.to_string(),
            message: "Assistant activation state is unavailable".to_string(),
            retryable: false,
        })?;
        Ok(state
            .released_activations
            .insert((actor.module_id.clone(), actor.activation_id.clone())))
    }

    fn authorize(
        &self,
        actor: &AssistantLaunchActor,
        grant: AssistantLaunchGrant,
    ) -> Result<(), AssistantLaunchError> {
        validate_actor(actor)?;
        if !actor.effective_grants.contains(&grant) {
            return Err(denied_error());
        }
        let state = self.inner.state.lock().map_err(|_| AssistantLaunchError {
            code: ASSISTANT_LAUNCH_TRANSPORT_FAILED.to_string(),
            message: "Assistant activation state is unavailable".to_string(),
            retryable: false,
        })?;
        if state
            .released_activations
            .contains(&(actor.module_id.clone(), actor.activation_id.clone()))
        {
            return Err(AssistantLaunchError {
                code: ASSISTANT_LAUNCH_ACTIVATION_DISPOSED.to_string(),
                message: "The assistant activation is no longer active".to_string(),
                retryable: false,
            });
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_terminal(
        &self,
        record: &AssistantSessionRecord,
        module_id: String,
        module_session_id: String,
        environment: HashMap<String, String>,
        columns: u16,
        rows: u16,
        color_theme: TerminalColorTheme,
        launch: MaterializedProcessLaunch,
    ) -> Result<TerminalId, String> {
        self.inner
            .terminals
            .spawn(TerminalLaunchRequest {
                driver_id: default_terminal_driver_id(),
                target: TerminalLaunchTarget::Program {
                    program: launch.program.clone().into(),
                    argv: launch.arguments,
                },
                cwd: record.launch_repo_path.clone().into(),
                environment,
                columns,
                rows,
                color_theme,
                metadata: TerminalMetadata {
                    label: record.label.clone(),
                    cwd: record.launch_repo_path.clone().into(),
                    project_path: Some(record.placement_project_path.clone().into()),
                    display_command: launch.program,
                    created_at_ms: now_epoch_millis(),
                    owner: TerminalOwner::Module {
                        module_id,
                        owner_key: format!("assistants:{}", record.provider),
                        module_session_id,
                    },
                    owner_metadata: Some(
                        serde_json::to_value(record)
                            .expect("assistant session records are serializable"),
                    ),
                    presentation: None,
                },
            })
            .map(|descriptor| descriptor.id)
            .map_err(|error| error.to_string())
    }
}

#[derive(Clone, Debug)]
struct MaterializedProcessLaunch {
    program: String,
    arguments: Vec<String>,
}

fn materialize_new_launch(
    launch: AssistantProcessLaunch,
) -> Result<MaterializedProcessLaunch, String> {
    validate_program(&launch.program)?;
    if launch.arguments.len() > MAX_ARGUMENTS {
        return Err("Assistant process launch has too many arguments".to_string());
    }
    let mut arguments = Vec::with_capacity(launch.arguments.len());
    for argument in launch.arguments {
        match argument {
            AssistantProcessArgument::Text(argument) => {
                arguments.push(validate_argument(argument)?);
            }
            AssistantProcessArgument::Placeholder(_) => {
                return Err(
                    "A new assistant process cannot use a captured session identity".to_string(),
                );
            }
        }
    }
    Ok(MaterializedProcessLaunch {
        program: launch.program,
        arguments,
    })
}

fn materialize_resume_launch(
    launch: AssistantProcessLaunch,
    provider_session_id: &str,
) -> Result<MaterializedProcessLaunch, String> {
    validate_program(&launch.program)?;
    if launch.arguments.len() > MAX_ARGUMENTS {
        return Err("Assistant process launch has too many arguments".to_string());
    }
    let mut found_identity_placeholder = false;
    let mut arguments = Vec::with_capacity(launch.arguments.len());
    for argument in launch.arguments {
        match argument {
            AssistantProcessArgument::Text(argument) => {
                arguments.push(validate_argument(argument)?)
            }
            AssistantProcessArgument::Placeholder(
                AssistantProcessPlaceholder::CapturedSessionId,
            ) => {
                found_identity_placeholder = true;
                arguments.push(provider_session_id.to_string());
            }
        }
    }
    if !found_identity_placeholder {
        return Err(
            "Assistant resume launch must use a captured session identity placeholder".to_string(),
        );
    }
    Ok(MaterializedProcessLaunch {
        program: launch.program,
        arguments,
    })
}

fn validate_program(value: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= MAX_PROGRAM_LENGTH
        && value.chars().enumerate().all(|(index, character)| {
            (index == 0 && character.is_ascii_alphanumeric())
                || (index > 0
                    && (character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')))
        });
    if valid {
        Ok(())
    } else {
        Err("Assistant process program is invalid".to_string())
    }
}

fn validate_argument(value: String) -> Result<String, String> {
    if value.len() > MAX_ARGUMENT_LENGTH || value.chars().any(char::is_control) {
        Err("Assistant process argument is invalid".to_string())
    } else {
        Ok(value)
    }
}

fn validate_actor(actor: &AssistantLaunchActor) -> Result<(), AssistantLaunchError> {
    if actor.module_id.trim().is_empty()
        || actor.activation_id.trim().is_empty()
        || actor.module_id.chars().any(char::is_control)
        || actor.activation_id.chars().any(char::is_control)
    {
        Err(AssistantLaunchError {
            code: ASSISTANT_LAUNCH_INVALID_REQUEST.to_string(),
            message: "The assistant activation identity is invalid".to_string(),
            retryable: false,
        })
    } else {
        Ok(())
    }
}

fn denied_error() -> AssistantLaunchError {
    AssistantLaunchError {
        code: ASSISTANT_LAUNCH_DENIED.to_string(),
        message: "Assistant launch access was denied".to_string(),
        retryable: false,
    }
}

fn validate_terminal_request(
    module_session_id: &str,
    columns: u16,
    rows: u16,
) -> Result<(), AssistantLaunchError> {
    if module_session_id.trim().is_empty()
        || module_session_id.chars().any(char::is_control)
        || columns == 0
        || rows == 0
    {
        Err(AssistantLaunchError {
            code: ASSISTANT_LAUNCH_INVALID_REQUEST.to_string(),
            message: "The assistant terminal request is invalid".to_string(),
            retryable: false,
        })
    } else {
        Ok(())
    }
}

fn invalid_or_transport_error(message: String) -> AssistantLaunchError {
    let normalized = message.to_ascii_lowercase();
    let code = if normalized.contains("restore record was not found") {
        ASSISTANT_LAUNCH_SESSION_NOT_FOUND
    } else if normalized.contains("restore record is not ready")
        || normalized.contains("capture is no longer pending")
        || normalized.contains("identity is no longer pending")
    {
        ASSISTANT_LAUNCH_SESSION_NOT_RECOVERABLE
    } else if normalized.contains("must")
        || normalized.contains("invalid")
        || normalized.contains("too many")
        || normalized.contains("exceeds")
        || normalized.contains("not a directory")
        || normalized.contains("escapes")
    {
        ASSISTANT_LAUNCH_INVALID_REQUEST
    } else {
        ASSISTANT_LAUNCH_TRANSPORT_FAILED
    };
    AssistantLaunchError {
        code: code.to_string(),
        message,
        retryable: false,
    }
}

fn canonical_directory(path: &str, field: &str) -> Result<String, String> {
    let candidate = Path::new(path);
    if !candidate.is_dir() {
        return Err(format!("Assistant {field} is not a directory"));
    }
    candidate
        .canonicalize()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|error| format!("Failed to resolve assistant {field}: {error}"))
}

fn required_text(value: String, field: &str, maximum_length: usize) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if value.len() > maximum_length || value.chars().any(char::is_control) {
        return Err(format!("{field} is invalid"));
    }
    Ok(value)
}

fn find_record_mut<'a>(
    state: &'a mut RegistryState,
    record_id: &str,
) -> Result<&'a mut AssistantSessionRecord, String> {
    state
        .manifest
        .sessions
        .iter_mut()
        .find(|record| record.record_id == record_id)
        .ok_or_else(|| "Assistant session restore record was not found".to_string())
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn now_epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{
        materialize_new_launch, materialize_resume_launch, AssistantProcessArgument,
        AssistantProcessLaunch, AssistantProcessPlaceholder, AssistantSessionRegistry,
        CaptureState, PrepareAssistantSession,
    };
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn fixture_dir(name: &str) -> std::path::PathBuf {
        let sequence = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let directory = std::env::temp_dir().join(format!(
            "shipctl-assistant-session-test-{}-{sequence}-{name}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn request(
        root: &std::path::Path,
        initial_session_identity: Option<&str>,
    ) -> PrepareAssistantSession {
        PrepareAssistantSession {
            provider: "fixture".to_string(),
            launch_repo_path: root.to_string_lossy().into_owned(),
            placement_project_path: root.to_string_lossy().into_owned(),
            label: "Fixture assistant".to_string(),
            session_mode: "fixture-mode".to_string(),
            model: None,
            initial_session_identity: initial_session_identity.map(ToString::to_string),
        }
    }

    #[test]
    fn preserves_a_plugin_assigned_identity_without_provider_branching() {
        let root = fixture_dir("initial-identity");
        let registry = AssistantSessionRegistry::new(root.join("assistant-sessions.json"));
        let record = registry
            .prepare(request(&root, Some("fixture-session-1")))
            .unwrap();
        assert_eq!(record.capture_state, CaptureState::Assigned);
        assert_eq!(
            record.provider_session_id.as_deref(),
            Some("fixture-session-1")
        );
        registry.begin_preserving_shutdown().unwrap();
        let restorable = registry.list_restorable();
        assert_eq!(restorable.len(), 1);
        assert_eq!(restorable[0].capture_state, CaptureState::Assigned);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn confirms_only_the_exact_plugin_assigned_identity() {
        let root = fixture_dir("confirmed-assigned-identity");
        let registry = AssistantSessionRegistry::new(root.join("assistant-sessions.json"));
        let assigned = registry
            .prepare(request(&root, Some("fixture-session-1")))
            .unwrap();

        assert!(registry
            .confirm_capture(&assigned.record_id, "another-session".to_string())
            .is_err());
        let ready = registry
            .confirm_capture(&assigned.record_id, "fixture-session-1".to_string())
            .unwrap();
        assert_eq!(ready.capture_state, CaptureState::Ready);
        assert_eq!(
            ready.provider_session_id.as_deref(),
            Some("fixture-session-1")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn accepts_capture_identity_for_an_opaque_fixture_policy() {
        let root = fixture_dir("captured-identity");
        let registry = AssistantSessionRegistry::new(root.join("assistant-sessions.json"));
        let pending = registry.prepare(request(&root, None)).unwrap();
        let ready = registry
            .confirm_capture(&pending.record_id, "fixture-session-2".to_string())
            .unwrap();
        assert_eq!(ready.capture_state, CaptureState::Ready);
        assert_eq!(
            ready.provider_session_id.as_deref(),
            Some("fixture-session-2")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resume_substitutes_only_the_generic_identity_placeholder() {
        let launch = AssistantProcessLaunch {
            program: "fixture-cli".to_string(),
            arguments: vec![
                AssistantProcessArgument::Text("resume".to_string()),
                AssistantProcessArgument::Placeholder(
                    AssistantProcessPlaceholder::CapturedSessionId,
                ),
            ],
        };
        let materialized = materialize_resume_launch(launch, "private-id").unwrap();
        assert_eq!(materialized.arguments, vec!["resume", "private-id"]);
    }

    #[test]
    fn new_launch_refuses_a_private_identity_placeholder() {
        let launch = AssistantProcessLaunch {
            program: "fixture-cli".to_string(),
            arguments: vec![AssistantProcessArgument::Placeholder(
                AssistantProcessPlaceholder::CapturedSessionId,
            )],
        };
        assert!(materialize_new_launch(launch).is_err());
    }
}
