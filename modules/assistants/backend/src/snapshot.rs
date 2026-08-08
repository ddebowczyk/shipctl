use std::fs;
use std::path::PathBuf;

use shipctl_module_api::{
    CapturedSnapshotEntry, SnapshotClassification, SnapshotEntryDeclaration, SnapshotProvider,
};

use crate::manifest::{AssistantSessionManifest, MANIFEST_VERSION};

pub struct AssistantSnapshotProvider {
    path: PathBuf,
}

impl AssistantSnapshotProvider {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl SnapshotProvider for AssistantSnapshotProvider {
    fn id(&self) -> &'static str {
        "assistants.continuity"
    }

    fn schema_version(&self) -> u32 {
        MANIFEST_VERSION
    }

    fn entries(&self) -> Vec<SnapshotEntryDeclaration> {
        vec![
            SnapshotEntryDeclaration {
                id: "sessions",
                classification: SnapshotClassification::Portable,
                source_paths: vec![PathBuf::from("assistant-sessions.json")],
                target_path: Some(PathBuf::from("assistant-sessions.json")),
                redaction: "provider session metadata only; no transcript content",
            },
            SnapshotEntryDeclaration {
                id: "provider_credentials",
                classification: SnapshotClassification::Secret,
                source_paths: Vec::new(),
                target_path: None,
                redaction: "external assistant credentials are never captured",
            },
            SnapshotEntryDeclaration {
                id: "provider_transcripts",
                classification: SnapshotClassification::ReferenceOnly,
                source_paths: Vec::new(),
                target_path: None,
                redaction: "provider-owned transcripts remain external references",
            },
            SnapshotEntryDeclaration {
                id: "terminal_processes",
                classification: SnapshotClassification::LiveOnly,
                source_paths: Vec::new(),
                target_path: None,
                redaction: "PTY ids, channels, and child processes are never captured",
            },
        ]
    }

    fn capture(&self) -> Result<Vec<CapturedSnapshotEntry>, String> {
        let payload = if self.path.exists() {
            Some(fs::read(&self.path).map_err(|error| {
                format!("Could not capture assistant continuity state: {error}")
            })?)
        } else {
            None
        };
        Ok(vec![
            CapturedSnapshotEntry {
                id: "sessions",
                decision: if payload.is_some() {
                    "included".to_string()
                } else {
                    "source_absent".to_string()
                },
                payload,
            },
            excluded("provider_credentials"),
            excluded("provider_transcripts"),
            excluded("terminal_processes"),
        ])
    }

    fn validate_payload(&self, entry_id: &str, payload: &[u8]) -> Result<(), String> {
        if entry_id != "sessions" {
            return Err(format!("Unknown assistants.continuity payload {entry_id}"));
        }
        let manifest: AssistantSessionManifest = serde_json::from_slice(payload)
            .map_err(|error| format!("Assistant continuity manifest is invalid: {error}"))?;
        if manifest.version != MANIFEST_VERSION {
            return Err(format!(
                "Assistant continuity schema {} is incompatible with supported schema {MANIFEST_VERSION}",
                manifest.version
            ));
        }
        Ok(())
    }
}

fn excluded(id: &'static str) -> CapturedSnapshotEntry {
    CapturedSnapshotEntry {
        id,
        payload: None,
        decision: "excluded_by_classification".to_string(),
    }
}
