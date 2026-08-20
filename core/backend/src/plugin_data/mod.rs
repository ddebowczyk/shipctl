//! Activation-scoped durable records for TypeScript plugins.
//!
//! The store owns persistence mechanics, transaction boundaries, and generic
//! grant enforcement. TypeScript artifact policy owns record names, schema
//! grammar, defaults, and migrations.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::state::DurableWriteBarrier;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

const DOCUMENT_SCHEMA_VERSION: u32 = 1;
const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PluginDataScope {
    Global,
    Project { project_id: String },
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub enum PluginDataGrant {
    #[serde(rename = "plugin-data.read")]
    Read,
    #[serde(rename = "plugin-data.write")]
    Write,
    #[serde(rename = "plugin-data.migrate")]
    Migrate,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDataActor {
    pub module_id: String,
    pub activation_id: String,
    pub effective_grants: BTreeSet<PluginDataGrant>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDataMigrationProvenance {
    pub migration_id: String,
    pub from_schema_version: u32,
    pub to_schema_version: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDataRecord {
    pub owner_module_id: String,
    pub scope: PluginDataScope,
    pub key: String,
    pub schema_version: u32,
    pub revision: u64,
    pub value: Value,
    // The TypeScript plugin-data contract requires an explicit array even
    // when a record has no migration provenance yet. Keep `default` for
    // backward-compatible reads of documents written by older hosts.
    #[serde(default)]
    pub migrations: Vec<PluginDataMigrationProvenance>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDataWrite {
    pub scope: PluginDataScope,
    pub key: String,
    pub expected_revision: Option<u64>,
    pub schema_version: u32,
    pub value: Value,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDataMigrationWrite {
    pub scope: PluginDataScope,
    pub key: String,
    pub expected_revision: u64,
    pub from_schema_version: u32,
    pub to_schema_version: u32,
    pub value: Value,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDataMigrationTransaction {
    pub migration_id: String,
    pub records: Vec<PluginDataMigrationWrite>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDataMigrationReceipt {
    pub migration_id: String,
    pub records: Vec<PluginDataRecord>,
    pub replayed: bool,
}

/// A read-only, generic record-map input for one-way plugin-data migration.
///
/// The source deliberately knows only a JSON envelope with `schemaVersion` and
/// `records` fields. The composing shell supplies the owner, scope, key prefix,
/// and path; TypeScript owns the meaning and normalization of each opaque
/// record value. Once a plugin-data record exists it always shadows this
/// source, so this type can never become a second writer or durable authority.
#[derive(Clone, Debug)]
pub struct LegacyPluginDataRecordMapSource {
    path: PathBuf,
    owner_module_id: String,
    scope: PluginDataScope,
    key_prefix: String,
    source_schema_version: u32,
}

impl LegacyPluginDataRecordMapSource {
    pub fn new(
        path: PathBuf,
        owner_module_id: String,
        scope: PluginDataScope,
        key_prefix: String,
        source_schema_version: u32,
    ) -> Result<Self, String> {
        validate_identity(&owner_module_id, "legacy source owner module ID")?;
        validate_identity(&key_prefix, "legacy source key prefix")?;
        match &scope {
            PluginDataScope::Global => {}
            PluginDataScope::Project { project_id } => {
                validate_identity(project_id, "legacy source project ID")?;
            }
        }
        validate_schema_version(source_schema_version)?;
        Ok(Self {
            path,
            owner_module_id,
            scope,
            key_prefix,
            source_schema_version,
        })
    }

    fn read_record(
        &self,
        module_id: &str,
        scope: &PluginDataScope,
        key: &str,
    ) -> Result<Option<PluginDataRecord>, String> {
        if self.owner_module_id != module_id || self.scope != *scope {
            return Ok(None);
        }
        let Some(record_id) = key.strip_prefix(&self.key_prefix) else {
            return Ok(None);
        };
        if record_id.is_empty() {
            return Ok(None);
        }
        validate_identity(record_id, "legacy source record ID")?;
        if !self.path.exists() {
            return Ok(None);
        }
        let payload = fs::read(&self.path).map_err(|failure| {
            error(
                "storage-failed",
                format!(
                    "Could not read legacy plugin data source {}: {failure}",
                    self.path.display()
                ),
            )
        })?;
        let document = serde_json::from_slice::<Value>(&payload).map_err(|failure| {
            error(
                "storage-failed",
                format!(
                    "Legacy plugin data source {} is invalid JSON: {failure}",
                    self.path.display()
                ),
            )
        })?;
        let source_schema = document.get("schemaVersion").and_then(Value::as_u64);
        if source_schema != Some(u64::from(self.source_schema_version)) {
            return Err(error(
                "storage-failed",
                format!(
                    "Legacy plugin data source {} has unsupported schema version",
                    self.path.display()
                ),
            ));
        }
        let records = document
            .get("records")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                error(
                    "storage-failed",
                    format!(
                        "Legacy plugin data source {} has no records map",
                        self.path.display()
                    ),
                )
            })?;
        let Some(value) = records.get(record_id).cloned() else {
            return Ok(None);
        };
        validate_json_value(&value)?;
        Ok(Some(PluginDataRecord {
            owner_module_id: module_id.to_string(),
            scope: scope.clone(),
            key: key.to_string(),
            // Revision zero is exclusively the read-only source boundary. A
            // successful write or migration creates the first durable record
            // at revision one.
            schema_version: self.source_schema_version,
            revision: 0,
            value,
            migrations: Vec::new(),
        }))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginDataDocument {
    #[serde(default = "document_schema_version")]
    schema_version: u32,
    #[serde(default)]
    records: BTreeMap<String, PluginDataRecord>,
}

fn document_schema_version() -> u32 {
    DOCUMENT_SCHEMA_VERSION
}

struct PluginDataServiceInner {
    path: PathBuf,
    lock: Mutex<()>,
    durable_writes: DurableWriteBarrier,
    legacy_record_maps: Vec<LegacyPluginDataRecordMapSource>,
}

#[derive(Clone)]
pub struct PluginDataService {
    inner: Arc<PluginDataServiceInner>,
}

impl PluginDataService {
    pub fn new_with_barrier(path: PathBuf, durable_writes: DurableWriteBarrier) -> Self {
        Self::with_legacy_record_maps(path, durable_writes, Vec::new())
    }

    /// Compose generic, read-only migration inputs without teaching the
    /// plugin-data store any product record grammar or namespace policy.
    pub fn with_legacy_record_maps(
        path: PathBuf,
        durable_writes: DurableWriteBarrier,
        legacy_record_maps: Vec<LegacyPluginDataRecordMapSource>,
    ) -> Self {
        Self {
            inner: Arc::new(PluginDataServiceInner {
                path,
                lock: Mutex::new(()),
                durable_writes,
                legacy_record_maps,
            }),
        }
    }

    pub fn read_record(
        &self,
        actor: &PluginDataActor,
        scope: &PluginDataScope,
        key: &str,
    ) -> Result<Option<PluginDataRecord>, String> {
        self.validate_actor(actor)?;
        self.authorize(actor, key, PluginDataGrant::Read)?;
        self.validate_scope(scope)?;
        let _guard = self
            .inner
            .lock
            .lock()
            .map_err(|_| error("storage-failed", "Plugin data lock is poisoned"))?;
        let document = read_document(&self.inner.path)?;
        if let Some(record) = find_record(&document, &actor.module_id, scope, key) {
            return Ok(Some(record.clone()));
        }
        self.legacy_record(actor, scope, key)
    }

    pub fn write_record(
        &self,
        actor: &PluginDataActor,
        write: PluginDataWrite,
    ) -> Result<PluginDataRecord, String> {
        self.validate_actor(actor)?;
        self.authorize(actor, &write.key, PluginDataGrant::Write)?;
        self.validate_scope(&write.scope)?;
        validate_schema_version(write.schema_version)?;
        validate_json_value(&write.value)?;

        let _durable_update = self.inner.durable_writes.enter_update()?;
        let _guard = self
            .inner
            .lock
            .lock()
            .map_err(|_| error("storage-failed", "Plugin data lock is poisoned"))?;
        let mut document = read_document(&self.inner.path)?;
        let identity = record_identity(&actor.module_id, &write.scope, &write.key);
        let current = match document.records.get(&identity).cloned() {
            Some(record) => Some(record),
            None => self.legacy_record(actor, &write.scope, &write.key)?,
        };
        assert_expected_revision(write.expected_revision, current.as_ref())?;
        let revision = next_revision(current.as_ref())?;
        let record = PluginDataRecord {
            owner_module_id: actor.module_id.clone(),
            scope: write.scope,
            key: write.key,
            schema_version: write.schema_version,
            revision,
            value: write.value,
            migrations: current.map_or_else(Vec::new, |record| record.migrations),
        };
        document.records.insert(identity, record.clone());
        write_document(&self.inner.path, &document)?;
        Ok(record)
    }

    pub fn migrate_records(
        &self,
        actor: &PluginDataActor,
        transaction: PluginDataMigrationTransaction,
    ) -> Result<PluginDataMigrationReceipt, String> {
        self.validate_actor(actor)?;
        validate_identity(&transaction.migration_id, "migration ID")?;
        if transaction.records.is_empty() {
            return Err(error(
                "invalid-request",
                "A plugin data migration must contain at least one record",
            ));
        }
        let mut identities = BTreeSet::new();
        for write in &transaction.records {
            self.authorize(actor, &write.key, PluginDataGrant::Migrate)?;
            self.validate_scope(&write.scope)?;
            validate_schema_version(write.to_schema_version)?;
            if write.from_schema_version == write.to_schema_version {
                return Err(error(
                    "invalid-request",
                    "A plugin data migration must change the schema version",
                ));
            }
            validate_json_value(&write.value)?;
            if !identities.insert(record_identity(&actor.module_id, &write.scope, &write.key)) {
                return Err(error(
                    "invalid-request",
                    "A plugin data migration cannot repeat a record",
                ));
            }
        }

        let _durable_update = self.inner.durable_writes.enter_update()?;
        let _guard = self
            .inner
            .lock
            .lock()
            .map_err(|_| error("storage-failed", "Plugin data lock is poisoned"))?;
        let mut document = read_document(&self.inner.path)?;
        let mut current_records = Vec::with_capacity(transaction.records.len());
        for write in &transaction.records {
            self.authorize(actor, &write.key, PluginDataGrant::Migrate)?;
            let current =
                match find_record(&document, &actor.module_id, &write.scope, &write.key).cloned() {
                    Some(record) => Some(record),
                    None => self.legacy_record(actor, &write.scope, &write.key)?,
                }
                .ok_or_else(|| error("not-found", "Plugin data record was not found"))?;
            current_records.push(current);
        }

        let replayed = current_records
            .iter()
            .zip(&transaction.records)
            .all(|(current, write)| {
                current.migrations.iter().any(|migration| {
                    migration.migration_id == transaction.migration_id
                        && migration.from_schema_version == write.from_schema_version
                        && migration.to_schema_version == write.to_schema_version
                })
            });
        if replayed {
            return Ok(PluginDataMigrationReceipt {
                migration_id: transaction.migration_id,
                records: current_records,
                replayed: true,
            });
        }
        if current_records.iter().any(|record| {
            record
                .migrations
                .iter()
                .any(|migration| migration.migration_id == transaction.migration_id)
        }) {
            return Err(error(
                "conflict",
                "Plugin data migration provenance is inconsistent",
            ));
        }

        let mut migrated = Vec::with_capacity(transaction.records.len());
        for (write, current) in transaction.records.iter().zip(current_records) {
            if current.revision != write.expected_revision
                || current.schema_version != write.from_schema_version
            {
                return Err(error(
                    "conflict",
                    "Plugin data migration expected a stale record",
                ));
            }
            let revision = next_revision(Some(&current))?;
            let mut migrations = current.migrations;
            migrations.push(PluginDataMigrationProvenance {
                migration_id: transaction.migration_id.clone(),
                from_schema_version: write.from_schema_version,
                to_schema_version: write.to_schema_version,
            });
            migrated.push(PluginDataRecord {
                owner_module_id: actor.module_id.clone(),
                scope: write.scope.clone(),
                key: write.key.clone(),
                schema_version: write.to_schema_version,
                revision,
                value: write.value.clone(),
                migrations,
            });
        }
        for record in &migrated {
            document.records.insert(
                record_identity(&record.owner_module_id, &record.scope, &record.key),
                record.clone(),
            );
        }
        write_document(&self.inner.path, &document)?;
        Ok(PluginDataMigrationReceipt {
            migration_id: transaction.migration_id,
            records: migrated,
            replayed: false,
        })
    }

    pub fn validate_serialized_document(payload: &[u8]) -> Result<(), String> {
        decode_document(payload).map(|_| ())
    }

    fn validate_actor(&self, actor: &PluginDataActor) -> Result<(), String> {
        validate_identity(&actor.module_id, "module ID")?;
        validate_identity(&actor.activation_id, "activation ID")?;
        if !actor
            .activation_id
            .starts_with(&format!("{}@", actor.module_id))
        {
            return Err(error(
                "denied",
                "Plugin data activation does not belong to the requesting module",
            ));
        }
        Ok(())
    }

    fn authorize(
        &self,
        actor: &PluginDataActor,
        key: &str,
        grant: PluginDataGrant,
    ) -> Result<(), String> {
        validate_identity(key, "record key")?;
        actor
            .effective_grants
            .contains(&grant)
            .then_some(())
            .ok_or_else(|| error("denied", "Plugin data access was denied"))
    }

    fn validate_scope(&self, scope: &PluginDataScope) -> Result<(), String> {
        let PluginDataScope::Project { project_id } = scope else {
            return Ok(());
        };
        validate_identity(project_id, "project ID")?;
        Ok(())
    }

    fn legacy_record(
        &self,
        actor: &PluginDataActor,
        scope: &PluginDataScope,
        key: &str,
    ) -> Result<Option<PluginDataRecord>, String> {
        for source in &self.inner.legacy_record_maps {
            if let Some(record) = source.read_record(&actor.module_id, scope, key)? {
                return Ok(Some(record));
            }
        }
        Ok(None)
    }
}

fn record_identity(module_id: &str, scope: &PluginDataScope, key: &str) -> String {
    match scope {
        PluginDataScope::Global => format!("{module_id}\u{1f}global\u{1f}{key}"),
        PluginDataScope::Project { project_id } => {
            format!("{module_id}\u{1f}project\u{1f}{project_id}\u{1f}{key}")
        }
    }
}

fn find_record<'a>(
    document: &'a PluginDataDocument,
    module_id: &str,
    scope: &PluginDataScope,
    key: &str,
) -> Option<&'a PluginDataRecord> {
    document
        .records
        .get(&record_identity(module_id, scope, key))
}

fn validate_identity(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err(error(
            "invalid-request",
            format!("Plugin data {label} is invalid"),
        ));
    }
    Ok(())
}

fn validate_schema_version(schema_version: u32) -> Result<(), String> {
    if schema_version == 0 {
        return Err(error(
            "invalid-schema",
            "Plugin data schema version must be positive",
        ));
    }
    Ok(())
}

fn validate_json_value(value: &Value) -> Result<(), String> {
    if contains_non_finite_number(value) {
        return Err(error(
            "invalid-value",
            "Plugin data values must be JSON-safe",
        ));
    }
    Ok(())
}

fn contains_non_finite_number(value: &Value) -> bool {
    match value {
        Value::Number(number) => number.as_f64().is_some_and(|value| !value.is_finite()),
        Value::Array(values) => values.iter().any(contains_non_finite_number),
        Value::Object(values) => values.values().any(contains_non_finite_number),
        _ => false,
    }
}

fn assert_expected_revision(
    expected: Option<u64>,
    current: Option<&PluginDataRecord>,
) -> Result<(), String> {
    let matches = match (expected, current) {
        (None, None) => true,
        (Some(expected), Some(current)) => expected == current.revision,
        _ => false,
    };
    if matches {
        Ok(())
    } else {
        Err(error(
            "conflict",
            "Plugin data write expected a stale record",
        ))
    }
}

fn next_revision(current: Option<&PluginDataRecord>) -> Result<u64, String> {
    let current = current.map_or(0, |record| record.revision);
    let revision = current
        .checked_add(1)
        .filter(|revision| *revision <= JAVASCRIPT_MAX_SAFE_INTEGER)
        .ok_or_else(|| {
            error(
                "invalid-revision",
                "Plugin data revision cannot advance safely",
            )
        })?;
    Ok(revision)
}

fn read_document(path: &Path) -> Result<PluginDataDocument, String> {
    if !path.exists() {
        return Ok(PluginDataDocument {
            schema_version: DOCUMENT_SCHEMA_VERSION,
            records: BTreeMap::new(),
        });
    }
    let payload = fs::read(path).map_err(|failure| {
        error(
            "storage-failed",
            format!("Could not read plugin data storage: {failure}"),
        )
    })?;
    decode_document(&payload)
}

fn decode_document(payload: &[u8]) -> Result<PluginDataDocument, String> {
    let document: PluginDataDocument = serde_json::from_slice(payload).map_err(|failure| {
        error(
            "invalid-document",
            format!("Plugin data storage is invalid JSON: {failure}"),
        )
    })?;
    if document.schema_version != DOCUMENT_SCHEMA_VERSION {
        return Err(error(
            "unsupported-document",
            "Plugin data storage uses an unsupported schema version",
        ));
    }
    for (identity, record) in &document.records {
        validate_identity(&record.owner_module_id, "stored module ID").map_err(|_| {
            error(
                "invalid-document",
                "Plugin data storage contains an invalid owner",
            )
        })?;
        validate_identity(&record.key, "stored record key").map_err(|_| {
            error(
                "invalid-document",
                "Plugin data storage contains an invalid key",
            )
        })?;
        if let PluginDataScope::Project { project_id } = &record.scope {
            validate_identity(project_id, "stored project ID").map_err(|_| {
                error(
                    "invalid-document",
                    "Plugin data storage contains an invalid project identity",
                )
            })?;
        }
        if identity != &record_identity(&record.owner_module_id, &record.scope, &record.key) {
            return Err(error(
                "invalid-document",
                "Plugin data storage contains a mismatched record identity",
            ));
        }
        if record.schema_version == 0
            || record.revision == 0
            || record.revision > JAVASCRIPT_MAX_SAFE_INTEGER
        {
            return Err(error(
                "invalid-document",
                "Plugin data storage contains an invalid record version",
            ));
        }
        for migration in &record.migrations {
            validate_identity(&migration.migration_id, "stored migration ID").map_err(|_| {
                error(
                    "invalid-document",
                    "Plugin data storage contains invalid migration provenance",
                )
            })?;
            if migration.from_schema_version == 0
                || migration.to_schema_version == 0
                || migration.from_schema_version == migration.to_schema_version
            {
                return Err(error(
                    "invalid-document",
                    "Plugin data storage contains invalid migration provenance",
                ));
            }
        }
        validate_json_value(&record.value)?;
    }
    Ok(document)
}

fn write_document(path: &Path, document: &PluginDataDocument) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| {
        error(
            "storage-failed",
            "Plugin data storage path has no parent directory",
        )
    })?;
    fs::create_dir_all(parent).map_err(|failure| {
        error(
            "storage-failed",
            format!("Could not create plugin data directory: {failure}"),
        )
    })?;
    let temporary = parent.join(format!(".plugin-data-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let payload = serde_json::to_vec_pretty(document).map_err(|failure| {
            error(
                "storage-failed",
                format!("Could not serialize plugin data storage: {failure}"),
            )
        })?;
        fs::write(&temporary, payload).map_err(|failure| {
            error(
                "storage-failed",
                format!("Could not stage plugin data storage: {failure}"),
            )
        })?;
        fs::rename(&temporary, path).map_err(|failure| {
            error(
                "storage-failed",
                format!("Could not publish plugin data storage: {failure}"),
            )
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn error(code: &str, message: impl AsRef<str>) -> String {
    format!("plugin-data.{code}: {}", message.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::paths::ShipctlPaths;

    fn fixture() -> (tempfile::TempDir, PluginDataService) {
        let root = tempfile::tempdir().unwrap();
        let paths = ShipctlPaths::new(root.path().join("state"), root.path().join("runtime"));
        let service = PluginDataService::new_with_barrier(
            paths.plugin_data.clone(),
            DurableWriteBarrier::default(),
        );
        (root, service)
    }

    fn actor(module_id: &str, grants: &[PluginDataGrant]) -> PluginDataActor {
        PluginDataActor {
            module_id: module_id.to_string(),
            activation_id: format!("{module_id}@1.0.0#fixture"),
            effective_grants: grants.iter().copied().collect(),
        }
    }

    fn full_actor(module_id: &str) -> PluginDataActor {
        actor(
            module_id,
            &[
                PluginDataGrant::Read,
                PluginDataGrant::Write,
                PluginDataGrant::Migrate,
            ],
        )
    }

    #[test]
    fn admitted_artifact_can_own_an_arbitrary_namespace_and_project_scope() {
        let (_root, service) = fixture();
        let actor = full_actor("fixture.external-artifact");
        let scope = PluginDataScope::Project {
            project_id: "arbitrary-project-identity".to_string(),
        };
        let stored = service
            .write_record(
                &actor,
                PluginDataWrite {
                    scope: scope.clone(),
                    key: "new-record-without-rust-policy".into(),
                    expected_revision: None,
                    schema_version: 42,
                    value: serde_json::json!({"configured": true}),
                },
            )
            .unwrap();
        assert_eq!(stored.revision, 1);
        assert_eq!(
            serde_json::to_value(&stored).unwrap()["migrations"],
            serde_json::json!([]),
            "the native response contract always exposes migration provenance as an array"
        );
        assert_eq!(
            service
                .read_record(&actor, &scope, "new-record-without-rust-policy")
                .unwrap()
                .unwrap()
                .value,
            serde_json::json!({"configured": true})
        );
    }

    #[test]
    fn denied_grant_cannot_write_an_arbitrary_record() {
        let (_root, service) = fixture();
        let actor = actor("fixture.read-only", &[PluginDataGrant::Read]);
        let failure = service
            .write_record(
                &actor,
                PluginDataWrite {
                    scope: PluginDataScope::Global,
                    key: "settings".into(),
                    expected_revision: None,
                    schema_version: 1,
                    value: serde_json::json!({}),
                },
            )
            .unwrap_err();
        assert!(failure.starts_with("plugin-data.denied:"));
    }

    #[test]
    fn schema_version_must_be_positive() {
        let (_root, service) = fixture();
        let actor = full_actor("fixture.schema");
        let failure = service
            .write_record(
                &actor,
                PluginDataWrite {
                    scope: PluginDataScope::Global,
                    key: "settings".into(),
                    expected_revision: None,
                    schema_version: 0,
                    value: serde_json::json!({}),
                },
            )
            .unwrap_err();
        assert!(failure.starts_with("plugin-data.invalid-schema:"));
    }

    #[test]
    fn stale_write_is_rejected_without_changing_the_record() {
        let (_root, service) = fixture();
        let actor = full_actor("fixture.stale-write");
        let first = service
            .write_record(
                &actor,
                PluginDataWrite {
                    scope: PluginDataScope::Global,
                    key: "settings".into(),
                    expected_revision: None,
                    schema_version: 1,
                    value: serde_json::json!({"enabled": true}),
                },
            )
            .unwrap();
        let failure = service
            .write_record(
                &actor,
                PluginDataWrite {
                    scope: PluginDataScope::Global,
                    key: "settings".into(),
                    expected_revision: Some(first.revision - 1),
                    schema_version: 1,
                    value: serde_json::json!({"enabled": false}),
                },
            )
            .unwrap_err();
        assert!(failure.starts_with("plugin-data.conflict:"));
        assert_eq!(
            service
                .read_record(&actor, &PluginDataScope::Global, "settings")
                .unwrap()
                .unwrap()
                .value,
            serde_json::json!({"enabled": true})
        );
    }

    #[test]
    fn serialized_document_rejects_legacy_only_and_invalid_provenance_records() {
        for payload in [
            serde_json::json!({
                "schemaVersion": 1,
                "records": {
                    "shipctl.usage\u{1f}global\u{1f}settings": {
                        "ownerModuleId": "shipctl.usage",
                        "scope": { "kind": "global" },
                        "key": "settings",
                        "schemaVersion": 1,
                        "revision": 0,
                        "value": {}
                    }
                }
            }),
            serde_json::json!({
                "schemaVersion": 1,
                "records": {
                    "shipctl.usage\u{1f}global\u{1f}settings": {
                        "ownerModuleId": "shipctl.usage",
                        "scope": { "kind": "global" },
                        "key": "settings",
                        "schemaVersion": 1,
                        "revision": 1,
                        "value": {},
                        "migrations": [{
                            "migrationId": "same-version",
                            "fromSchemaVersion": 1,
                            "toSchemaVersion": 1
                        }]
                    }
                }
            }),
        ] {
            let failure = PluginDataService::validate_serialized_document(
                &serde_json::to_vec(&payload).unwrap(),
            )
            .unwrap_err();
            assert!(failure.starts_with("plugin-data.invalid-document:"));
        }
    }

    #[test]
    fn migration_transaction_records_provenance_and_replays_once() {
        let (_root, service) = fixture();
        let actor = full_actor("fixture.migration");
        let first = service
            .write_record(
                &actor,
                PluginDataWrite {
                    scope: PluginDataScope::Global,
                    key: "state".into(),
                    expected_revision: None,
                    schema_version: 1,
                    value: serde_json::json!({"old": true}),
                },
            )
            .unwrap();
        let migration = PluginDataMigrationTransaction {
            migration_id: "fixture-v2".into(),
            records: vec![PluginDataMigrationWrite {
                scope: PluginDataScope::Global,
                key: "state".into(),
                expected_revision: first.revision,
                from_schema_version: 1,
                to_schema_version: 2,
                value: serde_json::json!({"current": true}),
            }],
        };
        let applied = service.migrate_records(&actor, migration.clone()).unwrap();
        let replayed = service.migrate_records(&actor, migration).unwrap();
        assert!(!applied.replayed);
        assert!(replayed.replayed);
        assert_eq!(applied.records, replayed.records);
        assert_eq!(applied.records[0].migrations.len(), 1);
    }

    #[test]
    fn migration_batch_rejects_duplicate_and_stale_records_without_partial_commit() {
        let (_root, service) = fixture();
        let actor = full_actor("fixture.batch");
        for key in ["first", "second"] {
            service
                .write_record(
                    &actor,
                    PluginDataWrite {
                        scope: PluginDataScope::Global,
                        key: key.into(),
                        expected_revision: None,
                        schema_version: 1,
                        value: serde_json::json!({"key": key}),
                    },
                )
                .unwrap();
        }

        let duplicate = PluginDataMigrationWrite {
            scope: PluginDataScope::Global,
            key: "first".into(),
            expected_revision: 1,
            from_schema_version: 1,
            to_schema_version: 2,
            value: serde_json::json!({"migrated": true}),
        };
        let duplicate_failure = service
            .migrate_records(
                &actor,
                PluginDataMigrationTransaction {
                    migration_id: "duplicate-v2".into(),
                    records: vec![duplicate.clone(), duplicate],
                },
            )
            .unwrap_err();
        assert!(duplicate_failure.starts_with("plugin-data.invalid-request:"));

        service
            .write_record(
                &actor,
                PluginDataWrite {
                    scope: PluginDataScope::Global,
                    key: "first".into(),
                    expected_revision: Some(1),
                    schema_version: 1,
                    value: serde_json::json!({"changed": true}),
                },
            )
            .unwrap();
        let stale_failure = service
            .migrate_records(
                &actor,
                PluginDataMigrationTransaction {
                    migration_id: "atomic-v2".into(),
                    records: vec![
                        PluginDataMigrationWrite {
                            scope: PluginDataScope::Global,
                            key: "first".into(),
                            expected_revision: 1,
                            from_schema_version: 1,
                            to_schema_version: 2,
                            value: serde_json::json!({"migrated": true}),
                        },
                        PluginDataMigrationWrite {
                            scope: PluginDataScope::Global,
                            key: "second".into(),
                            expected_revision: 1,
                            from_schema_version: 1,
                            to_schema_version: 2,
                            value: serde_json::json!({"migrated": true}),
                        },
                    ],
                },
            )
            .unwrap_err();
        assert!(stale_failure.starts_with("plugin-data.conflict:"));
        let untouched = service
            .read_record(&actor, &PluginDataScope::Global, "second")
            .unwrap()
            .unwrap();
        assert_eq!(untouched.schema_version, 1);
        assert_eq!(untouched.revision, 1);
        assert!(untouched.migrations.is_empty());
    }

    #[test]
    fn legacy_record_map_migrates_once_replays_and_never_overwrites_a_stale_candidate() {
        let root = tempfile::tempdir().unwrap();
        let paths = ShipctlPaths::new(root.path().join("state"), root.path().join("runtime"));
        let legacy_path = paths.state_root.join("legacy-records.json");
        fs::create_dir_all(&paths.state_root).unwrap();
        fs::write(
            &legacy_path,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "records": {
                    "workspace-one": { "legacy": true }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let source = LegacyPluginDataRecordMapSource::new(
            legacy_path,
            "fixture.legacy-source".into(),
            PluginDataScope::Global,
            "workspace:".into(),
            1,
        )
        .unwrap();
        let service = PluginDataService::with_legacy_record_maps(
            paths.plugin_data,
            DurableWriteBarrier::default(),
            vec![source],
        );
        let actor = full_actor("fixture.legacy-source");
        let scope = PluginDataScope::Global;
        let key = "workspace:workspace-one";

        let source_record = service.read_record(&actor, &scope, key).unwrap().unwrap();
        assert_eq!(source_record.schema_version, 1);
        assert_eq!(source_record.revision, 0);
        assert_eq!(source_record.value, serde_json::json!({ "legacy": true }));

        let migration = PluginDataMigrationTransaction {
            migration_id: "fixture-source-v1-to-v2".into(),
            records: vec![PluginDataMigrationWrite {
                scope: scope.clone(),
                key: key.into(),
                expected_revision: 0,
                from_schema_version: 1,
                to_schema_version: 2,
                value: serde_json::json!({ "canonical": true }),
            }],
        };
        let applied = service.migrate_records(&actor, migration.clone()).unwrap();
        assert!(!applied.replayed);
        assert_eq!(applied.records[0].revision, 1);
        assert_eq!(
            applied.records[0].value,
            serde_json::json!({ "canonical": true })
        );

        let replayed = service.migrate_records(&actor, migration).unwrap();
        assert!(replayed.replayed);
        assert_eq!(replayed.records, applied.records);

        let stale_failure = service
            .migrate_records(
                &actor,
                PluginDataMigrationTransaction {
                    migration_id: "fixture-conflicting-source-v2".into(),
                    records: vec![PluginDataMigrationWrite {
                        scope: scope.clone(),
                        key: key.into(),
                        expected_revision: 0,
                        from_schema_version: 1,
                        to_schema_version: 2,
                        value: serde_json::json!({ "mustNotReplace": true }),
                    }],
                },
            )
            .unwrap_err();
        assert!(stale_failure.starts_with("plugin-data.conflict:"));
        assert_eq!(
            service.read_record(&actor, &scope, key).unwrap().unwrap(),
            applied.records[0],
            "the durable plugin record shadows the read-only source after migration"
        );
    }
}
