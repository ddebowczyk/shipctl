//! Permanent native authority for assistant process and session launch.
//!
//! This provider owns process launch, host terminal transactions, non-secret
//! provider inspection, and durable recovery records. It has no Tauri dependency
//! and contains no presentation workflow.

#![forbid(unsafe_code)]

pub mod capture;
mod manifest;
mod model_catalog;
mod pi_config;
pub mod providers;
mod snapshot;

use crate::state::DurableWriteBarrier;
use crate::terminal_host::TerminalColorTheme;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::terminal_host::{
    default_terminal_driver_id, TerminalId, TerminalLaunchRequest, TerminalLaunchTarget,
    TerminalMetadata, TerminalOwner, TerminalService,
};

pub use capture::{parse_claude_session_metadata, parse_codex_session_metadata};
pub use providers::{AssistantProvider, SessionMode};
pub use snapshot::AssistantSnapshotProvider;

use manifest::AssistantSessionManifest;

const MAX_LABEL_LENGTH: usize = 256;
const MAX_MODEL_LENGTH: usize = 256;

pub const ASSISTANT_LAUNCH_TRANSPORT_FAILED: &str = "assistant-launch.transport-failed";
pub const ASSISTANT_LAUNCH_DENIED: &str = "assistant-launch.denied";
pub const ASSISTANT_LAUNCH_INVALID_REQUEST: &str = "assistant-launch.invalid-request";
pub const ASSISTANT_LAUNCH_LAUNCH_FAILED: &str = "assistant-launch.launch-failed";
pub const ASSISTANT_LAUNCH_SESSION_NOT_FOUND: &str = "assistant-launch.session-not-found";
pub const ASSISTANT_LAUNCH_SESSION_NOT_RECOVERABLE: &str =
    "assistant-launch.session-not-recoverable";
