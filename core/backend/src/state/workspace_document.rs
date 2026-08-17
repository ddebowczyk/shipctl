//! Instance-owned compare-and-save storage for semantic workspace documents.
//!
//! This store deliberately does not know Layman, React, or the semantic
//! document grammar. TypeScript owns that grammar. Native code owns only the
//! durable envelope, opaque JSON-object payload, revision boundary, and atomic
//! file replacement needed by the Tauri transport.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::DurableWriteBarrier;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const WORKSPACE_DOCUMENT_STORE_SCHEMA_VERSION: u32 = 1;
pub const WORKSPACE_DOCUMENT_PERSISTENCE_SCHEMA_VERSION: u32 = 2;
/// JavaScript transports these revisions as IEEE-754 numbers. This is its
/// exact integer boundary, not a product quota.
pub const MAX_SAFE_WORKSPACE_DOCUMENT_REVISION: u64 = 9_007_199_254_740_991;

/// The cross-process envelope for one renderer-neutral workspace document.
/// `document` remains opaque to this native store after it is confirmed to be
/// a JSON object. The TypeScript workspace capability parses its full grammar.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceDocumentRecord {
    pub storage_schema_version: u32,
    pub workspace_id: String,
    pub revision: u64,
    pub origin_id: String,
    pub catalog_revision: u64,
    pub document: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WorkspaceDocumentSaveResult {
    Saved {
        record: WorkspaceDocumentRecord,
    },
    /// A missing `current` is meaningful when a caller tried to update a
    /// workspace it has not loaded. It is not serialized as a made-up record.
    Conflict {
        current: Option<WorkspaceDocumentRecord>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceDocumentError {
    code: &'static str,
    message: String,
}

impl WorkspaceDocumentError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub const fn code(&self) -> &'static str {
        self.code
    }

    fn storage(message: impl Into<String>) -> Self {
        Self::new("WORKSPACE_DOCUMENT_STORAGE_ERROR", message)
    }

    fn invalid_document(message: impl Into<String>) -> Self {
        Self::new("WORKSPACE_DOCUMENT_STORAGE_INVALID", message)
    }

    fn unsupported_document_schema(version: u32) -> Self {
        Self::new(
            "WORKSPACE_DOCUMENT_STORAGE_SCHEMA_UNSUPPORTED",
            format!(
                "Workspace document storage schema {version} is unsupported; expected {WORKSPACE_DOCUMENT_STORE_SCHEMA_VERSION}."
            ),
        )
    }

    fn unsupported_record_schema(version: u32) -> Self {
        Self::new(
            "WORKSPACE_DOCUMENT_RECORD_SCHEMA_UNSUPPORTED",
            format!(
                "Workspace document record schema {version} is unsupported; expected {WORKSPACE_DOCUMENT_PERSISTENCE_SCHEMA_VERSION}."
            ),
        )
    }

    fn invalid_identity(label: &str) -> Self {
        Self::new(
            "WORKSPACE_DOCUMENT_IDENTITY_INVALID",
            format!("{label} must be a non-empty string."),
        )
    }

    fn invalid_revision(message: impl Into<String>) -> Self {
        Self::new("WORKSPACE_DOCUMENT_REVISION_INVALID", message)
    }

    fn invalid_payload(message: impl Into<String>) -> Self {
        Self::new("WORKSPACE_DOCUMENT_PAYLOAD_INVALID", message)
    }
}

impl fmt::Display for WorkspaceDocumentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for WorkspaceDocumentError {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceDocumentStoreFile {
    schema_version: u32,
    records: BTreeMap<String, WorkspaceDocumentRecord>,
}

impl Default for WorkspaceDocumentStoreFile {
    fn default() -> Self {
        Self {
            schema_version: WORKSPACE_DOCUMENT_STORE_SCHEMA_VERSION,
            records: BTreeMap::new(),
        }
    }
}

/// Native persistence authority for one instance's semantic workspace records.
pub struct WorkspaceDocumentStore {
    path: PathBuf,
    lock: Mutex<()>,
    durable_writes: DurableWriteBarrier,
}

impl WorkspaceDocumentStore {
    pub fn new(path: PathBuf) -> Self {
        Self::new_with_barrier(path, DurableWriteBarrier::default())
    }

