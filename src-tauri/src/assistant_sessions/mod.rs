//! Durable identity and provider-specific behaviour for resumable assistant tabs.
//!
//! The registry is intentionally separate from PTY management: a PTY identifier
//! is meaningful only while this process is alive, while a provider session ID
//! can survive a relaunch.

pub mod capture;
mod manifest;
pub mod providers;

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub use capture::{parse_claude_session_metadata, parse_codex_session_metadata};
pub use providers::{AssistantProvider, SessionMode};

use manifest::AssistantSessionManifest;

const MAX_LABEL_LENGTH: usize = 256;
const MAX_MODEL_LENGTH: usize = 256;

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
    /// automatic restoration after Shep has completed its normal quit path.
    /// This prevents a later launch from duplicating a provider process that
    /// outlived an abnormal app termination.
    #[serde(default)]
    pub restore_on_next_launch: bool,
    pub started_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize)]
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
}

impl AssistantSessionRegistry {
    pub fn new() -> Self {
        let path = default_manifest_path().unwrap_or_else(|error| {
            eprintln!("Assistant session registry path warning: {error}");
            PathBuf::from("assistant-sessions.json")
        });
        Self::new_at(path)
    }

    fn new_at(path: PathBuf) -> Self {
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
                return Err("Assistant session restore record was not found".to_string());
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
        let launch_path = PathBuf::from(&record.launch_repo_path);
        let mut candidates = Vec::new();
        for transcript_path in codex_transcript_paths()? {
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
            if cwd.canonicalize().ok().as_deref() == Some(launch_path.as_path()) {
                candidates.push(metadata);
            }
        }

        match candidates.len() {
            0 => Ok(None),
            1 => {
                let metadata = candidates.pop().expect("one candidate checked above");
                let updated = find_record_mut(&mut state, record_id)?;
                updated.provider_session_id = Some(metadata.session_id);
                updated.capture_state = CaptureState::Ready;
                updated.updated_at = now_epoch_seconds();
                let updated = updated.clone();
                state.pending_codex_transcripts.remove(record_id);
                manifest::write_atomically(&self.path, &state.manifest)?;
                Ok(Some(updated))
            }
            count => Err(format!(
                "Found {count} new Codex sessions for this directory; restore was not enabled so Shep will not guess which one to resume"
            )),
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

fn default_manifest_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".shep/assistant-sessions.json"))
        .ok_or_else(|| "Could not find home directory for assistant restore state".to_string())
}

fn codex_transcript_paths() -> Result<HashSet<PathBuf>, String> {
    let root = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory for Codex session discovery".to_string())?
        .join(".codex/sessions");
    let mut paths = HashSet::new();
    collect_jsonl_files(&root, &mut paths)?;
    Ok(paths)
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

#[cfg(test)]
mod tests {
    use super::{
        AssistantProvider, AssistantSessionRegistry, CaptureState, PrepareAssistantSession,
        SessionMode,
    };
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn fixture_dir(name: &str) -> std::path::PathBuf {
        let sequence = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let directory = std::env::temp_dir().join(format!(
            "shep-assistant-session-registry-test-{}-{sequence}-{name}",
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
}
