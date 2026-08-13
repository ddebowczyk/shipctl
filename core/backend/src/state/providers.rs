use std::fs;
use std::path::{Path, PathBuf};

use shipctl_module_api::{
    CapturedSnapshotEntry, SnapshotClassification, SnapshotEntryDeclaration, SnapshotProvider,
};

use crate::state::workspace_layout::WorkspaceLayoutStore;

const LEGACY_SESSION_RECOVERY_ROOT: &str = "session-recovery";

pub struct WorkspaceSnapshotProvider {
    config_path: PathBuf,
}

impl WorkspaceSnapshotProvider {
    pub fn new(config_path: PathBuf) -> Self {
        Self { config_path }
    }
}

impl SnapshotProvider for WorkspaceSnapshotProvider {
    fn id(&self) -> &'static str {
        "host.workspace"
    }

    fn schema_version(&self) -> u32 {
        1
    }

    fn entries(&self) -> Vec<SnapshotEntryDeclaration> {
        vec![
            portable_entry("config", "config.yml"),
            excluded_entry(
                "repository_contents",
                SnapshotClassification::ReferenceOnly,
                "repository paths are restored as references; repository contents remain external",
            ),
            excluded_entry(
                "repository_workspace_files",
                SnapshotClassification::ReferenceOnly,
                "repo-local .shipctl files remain owned by each repository",
            ),
        ]
    }

    fn capture(&self) -> Result<Vec<CapturedSnapshotEntry>, String> {
        Ok(vec![
            optional_file("config", &self.config_path)?,
            excluded_capture("repository_contents"),
            excluded_capture("repository_workspace_files"),
        ])
    }

    fn validate_payload(&self, entry_id: &str, payload: &[u8]) -> Result<(), String> {
        if entry_id != "config" {
            return Err(format!("Unknown host.workspace payload {entry_id}"));
        }
        serde_yaml::from_slice::<serde_yaml::Value>(payload)
            .map(|_| ())
            .map_err(|error| format!("Host workspace config is invalid YAML: {error}"))
    }
}

/// Classifies recovery exports copied from the predecessor profile.
///
/// Shipctl does not consume these files and must not silently include them in
/// a portable snapshot, but migration deliberately preserves them in-place.
/// Claiming the directory as reference-only keeps classification complete
/// without turning an obsolete recovery artifact into live application state.
pub struct LegacyStateSnapshotProvider;

impl SnapshotProvider for LegacyStateSnapshotProvider {
    fn id(&self) -> &'static str {
        "host.legacy_state"
    }

    fn schema_version(&self) -> u32 {
        1
    }

    fn entries(&self) -> Vec<SnapshotEntryDeclaration> {
        vec![SnapshotEntryDeclaration {
            id: "session_recovery",
            classification: SnapshotClassification::ReferenceOnly,
            source_paths: vec![PathBuf::from(LEGACY_SESSION_RECOVERY_ROOT)],
            target_path: None,
            redaction: "legacy recovery exports remain in the source profile and are not restored",
        }]
    }

    fn capture(&self) -> Result<Vec<CapturedSnapshotEntry>, String> {
        Ok(vec![excluded_capture("session_recovery")])
    }

    fn validate_payload(&self, entry_id: &str, _payload: &[u8]) -> Result<(), String> {
        Err(format!(
            "Legacy state entry {entry_id} is excluded and cannot carry a payload"
        ))
    }

    fn owns_source_path(&self, source_path: &Path) -> bool {
        source_path
            .strip_prefix(LEGACY_SESSION_RECOVERY_ROOT)
            .is_ok()
    }
}

pub struct UiSnapshotProvider {
    path: PathBuf,
}

pub struct WorkspaceLayoutSnapshotProvider {
    path: PathBuf,
}

impl WorkspaceLayoutSnapshotProvider {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl SnapshotProvider for WorkspaceLayoutSnapshotProvider {
    fn id(&self) -> &'static str {
        "host.canvas_layout"
    }

    fn schema_version(&self) -> u32 {
        1
    }

    fn entries(&self) -> Vec<SnapshotEntryDeclaration> {
        vec![portable_entry("persistence", "workspace-layouts.json")]
    }

    fn capture(&self) -> Result<Vec<CapturedSnapshotEntry>, String> {
        Ok(vec![optional_file("persistence", &self.path)?])
    }

    fn validate_payload(&self, entry_id: &str, payload: &[u8]) -> Result<(), String> {
        if entry_id != "persistence" {
            return Err(format!("Unknown host.canvas_layout payload {entry_id}"));
        }
        WorkspaceLayoutStore::validate_serialized_document(payload)
    }
}

impl UiSnapshotProvider {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl SnapshotProvider for UiSnapshotProvider {
    fn id(&self) -> &'static str {
        "host.ui"
    }

    fn schema_version(&self) -> u32 {
        1
    }

    fn entries(&self) -> Vec<SnapshotEntryDeclaration> {
        vec![portable_entry("persistence", "ui-state.json")]
    }

    fn capture(&self) -> Result<Vec<CapturedSnapshotEntry>, String> {
        Ok(vec![optional_file("persistence", &self.path)?])
    }

    fn validate_payload(&self, entry_id: &str, payload: &[u8]) -> Result<(), String> {
        if entry_id != "persistence" {
            return Err(format!("Unknown host.ui payload {entry_id}"));
        }
        serde_json::from_slice::<serde_json::Value>(payload)
            .map(|_| ())
            .map_err(|error| format!("Host UI state is invalid JSON: {error}"))
    }
}

fn portable_entry(id: &'static str, relative: &'static str) -> SnapshotEntryDeclaration {
    SnapshotEntryDeclaration {
        id,
        classification: SnapshotClassification::Portable,
        source_paths: vec![PathBuf::from(relative)],
        target_path: Some(PathBuf::from(relative)),
        redaction: "none",
    }
}

fn excluded_entry(
    id: &'static str,
    classification: SnapshotClassification,
    redaction: &'static str,
) -> SnapshotEntryDeclaration {
    SnapshotEntryDeclaration {
        id,
        classification,
        source_paths: Vec::new(),
        target_path: None,
        redaction,
    }
}

fn optional_file(id: &'static str, path: &PathBuf) -> Result<CapturedSnapshotEntry, String> {
    let payload = if path.exists() {
        Some(fs::read(path).map_err(|error| {
            format!(
                "Could not capture durable source {}: {error}",
                path.display()
            )
        })?)
    } else {
        None
    };
    Ok(CapturedSnapshotEntry {
        id,
        decision: if payload.is_some() {
            "included".to_string()
        } else {
            "source_absent".to_string()
        },
        payload,
    })
}

fn excluded_capture(id: &'static str) -> CapturedSnapshotEntry {
    CapturedSnapshotEntry {
        id,
        payload: None,
        decision: "excluded_by_classification".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_session_recovery_is_classified_but_excluded() {
        let provider = LegacyStateSnapshotProvider;

        assert!(provider.owns_source_path(Path::new("session-recovery/live-agent-sessions.json")));
        assert!(!provider.owns_source_path(Path::new("unknown.cache")));

        let declaration = provider.entries().remove(0);
        assert_eq!(
            declaration.classification,
            SnapshotClassification::ReferenceOnly
        );
        assert_eq!(
            declaration.source_paths,
            vec![PathBuf::from(LEGACY_SESSION_RECOVERY_ROOT)]
        );
        assert!(declaration.target_path.is_none());

        let capture = provider.capture().unwrap().remove(0);
        assert!(capture.payload.is_none());
        assert_eq!(capture.decision, "excluded_by_classification");
    }
}