    pub fn new_with_barrier(path: PathBuf, durable_writes: DurableWriteBarrier) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
            durable_writes,
        }
    }

    pub fn load(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceDocumentRecord>, WorkspaceDocumentError> {
        validate_identity(workspace_id, "workspaceId")?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| WorkspaceDocumentError::storage("Workspace document lock is poisoned."))?;
        let file = read_file(&self.path)?;
        Ok(file.records.get(workspace_id).cloned())
    }

    pub fn save(
        &self,
        workspace_id: String,
        expected_revision: u64,
        record: WorkspaceDocumentRecord,
    ) -> Result<WorkspaceDocumentSaveResult, WorkspaceDocumentError> {
        validate_identity(&workspace_id, "workspaceId")?;
        validate_revision(expected_revision)?;
        validate_record(&record)?;
        if record.workspace_id != workspace_id {
            return Err(WorkspaceDocumentError::invalid_document(
                "Workspace document save key does not match record workspaceId.",
            ));
        }
        let next_revision = expected_revision.checked_add(1).ok_or_else(|| {
            WorkspaceDocumentError::invalid_revision(
                "Workspace document revision cannot advance safely.",
            )
        })?;
        validate_persisted_revision(next_revision)?;
        if record.revision != next_revision {
            return Err(WorkspaceDocumentError::invalid_revision(
                "Workspace document record revision does not advance from expectedRevision by one.",
            ));
        }

        let _durable_update = self.durable_writes.enter_update().map_err(|message| {
            WorkspaceDocumentError::storage(format!(
                "Workspace document write is unavailable: {message}"
            ))
        })?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| WorkspaceDocumentError::storage("Workspace document lock is poisoned."))?;
        let mut file = read_file(&self.path)?;
        let current = file.records.get(&workspace_id).cloned();
        let current_revision = current.as_ref().map_or(0, |existing| existing.revision);
        if expected_revision != current_revision {
            return Ok(WorkspaceDocumentSaveResult::Conflict { current });
        }

        file.records.insert(workspace_id, record.clone());
        write_file(&self.path, &file)?;
        Ok(WorkspaceDocumentSaveResult::Saved { record })
    }

    pub fn validate_serialized_document(payload: &[u8]) -> Result<(), String> {
        decode_file(payload)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

fn read_file(path: &Path) -> Result<WorkspaceDocumentStoreFile, WorkspaceDocumentError> {
    if !path.exists() {
        return Ok(WorkspaceDocumentStoreFile::default());
    }
    let source = fs::read(path).map_err(|error| {
        WorkspaceDocumentError::storage(format!(
            "Could not read workspace document storage {}: {error}",
            path.display()
        ))
    })?;
    decode_file(&source)
}

fn decode_file(payload: &[u8]) -> Result<WorkspaceDocumentStoreFile, WorkspaceDocumentError> {
    let file = serde_json::from_slice::<WorkspaceDocumentStoreFile>(payload).map_err(|error| {
        WorkspaceDocumentError::invalid_document(format!(
            "Workspace document storage is invalid JSON: {error}"
        ))
    })?;
    validate_file(&file)?;
    Ok(file)
}

fn write_file(
    path: &Path,
    file: &WorkspaceDocumentStoreFile,
) -> Result<(), WorkspaceDocumentError> {
    let parent = path.parent().ok_or_else(|| {
        WorkspaceDocumentError::storage("Workspace document storage path has no parent directory.")
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        WorkspaceDocumentError::storage(format!(
            "Could not create workspace document directory: {error}"
        ))
    })?;
    let temporary = parent.join(format!(".workspace-documents-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let bytes = serde_json::to_vec_pretty(file).map_err(|error| {
            WorkspaceDocumentError::storage(format!(
                "Could not serialize workspace document storage: {error}"
            ))
        })?;
        fs::write(&temporary, bytes).map_err(|error| {
            WorkspaceDocumentError::storage(format!(
                "Could not stage workspace document storage {}: {error}",
                temporary.display()
            ))
        })?;
        fs::rename(&temporary, path).map_err(|error| {
            WorkspaceDocumentError::storage(format!(
                "Could not publish workspace document storage {}: {error}",
                path.display()
            ))
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn validate_file(file: &WorkspaceDocumentStoreFile) -> Result<(), WorkspaceDocumentError> {
    if file.schema_version != WORKSPACE_DOCUMENT_STORE_SCHEMA_VERSION {
        return Err(WorkspaceDocumentError::unsupported_document_schema(
            file.schema_version,
        ));
    }
    for (workspace_id, record) in &file.records {
        if workspace_id != &record.workspace_id {
            return Err(WorkspaceDocumentError::invalid_document(
                "A workspace document storage key does not match its record workspaceId.",
            ));
        }
        validate_record(record)?;
    }
    Ok(())
}

fn validate_record(record: &WorkspaceDocumentRecord) -> Result<(), WorkspaceDocumentError> {
    if record.storage_schema_version != WORKSPACE_DOCUMENT_PERSISTENCE_SCHEMA_VERSION {
        return Err(WorkspaceDocumentError::unsupported_record_schema(
            record.storage_schema_version,
        ));
    }
    validate_identity(&record.workspace_id, "workspaceId")?;
    validate_identity(&record.origin_id, "originId")?;
    validate_persisted_revision(record.revision)?;
    validate_revision(record.catalog_revision)?;
    if !record.document.is_object() {
        return Err(WorkspaceDocumentError::invalid_payload(
            "Workspace document payload must be a JSON object.",
        ));
    }
    Ok(())
}

fn validate_identity(value: &str, label: &str) -> Result<(), WorkspaceDocumentError> {
    if value.trim().is_empty() {
        return Err(WorkspaceDocumentError::invalid_identity(label));
    }
    Ok(())
}

fn validate_revision(revision: u64) -> Result<(), WorkspaceDocumentError> {
    if revision > MAX_SAFE_WORKSPACE_DOCUMENT_REVISION {
        return Err(WorkspaceDocumentError::invalid_revision(format!(
            "Workspace document revision exceeds the JavaScript safe integer boundary {MAX_SAFE_WORKSPACE_DOCUMENT_REVISION}."
        )));
    }
    Ok(())
}

fn validate_persisted_revision(revision: u64) -> Result<(), WorkspaceDocumentError> {
    if revision == 0 {
        return Err(WorkspaceDocumentError::invalid_revision(
            "Persisted workspace document revisions must be at least 1.",
        ));
    }
    validate_revision(revision)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const WORKSPACE_ID: &str = "shipctl.workspace";

    fn root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "shipctl-workspace-document-{label}-{}",
            Uuid::new_v4()
        ))
    }

    fn record(revision: u64, origin_id: &str, catalog_revision: u64) -> WorkspaceDocumentRecord {
        WorkspaceDocumentRecord {
            storage_schema_version: WORKSPACE_DOCUMENT_PERSISTENCE_SCHEMA_VERSION,
            workspace_id: WORKSPACE_ID.into(),
            revision,
            origin_id: origin_id.into(),
            catalog_revision,
            document: json!({
                "schemaVersion": 1,
                "workspaceId": WORKSPACE_ID,
                "profileId": "shipctl.test",
                "instances": [],
                "root": null,
                "floating": [],
                "maximizedStackId": null,
            }),
        }
    }

    fn save(
        store: &WorkspaceDocumentStore,
        expected_revision: u64,
        record: WorkspaceDocumentRecord,
    ) -> WorkspaceDocumentSaveResult {
        store
            .save(WORKSPACE_ID.into(), expected_revision, record)
            .unwrap()
    }

    #[test]
    fn missing_document_loads_as_no_record() {
        let root = root("missing");
        let store = WorkspaceDocumentStore::new(root.join("workspace-documents.json"));

        assert_eq!(store.load(WORKSPACE_ID).unwrap(), None);
        assert!(!root.exists());
    }

    #[test]
    fn semantic_document_round_trips_as_an_opaque_record() {
        let root = root("round-trip");
        let path = root.join("workspace-documents.json");
        let store = WorkspaceDocumentStore::new(path.clone());
        let expected = record(1, "workspace-test", 0);

        let saved = save(&store, 0, expected.clone());
        assert_eq!(
            saved,
            WorkspaceDocumentSaveResult::Saved {
                record: expected.clone()
            }
        );
        assert_eq!(store.load(WORKSPACE_ID).unwrap(), Some(expected));
        assert!(path.exists());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_save_returns_current_record_without_replacing_it() {
        let root = root("conflict");
        let store = WorkspaceDocumentStore::new(root.join("workspace-documents.json"));
        let _ = save(&store, 0, record(1, "first", 0));
        let latest_record = record(2, "second", 4);
        let latest = save(&store, 1, latest_record.clone());
        assert_eq!(
            latest,
            WorkspaceDocumentSaveResult::Saved {
                record: latest_record.clone()
            }
        );

        let stale = save(&store, 1, record(2, "stale", 5));
        assert_eq!(
            stale,
            WorkspaceDocumentSaveResult::Conflict {
                current: Some(latest_record.clone()),
            }
        );
        assert_eq!(store.load(WORKSPACE_ID).unwrap(), Some(latest_record));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_current_record_is_an_explicit_empty_conflict() {
        let root = root("missing-conflict-record");
        let store = WorkspaceDocumentStore::new(root.join("workspace-documents.json"));

        assert_eq!(
            save(&store, 1, record(2, "stale", 1)),
            WorkspaceDocumentSaveResult::Conflict { current: None }
        );
        assert_eq!(store.load(WORKSPACE_ID).unwrap(), None);
        assert!(!root.exists());
    }

    #[test]
    fn invalid_records_do_not_overwrite_a_valid_record() {
        let root = root("invalid-record");
        let path = root.join("workspace-documents.json");
        let store = WorkspaceDocumentStore::new(path.clone());
        let saved = record(1, "first", 0);
        let _ = save(&store, 0, saved.clone());
        let bytes = std::fs::read(&path).unwrap();

        let mut invalid_payload = record(2, "second", 1);
        invalid_payload.document = json!([]);
        let error = store
            .save(WORKSPACE_ID.into(), 1, invalid_payload)
            .unwrap_err();
        assert_eq!(error.code(), "WORKSPACE_DOCUMENT_PAYLOAD_INVALID");

        let mut invalid_revision = record(4, "second", 1);
        invalid_revision.revision = 4;
        let error = store
            .save(WORKSPACE_ID.into(), 1, invalid_revision)
            .unwrap_err();
        assert_eq!(error.code(), "WORKSPACE_DOCUMENT_REVISION_INVALID");

        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(store.load(WORKSPACE_ID).unwrap(), Some(saved));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn obsolete_storage_schema_is_rejected_instead_of_assumed_current() {
        let root = root("obsolete-storage");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("workspace-documents.json");
        std::fs::write(&path, br#"{"schemaVersion":0,"records":{}}"#).unwrap();
        let store = WorkspaceDocumentStore::new(path);

        let error = store.load(WORKSPACE_ID).unwrap_err();
        assert_eq!(
            error.code(),
            "WORKSPACE_DOCUMENT_STORAGE_SCHEMA_UNSUPPORTED"
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn independent_instance_paths_do_not_share_workspace_documents() {
        let root = root("isolated");
        let first = WorkspaceDocumentStore::new(root.join("first/workspace-documents.json"));
        let second = WorkspaceDocumentStore::new(root.join("second/workspace-documents.json"));

        let _ = save(&first, 0, record(1, "first", 0));
        assert!(first.load(WORKSPACE_ID).unwrap().is_some());
        assert_eq!(second.load(WORKSPACE_ID).unwrap(), None);

        std::fs::remove_dir_all(root).unwrap();
    }
}
