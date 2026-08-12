//! Narrow native contracts shared by the Shipctl host and internal modules.
//!
//! Contracts are added only when an extracted module needs a stable host
//! authority. Terminal transport DTOs live here so provider modules can launch
//! through the host PTY service without importing host implementation types.

#![forbid(unsafe_code)]

pub mod terminal_host;
pub use terminal_host::*;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
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

    /// Whether this provider owns a discovered durable file that is not one of
    /// its statically declared paths. Providers must opt in explicitly; this
    /// preserves fail-closed archive classification for ordinary files while
    /// allowing a provider-owned configuration directory.
    fn owns_source_path(&self, source_path: &Path) -> bool {
        self.entries()
            .iter()
            .flat_map(|entry| entry.source_paths.iter())
            .any(|declared| declared == source_path)
    }

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

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalColorTheme {
    pub foreground: String,
    pub background: String,
    pub palette: Vec<String>,
}

/// Opaque identity of a host-owned terminal exposed to removable modules.
/// Modules may persist or compare it, but cannot construct host terminal state.
#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ModuleTerminalId(String);

impl ModuleTerminalId {
    pub fn from_host(value: String) -> Result<Self, String> {
        if value.trim().is_empty() {
            return Err("The host returned an empty terminal ID".to_string());
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ModuleTerminalId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Safe terminal launch intent shared by a module and its host adapter.
/// Raw output is deliberately absent: renderers attach independently.
pub struct ModuleTerminalSpawnRequest {
    pub module_id: String,
    pub module_session_id: String,
    pub command: String,
    pub arguments: Vec<String>,
    pub cwd: String,
    pub project_path: String,
    pub owner_key: String,
    pub label: String,
    pub owner_metadata: serde_json::Value,
    pub presentation: Option<serde_json::Value>,
    pub environment: HashMap<String, String>,
    pub columns: u16,
    pub rows: u16,
    pub color_theme: TerminalColorTheme,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ModuleTerminalCloseResult {
    pub existed: bool,
}

/// Transport-neutral terminal authority implemented by the Shipctl host.
pub trait TerminalAuthority: Send + Sync {
    fn spawn(&self, request: ModuleTerminalSpawnRequest) -> Result<ModuleTerminalId, String>;
    fn close(&self, terminal_id: &ModuleTerminalId) -> Result<ModuleTerminalCloseResult, String>;
}

#[cfg(test)]
mod tests {
    use super::{DurableWriteBarrier, ModuleTerminalId};

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

    #[test]
    fn terminal_ids_are_opaque_nonempty_strings() {
        let id = ModuleTerminalId::from_host("host-terminal-id".to_string()).unwrap();
        assert_eq!(id.as_str(), "host-terminal-id");
        assert_eq!(serde_json::to_string(&id).unwrap(), "\"host-terminal-id\"");
        assert!(ModuleTerminalId::from_host("  ".to_string()).is_err());
    }
}