pub const ASSISTANT_LAUNCH_ACTIVATION_DISPOSED: &str = "assistant-launch.activation-disposed";

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_thinking_level: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiConfig {
    pub settings: PiSettings,
    pub configured_providers: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantLaunchActor {
    pub module_id: String,
    pub activation_id: String,
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
    Ready,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSessionRecord {
    pub record_id: String,
    pub provider: AssistantProvider,
    pub provider_session_id: Option<String>,
    pub launch_repo_path: String,
    pub placement_project_path: String,
    pub label: String,
    pub session_mode: SessionMode,
    pub model: Option<String>,
    pub capture_state: CaptureState,
    /// A record is written as soon as it is known, but it is only eligible for
    /// automatic restoration after Shipctl has completed its normal quit path.
    /// This prevents a later launch from duplicating a provider process that
    /// outlived an abnormal app termination.
    #[serde(default)]
    pub restore_on_next_launch: bool,
    pub started_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareAssistantSession {
    pub provider: AssistantProvider,
    pub launch_repo_path: String,
    pub placement_project_path: String,
    pub label: String,
    pub session_mode: SessionMode,
    pub model: Option<String>,
}

#[derive(Default)]
struct RegistryState {
    manifest: AssistantSessionManifest,
    /// Codex does not accept a caller-assigned session ID. Keep a pre-spawn
    /// set in memory and only accept a newly-created transcript whose metadata
    /// names the exact launch directory. This is deliberately not persisted:
    /// it is capture plumbing, not restore data.
    pending_codex_transcripts: HashMap<String, HashSet<PathBuf>>,
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
                    AssistantSessionManifest::default()
                }
            }
        } else {
            AssistantSessionManifest::default()
        };

        Self {
            path,
            durable_writes,
            state: Mutex::new(RegistryState {
                manifest,
                pending_codex_transcripts: HashMap::new(),
                preserving_shutdown: false,
                startup_warning,
            }),
        }
    }

    pub fn prepare(
        &self,
        request: PrepareAssistantSession,
    ) -> Result<AssistantSessionRecord, String> {
        let launch_repo_path = canonical_directory(&request.launch_repo_path, "launch directory")?;
        let placement_project_path =
            canonical_directory(&request.placement_project_path, "placement project")?;
        let label = required_text(request.label, "Session label", MAX_LABEL_LENGTH)?;
        let model = request
            .model
            .map(|model| required_text(model, "Model", MAX_MODEL_LENGTH))
            .transpose()?;
        let codex_transcripts = if request.provider == AssistantProvider::Codex {
            Some(codex_transcript_paths()?)
        } else {
            None
        };
        let now = now_epoch_seconds();
        let record = AssistantSessionRecord {
            record_id: Uuid::new_v4().to_string(),
            provider: request.provider,
            // Claude supports a caller-provided session UUID. Persist it
            // before spawn so there is no transcript discovery race.
            provider_session_id: (request.provider == AssistantProvider::Claude)
                .then(|| Uuid::new_v4().to_string()),
            launch_repo_path,
            placement_project_path,
            label,
            session_mode: request.session_mode,
            model,
            capture_state: CaptureState::Pending,
            restore_on_next_launch: false,
            started_at: now,
            updated_at: now,
        };

        self.mutate(|state| {
            if let Some(transcripts) = codex_transcripts {
                state
                    .pending_codex_transcripts
                    .insert(record.record_id.clone(), transcripts);
            }
            state.manifest.sessions.push(record.clone());
            Ok(record.clone())
        })
    }

    pub fn confirm_capture(
        &self,
        record_id: &str,
        provider_session_id: String,
    ) -> Result<AssistantSessionRecord, String> {
        let provider_session_id =
            required_text(provider_session_id, "Provider session id", MAX_LABEL_LENGTH)?;
        self.mutate(|state| {
            let record = find_record_mut(state, record_id)?;
            if record.capture_state != CaptureState::Pending {
                return Err("Assistant session capture is no longer pending".to_string());
            }
            if record.provider == AssistantProvider::Claude
                && record.provider_session_id.as_deref() != Some(provider_session_id.as_str())
            {
                return Err("Claude capture did not match the generated session id".to_string());
            }
            record.provider_session_id = Some(provider_session_id.clone());
            record.capture_state = CaptureState::Ready;
            record.updated_at = now_epoch_seconds();
            Ok(record.clone())
        })
    }

    pub fn mark_capture_failed(&self, record_id: &str) -> Result<AssistantSessionRecord, String> {
        self.mutate(|state| {
            let updated = {
                let record = find_record_mut(state, record_id)?;
                if record.capture_state == CaptureState::Ready {
                    return Err("A ready assistant session cannot be marked failed".to_string());
                }
                record.capture_state = CaptureState::Failed;
                record.updated_at = now_epoch_seconds();
                record.clone()
            };
            state.pending_codex_transcripts.remove(record_id);
            Ok(updated)
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
            if state.preserving_shutdown {
                return Err("Assistant restore records are frozen during shutdown".to_string());
            }
            let previous_len = state.manifest.sessions.len();
            state
                .manifest
                .sessions
                .retain(|record| record.record_id != record_id);
            if state.manifest.sessions.len() == previous_len {
                return Ok(());
            }
            state.pending_codex_transcripts.remove(record_id);
            Ok(())
        })
    }

    /// Attempt the one safe Codex capture strategy available without changing
    /// the user's global Codex hooks: a transcript must be both new since the
    /// launch began and explicitly associated with this launch directory. More
    /// than one match is an error, never a guess.
    pub fn try_capture_codex_session(
        &self,
        record_id: &str,
    ) -> Result<Option<AssistantSessionRecord>, String> {
        let _durable_update = self.durable_writes.enter_update()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Assistant session registry lock was poisoned".to_string())?;
        if state.preserving_shutdown {
            return Err("Assistant restore records are frozen during shutdown".to_string());
        }

        let record = state
            .manifest
            .sessions
            .iter()
            .find(|record| record.record_id == record_id)
            .cloned()
            .ok_or_else(|| "Assistant session restore record was not found".to_string())?;
        if record.provider != AssistantProvider::Codex {
            return Err("Only Codex sessions require transcript capture".to_string());
        }
        if record.capture_state != CaptureState::Pending {
            return Ok(Some(record));
        }

        let known_paths = state
            .pending_codex_transcripts
            .get(record_id)
            .ok_or_else(|| "Codex capture snapshot was not available".to_string())?;
        let candidate = select_codex_capture_candidate(
            known_paths,
            Path::new(&record.launch_repo_path),
            codex_transcript_paths()?,
        )?;

        match candidate {
            None => Ok(None),
            Some(metadata) => {
                let updated = find_record_mut(&mut state, record_id)?;
                updated.provider_session_id = Some(metadata.session_id);
                updated.capture_state = CaptureState::Ready;
                updated.updated_at = now_epoch_seconds();
                let updated = updated.clone();
                state.pending_codex_transcripts.remove(record_id);
                manifest::write_atomically(&self.path, &state.manifest)?;
                Ok(Some(updated))
            }
        }
    }

    /// Make one final best-effort scan after the user confirms quit and before
    /// the manifest is frozen. A Codex `session_meta` row is normally written
    /// at launch, but this closes the short race between process start and the
    /// UI's normal polling loop.
    pub fn try_capture_pending_codex_sessions(&self) {
        let record_ids = self
            .state
            .lock()
            .map(|state| {
                state
                    .manifest
                    .sessions
                    .iter()
                    .filter(|record| {
                        record.provider == AssistantProvider::Codex
                            && record.capture_state == CaptureState::Pending
                    })
                    .map(|record| record.record_id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        for record_id in record_ids {
            let _ = self.try_capture_codex_session(&record_id);
        }
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
                        record.capture_state == CaptureState::Ready
                            && record.provider_session_id.is_some()
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
                    && record.capture_state == CaptureState::Ready
                    && record.provider_session_id.is_some()
                    && record.restore_on_next_launch
            })
            .cloned()
            .ok_or_else(|| "Assistant restore record is not ready".to_string())
    }

    /// Atomically claim one record for a restore attempt. Disarming it before
    /// spawning means a crash during the resumed provider's lifetime cannot
    /// make a subsequent launch automatically duplicate that provider process.
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
        if record.capture_state != CaptureState::Ready
            || record.provider_session_id.is_none()
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

    /// Re-arm a record only when its explicit restore spawn could not start.
    /// This keeps the failure recoverable without ever turning it into a fresh
    /// provider session.
    pub fn rearm_for_restore(&self, record_id: &str) -> Result<(), String> {
        self.mutate(|state| {
            let record = find_record_mut(state, record_id)?;
            if record.capture_state != CaptureState::Ready || record.provider_session_id.is_none() {
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
        // Pending/failed capture records do not contain a safe provider ID.
        // They must not survive a normal quit as inert, undiscoverable state.
        state.manifest.sessions.retain(|record| {
            record.capture_state == CaptureState::Ready && record.provider_session_id.is_some()
        });
        for record in &mut state.manifest.sessions {
            record.restore_on_next_launch = true;
            record.updated_at = now_epoch_seconds();
        }
        state.pending_codex_transcripts.clear();
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

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartAssistantSessionInput {
    pub module_session_id: String,
    pub provider: AssistantProvider,
    pub launch_repo_path: String,
    pub placement_project_path: String,
    pub label: String,
    pub session_mode: SessionMode,
    pub model: Option<String>,
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
    pub module_session_id: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    pub color_theme: TerminalColorTheme,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AssistantLaunchGrant {
    Launch,
    SessionRecord,
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
        app_version: String,
    ) -> Self {
        model_catalog::set_app_version(app_version);
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
            })
            .map_err(invalid_or_transport_error)?;
        let launch = providers::prepare_new_session(
            prepared.provider,
            prepared.session_mode,
            prepared.model.as_deref(),
            prepared.provider_session_id.as_deref(),
        )
        .map_err(invalid_or_transport_error)?;
        let terminal_id = match self.spawn_terminal(
            &prepared,
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
                    message: provider_spawn_error(prepared.provider, error),
                    retryable: false,
                });
            }
        };

        let record = if prepared.provider == AssistantProvider::Claude {
            let session_id = prepared
                .provider_session_id
                .clone()
                .expect("Claude records always receive a UUID before spawn");
            match self
                .inner
                .registry
                .confirm_capture(&prepared.record_id, session_id)
            {
                Ok(record) => record,
                Err(error) => {
                    let _ = self.inner.terminals.close(terminal_id);
                    let _ = self.inner.registry.discard(&prepared.record_id);
                    return Err(invalid_or_transport_error(error));
                }
            }
        } else {
            prepared
        };

        Ok(StartedAssistantSession {
            terminal_id: terminal_id.to_string(),
            record,
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
        let provider_session_id = candidate
            .provider_session_id
            .as_deref()
            .expect("ready assistant records always contain a provider session id");
        let launch = providers::prepare_resume_session(
            candidate.provider,
            provider_session_id,
            candidate.session_mode,
            candidate.model.as_deref(),
        )
        .map_err(invalid_or_transport_error)?;
        let record = self
            .inner
            .registry
            .claim_for_restore(&request.record_id)
            .map_err(invalid_or_transport_error)?;
        let terminal_id = match self.spawn_terminal(
            &record,
            request.module_session_id,
            request.env,
            request.cols,
            request.rows,
            request.color_theme,
            launch,
        ) {
            Ok(terminal_id) => terminal_id,
            Err(error) => {
                let spawn_error = provider_spawn_error(record.provider, error);
                if let Err(rearm_error) = self.inner.registry.rearm_for_restore(&record.record_id) {
                    return Err(AssistantLaunchError {
                        code: ASSISTANT_LAUNCH_LAUNCH_FAILED.to_string(),
                        message: format!(
                            "{spawn_error} The saved session could not be re-armed for retry: {rearm_error}"
                        ),
                        retryable: false,
                    });
                }
                return Err(AssistantLaunchError {
                    code: ASSISTANT_LAUNCH_LAUNCH_FAILED.to_string(),
                    message: spawn_error,
                    retryable: false,
                });
            }
        };

        Ok(StartedAssistantSession {
            terminal_id: terminal_id.to_string(),
            record,
        })
    }

    pub fn refresh_session_identity(
        &self,
        actor: &AssistantLaunchActor,
        record_id: &str,
    ) -> Result<Option<AssistantSessionRecord>, AssistantLaunchError> {
        self.authorize(actor, AssistantLaunchGrant::SessionRecord)?;
        self.inner
            .registry
            .try_capture_codex_session(record_id)
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
        self.inner.registry.try_capture_pending_codex_sessions();
        self.inner
            .registry
            .begin_preserving_shutdown()
            .map_err(invalid_or_transport_error)
    }

    pub fn inspect_models(
        &self,
        actor: &AssistantLaunchActor,
        provider: &str,
    ) -> Result<Vec<String>, AssistantLaunchError> {
        self.authorize(actor, AssistantLaunchGrant::Launch)?;
        model_catalog::query(provider).map_err(invalid_or_transport_error)
    }

    pub fn inspect_provider_configuration(
        &self,
        actor: &AssistantLaunchActor,
        provider: &str,
    ) -> Result<PiConfig, AssistantLaunchError> {
        self.authorize(actor, AssistantLaunchGrant::SessionRecord)?;
        require_pi_provider(provider)?;
        pi_config::get_pi_config().map_err(invalid_or_transport_error)
    }

    pub fn save_provider_configuration(
        &self,
        actor: &AssistantLaunchActor,
        provider: &str,
        settings: PiSettings,
    ) -> Result<(), AssistantLaunchError> {
        self.authorize(actor, AssistantLaunchGrant::SessionRecord)?;
        require_pi_provider(provider)?;
        pi_config::save_pi_settings(settings).map_err(invalid_or_transport_error)
    }

    pub fn release_activation(
        &self,
        actor: &AssistantLaunchActor,
    ) -> Result<bool, AssistantLaunchError> {
        validate_actor(actor)?;
        if actor.module_id != "shipctl.assistants" {
            return Err(denied_error());
        }
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
        _grant: AssistantLaunchGrant,
    ) -> Result<(), AssistantLaunchError> {
        validate_actor(actor)?;
        if actor.module_id != "shipctl.assistants" {
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

    fn spawn_terminal(
        &self,
        record: &AssistantSessionRecord,
        module_session_id: String,
        environment: HashMap<String, String>,
        columns: u16,
        rows: u16,
        color_theme: TerminalColorTheme,
        launch: providers::ProviderLaunchSpec,
    ) -> Result<TerminalId, String> {
        self.inner
            .terminals
            .spawn(TerminalLaunchRequest {
                driver_id: default_terminal_driver_id(),
                target: TerminalLaunchTarget::Program {
                    program: launch.command.clone().into(),
                    argv: launch.args,
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
                    display_command: launch.command,
                    created_at_ms: now_epoch_millis(),
                    owner: TerminalOwner::Module {
                        module_id: "assistants".to_string(),
                        owner_key: terminal_owner_key(record.provider).to_string(),
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

fn provider_spawn_error(provider: AssistantProvider, spawn_error: String) -> String {
    let (command, display_name) = match provider {
        AssistantProvider::Claude => ("claude", "Claude Code"),
        AssistantProvider::Codex => ("codex", "Codex"),
    };
    let version = Command::new(command)
        .arg("--version")
        .output()
        .ok()
        .and_then(|output| {
            let text = if output.stdout.is_empty() {
                String::from_utf8_lossy(&output.stderr).trim().to_string()
            } else {
                String::from_utf8_lossy(&output.stdout).trim().to_string()
            };
            (!text.is_empty()).then_some(text)
        });

    match version {
        Some(version) => format!(
            "Could not start {display_name}: {spawn_error}. Detected {version}; update {display_name} and try again."
        ),
        None => format!(
            "Could not start {display_name}: {spawn_error}. {display_name} was not found on Shipctl's PATH; install it or restart Shipctl after updating your shell setup."
        ),
    }
}

fn terminal_owner_key(provider: AssistantProvider) -> &'static str {
    match provider {
        AssistantProvider::Claude => "assistants:claude",
        AssistantProvider::Codex => "assistants:codex",
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
        return Err(AssistantLaunchError {
            code: ASSISTANT_LAUNCH_INVALID_REQUEST.to_string(),
            message: "The assistant terminal request is invalid".to_string(),
            retryable: false,
        });
    }
    Ok(())
}

fn invalid_or_transport_error(message: String) -> AssistantLaunchError {
    let normalized = message.to_ascii_lowercase();
    let code = if normalized.contains("restore record was not found") {
        ASSISTANT_LAUNCH_SESSION_NOT_FOUND
    } else if normalized.contains("restore record is not ready")
        || normalized.contains("capture is no longer pending")
    {
        ASSISTANT_LAUNCH_SESSION_NOT_RECOVERABLE
    } else if normalized.contains("must not")
        || normalized.contains("must be")
        || normalized.contains("not a directory")
        || normalized.contains("unsupported assistant provider")
        || normalized.contains("only codex")
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

fn require_pi_provider(provider: &str) -> Result<(), AssistantLaunchError> {
    if provider == "pi" {
        Ok(())
    } else {
        Err(AssistantLaunchError {
            code: ASSISTANT_LAUNCH_INVALID_REQUEST.to_string(),
            message: "Assistant provider configuration is not supported".to_string(),
            retryable: false,
        })
    }
}

fn codex_transcript_paths() -> Result<HashSet<PathBuf>, String> {
    let root = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory for Codex session discovery".to_string())?
        .join(".codex/sessions");
    let mut paths = HashSet::new();
    collect_jsonl_files(&root, &mut paths)?;
    Ok(paths)
}

/// Return the only safe new Codex transcript candidate for a launch. A
/// transcript must be absent from the pre-spawn snapshot and identify the
/// exact canonical launch directory. More than one match is deliberately an
/// error: concurrent sessions in the same directory cannot be associated
/// safely without changing the user's Codex configuration.
fn select_codex_capture_candidate(
    known_paths: &HashSet<PathBuf>,
    launch_path: &Path,
    transcript_paths: HashSet<PathBuf>,
) -> Result<Option<capture::ProviderSessionMetadata>, String> {
    let mut candidates = Vec::new();
    for transcript_path in transcript_paths {
        if known_paths.contains(&transcript_path) {
            continue;
        }
        let Ok(metadata) = parse_codex_session_metadata(&transcript_path) else {
            // Codex can create the file before it writes session_meta.
            continue;
        };
        let Some(cwd) = metadata.cwd.as_ref() else {
            continue;
        };
        if cwd.canonicalize().ok().as_deref() == Some(launch_path) {
            candidates.push(metadata);
        }
    }
    match candidates.len() {
        0 => Ok(None),
        1 => Ok(candidates.pop()),
        count => Err(format!(
            "Found {count} new Codex sessions for this directory; restore was not enabled so Shipctl will not guess which one to resume"
        )),
    }
}

fn collect_jsonl_files(root: &Path, paths: &mut HashSet<PathBuf>) -> Result<(), String> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to inspect Codex session directory {}: {error}",
                root.display()
            ));
        }
    };

    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Failed to inspect Codex session entry: {error}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, paths)?;
        } else if path.extension().and_then(|extension| extension.to_str()) == Some("jsonl") {
            paths.insert(path);
        }
    }
    Ok(())
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
    if value.len() > maximum_length {
        return Err(format!(
            "{field} must be at most {maximum_length} characters"
        ));
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
        select_codex_capture_candidate, AssistantProvider, AssistantSessionRegistry, CaptureState,
        PrepareAssistantSession, SessionMode,
    };
    use std::collections::HashSet;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn fixture_dir(name: &str) -> std::path::PathBuf {
        let sequence = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let directory = std::env::temp_dir().join(format!(
            "shipctl-assistant-session-registry-test-{}-{sequence}-{name}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn request(directory: &std::path::Path) -> PrepareAssistantSession {
        PrepareAssistantSession {
            provider: AssistantProvider::Claude,
            launch_repo_path: directory.to_string_lossy().to_string(),
            placement_project_path: directory.to_string_lossy().to_string(),
            label: "Claude Code".to_string(),
            session_mode: SessionMode::Standard,
            model: Some("sonnet".to_string()),
        }
    }

    #[test]
    fn arms_ready_records_only_after_normal_shutdown() {
        let directory = fixture_dir("round-trip");
        let path = directory.join("assistant-sessions.json");
        let registry = AssistantSessionRegistry::new_at(path.clone());
        let pending = registry.prepare(request(&directory)).unwrap();
        let ready = registry
            .confirm_capture(
                &pending.record_id,
                pending.provider_session_id.clone().unwrap(),
            )
            .unwrap();

        assert!(registry.list_restorable().is_empty());
        registry.begin_preserving_shutdown().unwrap();

        let restored = AssistantSessionRegistry::new_at(path.clone()).list_restorable();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].record_id, ready.record_id);
        assert_eq!(restored[0].capture_state, CaptureState::Ready);
        assert_eq!(restored[0].provider_session_id, ready.provider_session_id);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o077, 0);
        }
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn claiming_a_restore_disarms_it_until_shutdown_or_rearm() {
        let directory = fixture_dir("claim");
        let path = directory.join("assistant-sessions.json");
        let registry = AssistantSessionRegistry::new_at(path.clone());
        let pending = registry.prepare(request(&directory)).unwrap();
        let ready = registry
            .confirm_capture(
                &pending.record_id,
                pending.provider_session_id.clone().unwrap(),
            )
            .unwrap();
        registry.begin_preserving_shutdown().unwrap();

        let restarted = AssistantSessionRegistry::new_at(path);
        let claimed = restarted.claim_for_restore(&ready.record_id).unwrap();
        assert!(!claimed.restore_on_next_launch);
        assert!(restarted.list_restorable().is_empty());

        restarted.rearm_for_restore(&ready.record_id).unwrap();
        assert_eq!(restarted.list_restorable().len(), 1);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn legacy_manifest_records_are_disarmed_by_default() {
        let directory = fixture_dir("legacy-disarmed");
        let path = directory.join("assistant-sessions.json");
        let registry = AssistantSessionRegistry::new_at(path.clone());
        let pending = registry.prepare(request(&directory)).unwrap();
        registry
            .confirm_capture(
                &pending.record_id,
                pending.provider_session_id.clone().unwrap(),
            )
            .unwrap();
        registry.begin_preserving_shutdown().unwrap();

        let legacy = fs::read_to_string(&path)
            .unwrap()
            .replace("    \"restoreOnNextLaunch\": true,\n", "");
        fs::write(&path, legacy).unwrap();

        let restarted = AssistantSessionRegistry::new_at(path);
        assert!(restarted.list_restorable().is_empty());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn gives_claude_a_durable_id_before_it_is_spawned() {
        let directory = fixture_dir("claude-id");
        let registry = AssistantSessionRegistry::new_at(directory.join("assistant-sessions.json"));

        let record = registry.prepare(request(&directory)).unwrap();

        assert_eq!(record.capture_state, CaptureState::Pending);
        assert!(uuid::Uuid::parse_str(record.provider_session_id.as_deref().unwrap()).is_ok());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn rejects_ambiguous_new_codex_transcripts_for_the_same_directory() {
        let directory = fixture_dir("ambiguous-codex");
        let launch_path = directory.canonicalize().unwrap();
        let first = directory.join("first.jsonl");
        let second = directory.join("second.jsonl");
        let cwd = directory.to_string_lossy();
        fs::write(
            &first,
            format!(
                r#"{{"type":"session_meta","payload":{{"id":"first-session","cwd":"{cwd}"}}}}"#
            ),
        )
        .unwrap();
        fs::write(
            &second,
            format!(
                r#"{{"type":"session_meta","payload":{{"id":"second-session","cwd":"{cwd}"}}}}"#
            ),
        )
        .unwrap();

        let error = select_codex_capture_candidate(
            &HashSet::new(),
            &launch_path,
            HashSet::from([first, second]),
        )
        .unwrap_err();

        assert!(error.contains("will not guess"));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn isolates_corrupt_manifest_without_breaking_startup() {
        let directory = fixture_dir("corrupt");
        let path = directory.join("assistant-sessions.json");
        fs::write(&path, "not json").unwrap();

        let registry = AssistantSessionRegistry::new_at(path.clone());

        assert!(registry.list_restorable().is_empty());
        assert!(registry.take_startup_warning().is_some());
        assert!(!path.exists());
        assert!(fs::read_dir(&directory)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains("corrupt")));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn isolates_a_newer_manifest_version_without_breaking_startup() {
        let directory = fixture_dir("unsupported");
        let path = directory.join("assistant-sessions.json");
        fs::write(&path, r#"{"version":999,"sessions":[]}"#).unwrap();

        let registry = AssistantSessionRegistry::new_at(path.clone());

        assert!(registry.list_restorable().is_empty());
        assert!(registry.take_startup_warning().is_some());
        assert!(!path.exists());
        assert!(fs::read_dir(&directory)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains("unsupported")));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn freezes_record_removal_after_preserving_shutdown_begins() {
        let directory = fixture_dir("freeze");
        let path = directory.join("assistant-sessions.json");
        let registry = AssistantSessionRegistry::new_at(path);
        let record = registry.prepare(request(&directory)).unwrap();

        registry.begin_preserving_shutdown().unwrap();

        assert!(registry.discard(&record.record_id).is_err());
        assert!(registry.list_restorable().is_empty());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn keeps_the_registry_writable_until_shutdown_is_confirmed() {
        let directory = fixture_dir("cancel-quit");
        let path = directory.join("assistant-sessions.json");
        let registry = AssistantSessionRegistry::new_at(path);
        let pending = registry.prepare(request(&directory)).unwrap();
        registry
            .confirm_capture(
                &pending.record_id,
                pending.provider_session_id.clone().unwrap(),
            )
            .unwrap();

        let renamed = registry
            .update_label(&pending.record_id, "Keep running".to_string())
            .unwrap();

        assert_eq!(renamed.label, "Keep running");
        assert!(registry.discard(&pending.record_id).is_ok());
        assert!(registry.discard(&pending.record_id).is_ok());
        let _ = fs::remove_dir_all(directory);
    }
}

#[cfg(test)]
mod provider_properties {
    use super::*;
    use crate::terminal_host::retention::TerminalRetentionPolicy;
    use proptest::prelude::*;

    const CLAUDE_SESSION_ID: &str = "123e4567-e89b-12d3-a456-426614174000";

    fn actor(module_id: &str, activation_id: &str) -> AssistantLaunchActor {
        AssistantLaunchActor {
            module_id: module_id.to_string(),
            activation_id: activation_id.to_string(),
        }
    }

    fn service(root: &Path) -> AssistantLaunchService {
        AssistantLaunchService::new(
            TerminalService::new("assistant-property", TerminalRetentionPolicy::default()),
            root.join("assistant-sessions.json"),
            DurableWriteBarrier::default(),
            "property-test".to_string(),
        )
    }

    proptest! {
        #[test]
        fn architecture_provider_assistant_launch_parity_property(
            provider_index in 0usize..2,
            yolo in any::<bool>(),
            model in proptest::option::of("[A-Za-z0-9][A-Za-z0-9._-]{0,20}"),
            resume in any::<bool>(),
            resume_id in "[A-Za-z0-9][A-Za-z0-9_-]{0,20}",
        ) {
            let provider = if provider_index == 0 {
                AssistantProvider::Claude
            } else {
                AssistantProvider::Codex
            };
            let mode = if yolo { SessionMode::Yolo } else { SessionMode::Standard };
            let actual = if resume {
                providers::prepare_resume_session(provider, &resume_id, mode, model.as_deref()).unwrap()
            } else {
                providers::prepare_new_session(
                    provider,
                    mode,
                    model.as_deref(),
                    (provider == AssistantProvider::Claude).then_some(CLAUDE_SESSION_ID),
                ).unwrap()
            };

            let mut expected_args = Vec::new();
            if let Some(model) = &model {
                expected_args.extend(["--model".to_string(), model.clone()]);
            }
            if yolo {
                expected_args.push(match provider {
                    AssistantProvider::Claude => "--dangerously-skip-permissions".to_string(),
                    AssistantProvider::Codex => "--yolo".to_string(),
                });
            }
            if resume {
                match provider {
                    AssistantProvider::Claude => {
                        expected_args.extend(["--resume".to_string(), resume_id]);
                    }
                    AssistantProvider::Codex => {
                        expected_args.extend(["resume".to_string(), resume_id]);
                    }
                }
            } else if provider == AssistantProvider::Claude {
                expected_args.extend([
                    "--session-id".to_string(),
                    CLAUDE_SESSION_ID.to_string(),
                ]);
            }

            prop_assert_eq!(actual.command, if provider == AssistantProvider::Claude { "claude" } else { "codex" });
            prop_assert_eq!(actual.args, expected_args);
        }

        #[test]
        fn architecture_provider_assistant_launch_authority_property(
            known_module in any::<bool>(),
            disposed in any::<bool>(),
        ) {
            let root = tempfile::tempdir().unwrap();
            let provider = service(root.path());
            let candidate = actor(
                if known_module { "shipctl.assistants" } else { "shipctl.unknown" },
                "authority",
            );
            if known_module && disposed {
                provider.release_activation(&candidate).unwrap();
            }
            let result = provider.inspect_restorable_sessions(&candidate);
            let expected = if !known_module {
                Some(ASSISTANT_LAUNCH_DENIED)
            } else if disposed {
                Some(ASSISTANT_LAUNCH_ACTIVATION_DISPOSED)
            } else {
                None
            };
            match expected {
                Some(code) => prop_assert_eq!(result.unwrap_err().code, code),
                None => prop_assert!(result.is_ok()),
            }
            prop_assert!(!root.path().join("assistant-sessions.json").exists());
        }

        #[test]
        fn architecture_provider_assistant_launch_ownership_property(
            release_owner in any::<bool>(),
            label in "[A-Za-z0-9][A-Za-z0-9 _-]{0,20}",
        ) {
            let root = tempfile::tempdir().unwrap();
            let repository = root.path().join("repo");
            fs::create_dir_all(&repository).unwrap();
            let provider = service(root.path());
            provider.inner.registry.prepare(PrepareAssistantSession {
                provider: AssistantProvider::Claude,
                launch_repo_path: repository.to_string_lossy().to_string(),
                placement_project_path: repository.to_string_lossy().to_string(),
                label,
                session_mode: SessionMode::Standard,
                model: None,
            }).unwrap();
            let manifest = root.path().join("assistant-sessions.json");
            let original = fs::read(&manifest).unwrap();
            let owner = actor("shipctl.assistants", "owner");
            let peer = actor("shipctl.assistants", "peer");
            let (released, live) = if release_owner { (&owner, &peer) } else { (&peer, &owner) };

            prop_assert!(provider.release_activation(released).unwrap());
            prop_assert_eq!(
                provider.inspect_restorable_sessions(released).unwrap_err().code,
                ASSISTANT_LAUNCH_ACTIVATION_DISPOSED,
            );
            prop_assert!(provider.inspect_restorable_sessions(live).is_ok());
            prop_assert_eq!(fs::read(&manifest).unwrap(), original);
            prop_assert_eq!(provider.inner.registry.state.lock().unwrap().manifest.sessions.len(), 1);
            prop_assert_eq!(provider.inner.terminals.active_count(), 0);
        }
    }
}
