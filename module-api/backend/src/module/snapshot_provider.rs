use std::path::Path;

use crate::protocol::{CapturedSnapshotEntry, SnapshotEntryDeclaration};

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
