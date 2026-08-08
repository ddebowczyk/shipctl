//! Narrow native contracts shared by the Shipctl host and internal modules.
//!
//! Contracts are added only when an extracted module needs a stable host
//! authority. Terminal transport DTOs live here so provider modules can launch
//! through the host PTY service without importing host implementation types.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};

/// Coordinates durable mutations across the host and all installed modules.
///
/// Normal writers take a shared guard. A state snapshot takes the exclusive
/// guard, which gives every provider one coherent cross-capability boundary
/// without teaching the host how the provider stores its data.
#[derive(Clone, Default)]
pub struct DurableWriteBarrier {
    lock: Arc<RwLock<()>>,
}

impl DurableWriteBarrier {
    pub fn enter_update(&self) -> Result<RwLockReadGuard<'_, ()>, String> {
        self.lock
            .read()
            .map_err(|_| "Durable write barrier is poisoned".to_string())
    }

    pub fn freeze(&self) -> Result<RwLockWriteGuard<'_, ()>, String> {
        self.lock
            .write()
            .map_err(|_| "Durable write barrier is poisoned".to_string())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotClassification {
    Portable,
    ReferenceOnly,
    Secret,
    LiveOnly,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SnapshotEntryDeclaration {
    pub id: &'static str,
    pub classification: SnapshotClassification,
    /// Physical paths, relative to the instance state root, whose existence is
    /// classified by this entry. Logical exclusions may leave this empty.
    pub source_paths: Vec<PathBuf>,
    /// Promotion path for a portable payload. Exclusions have no target.
    pub target_path: Option<PathBuf>,
    pub redaction: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapturedSnapshotEntry {
    pub id: &'static str,
    pub payload: Option<Vec<u8>>,
    pub decision: String,
}

/// A durable state owner participating in save, offline validation, and
/// restore. Providers own payload schema; the coordinator owns archive safety,
/// atomicity, classification completeness, and cross-provider consistency.
pub trait SnapshotProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn schema_version(&self) -> u32;
    fn entries(&self) -> Vec<SnapshotEntryDeclaration>;
    fn capture(&self) -> Result<Vec<CapturedSnapshotEntry>, String>;
    fn validate_payload(&self, entry_id: &str, payload: &[u8]) -> Result<(), String>;

    /// Return the provider-owned canonical representation used to compare
    /// restorable state across save/restore boundaries. The default is exact
    /// payload identity; structured stores can exclude storage-engine layout
    /// while retaining every logical value.
    fn canonical_payload(&self, _entry_id: &str, payload: &[u8]) -> Result<Vec<u8>, String> {
        Ok(payload.to_vec())
    }

    fn restore_payload(
        &self,
        entry_id: &str,
        payload: &[u8],
        staging_state_root: &Path,
    ) -> Result<(), String> {
        let declaration = self
            .entries()
            .into_iter()
            .find(|entry| entry.id == entry_id)
            .ok_or_else(|| format!("Provider {} does not declare entry {entry_id}", self.id()))?;
        let relative = declaration
            .target_path
            .ok_or_else(|| format!("Provider {} entry {entry_id} is not restorable", self.id()))?;
        let target = staging_state_root.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create restore directory: {error}"))?;
        }
        std::fs::write(&target, payload).map_err(|error| {
            format!("Could not restore {} entry {entry_id}: {error}", self.id())
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).map_err(
                |error| {
                    format!(
                        "Could not secure restored {} entry {entry_id}: {error}",
                        self.id()
                    )
                },
            )?;
        }
        Ok(())
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum TerminalOutput {
    #[serde(rename = "data")]
    Data(String),
    #[serde(rename = "exit")]
    Exit { code: i32 },
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalColorTheme {
    pub foreground: String,
    pub background: String,
    pub palette: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::DurableWriteBarrier;

    #[test]
    fn updates_and_snapshot_freezes_are_mutually_exclusive() {
        let barrier = DurableWriteBarrier::default();
        let update = barrier.enter_update().unwrap();
        assert!(barrier.lock.try_write().is_err());
        drop(update);

        let freeze = barrier.freeze().unwrap();
        assert!(barrier.lock.try_read().is_err());
        drop(freeze);

        assert!(barrier.lock.try_read().is_ok());
        assert!(barrier.lock.try_write().is_ok());
    }
}
