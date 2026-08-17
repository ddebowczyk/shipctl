use std::fs;
use std::path::PathBuf;

use crate::state::{
    CapturedSnapshotEntry, SnapshotClassification, SnapshotEntryDeclaration, SnapshotProvider,
};
use rusqlite::backup::{Backup, StepResult};
use rusqlite::{Connection, OpenFlags};
use tempfile::NamedTempFile;

use super::ModuleRegistry;

pub struct ModuleRegistrySnapshotProvider {
    path: PathBuf,
}

impl ModuleRegistrySnapshotProvider {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn validated_snapshot(payload: &[u8]) -> Result<super::RegistrySnapshot, String> {
        let temporary = NamedTempFile::new()
            .map_err(|error| format!("Could not create registry validation file: {error}"))?;
        fs::write(temporary.path(), payload)
            .map_err(|error| format!("Could not stage registry validation payload: {error}"))?;
        ModuleRegistry::open_read_only_path(temporary.path())
            .and_then(|registry| registry.snapshot())
            .map_err(|error| error.to_string())
    }
}

impl SnapshotProvider for ModuleRegistrySnapshotProvider {
    fn id(&self) -> &'static str {
        "modules.registry"
    }

    fn schema_version(&self) -> u32 {
        1
    }

    fn entries(&self) -> Vec<SnapshotEntryDeclaration> {
        vec![SnapshotEntryDeclaration {
            id: "database",
            classification: SnapshotClassification::Portable,
            source_paths: vec![PathBuf::from("module-registry.sqlite3")],
            target_path: Some(PathBuf::from("module-registry.sqlite3")),
            redaction: "canonical module contracts only; no credentials",
        }]
    }

    fn capture(&self) -> Result<Vec<CapturedSnapshotEntry>, String> {
        if !self.path.exists() {
            return Ok(vec![CapturedSnapshotEntry {
                id: "database",
                payload: None,
                decision: "source_absent".to_string(),
            }]);
        }

        let source = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|error| format!("Could not open module registry for snapshot: {error}"))?;
        let temporary = NamedTempFile::new()
            .map_err(|error| format!("Could not create registry snapshot file: {error}"))?;
        let mut destination = Connection::open(temporary.path())
            .map_err(|error| format!("Could not open registry snapshot destination: {error}"))?;
        let backup = Backup::new(&source, &mut destination)
            .map_err(|error| format!("Could not start registry snapshot: {error}"))?;
        if backup
            .step(-1)
            .map_err(|error| format!("Could not copy registry snapshot: {error}"))?
            != StepResult::Done
        {
            return Err("Registry snapshot did not complete atomically".to_string());
        }
        drop(backup);
        drop(destination);
        let payload = fs::read(temporary.path())
            .map_err(|error| format!("Could not read registry snapshot: {error}"))?;
        Self::validated_snapshot(&payload)?;
        Ok(vec![CapturedSnapshotEntry {
            id: "database",
            payload: Some(payload),
            decision: "included".to_string(),
        }])
    }

    fn validate_payload(&self, entry_id: &str, payload: &[u8]) -> Result<(), String> {
        if entry_id != "database" {
            return Err(format!("Unknown modules.registry payload {entry_id}"));
        }
        Self::validated_snapshot(payload).map(|_| ())
    }

    fn canonical_payload(&self, entry_id: &str, payload: &[u8]) -> Result<Vec<u8>, String> {
        if entry_id != "database" {
            return Err(format!("Unknown modules.registry payload {entry_id}"));
        }
        let mut snapshot = Self::validated_snapshot(payload)?;
        // The validation database path is process-local evidence, not module
        // registry state. Excluding it makes the canonical digest portable
        // across capture, archive verification, and restore staging.
        snapshot.registry_path = PathBuf::new();
        serde_json::to_vec(&snapshot)
            .map_err(|error| format!("Could not canonicalize module registry: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::paths::ShipctlPaths;
    use crate::state::SnapshotProvider;
    use tempfile::TempDir;

    #[test]
    fn captures_a_coherent_portable_registry_database() {
        let temporary = TempDir::new().unwrap();
        let paths = ShipctlPaths::new(
            temporary.path().join("state"),
            temporary.path().join("runtime"),
        );
        drop(ModuleRegistry::open_writable(&paths).unwrap());
        let provider = ModuleRegistrySnapshotProvider::new(paths.module_registry_database);

        let capture = provider.capture().unwrap().pop().unwrap();
        let payload = capture.payload.unwrap();
        provider.validate_payload("database", &payload).unwrap();
        let canonical = provider.canonical_payload("database", &payload).unwrap();
        assert!(!canonical.is_empty());
        assert_eq!(
            canonical,
            provider.canonical_payload("database", &payload).unwrap(),
            "canonical state cannot contain the random validation path"
        );
    }
}
