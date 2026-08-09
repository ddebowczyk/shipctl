mod catalog;
mod diagnostics;
mod inventory;
mod snapshot;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::codes::{
    REGISTRY_ABSENT, REGISTRY_ARTIFACT_IMMUTABLE, REGISTRY_ARTIFACT_REFERENCE_MISSING,
    REGISTRY_CONTRACT_INVALID, REGISTRY_INTEGRITY_FAILED, REGISTRY_INVENTORY_ABSENT,
    REGISTRY_INVENTORY_MISMATCH, REGISTRY_INVENTORY_STALE, REGISTRY_JOURNAL_INCONSISTENT,
    REGISTRY_MIGRATION_FAILED, REGISTRY_REVISION_DISCONTINUOUS, REGISTRY_SCHEMA_UNSUPPORTED,
    REGISTRY_TRANSACTION_FAILED, REGISTRY_UNREADABLE,
};
use super::{
    parse_contract_json, DesiredModuleState, ModuleContract, ModuleIdentity, ModuleOperation,
    ModuleOperationKind, ModuleOperationPhase, ModuleOperationResult, ModuleSource,
    ModuleTransition, ObservedModuleState, MODULE_CONTROL_SCHEMA_VERSION,
};
use crate::state::paths::ShipctlPaths;

pub use catalog::{
    ArtifactInstallReceipt, CapabilityBindingRole, CapabilityCatalogSnapshot,
    PendingArtifactInstall, PendingArtifactInstallResolution, RegisteredCapabilityBinding,
    RuntimeArtifactCatalogEntry, RuntimeArtifactRegistration,
    RUNTIME_ARTIFACT_CATALOG_SCHEMA_VERSION,
};
pub use diagnostics::diagnose_registry;
pub use inventory::{
    BuildModuleMembership, InventorySeedResult, StaticBuildInventory, StaticModuleRecord,
};
pub use snapshot::ModuleRegistrySnapshotProvider;

use catalog::{
    load_capability_catalog, load_runtime_artifact_catalog, migrate_v1_to_v2,
    validate_catalog_snapshot,
};
use inventory::load_static_inventory;

const REGISTRY_SCHEMA_VERSION: i64 = 2;

#[derive(Debug)]
pub struct RegistryError {
    pub code: &'static str,
    pub message: String,
}

impl RegistryError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for RegistryError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactAcquisition {
    pub identity: ModuleIdentity,
    pub source: ModuleSource,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisteredArtifact {
    pub identity: ModuleIdentity,
    pub sources: Vec<ModuleSource>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegistryMutation {
    pub request_id: Uuid,
    pub module_id: String,
    pub instance_id: Uuid,
    pub kind: ModuleOperationKind,
    pub artifacts: Vec<ArtifactAcquisition>,
    pub desired: Option<DesiredModuleState>,
    pub observations: Vec<ObservedModuleState>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySnapshot {
    pub registry_path: PathBuf,
    pub registry_revision: u64,
    pub artifacts: Vec<RegisteredArtifact>,
    pub desired: Vec<DesiredModuleState>,
    pub operations: Vec<ModuleOperation>,
    pub observations: Vec<ObservedModuleState>,
    /// Validated runtime artifact metadata. Entries are catalog declarations
    /// only; Phase 3 never makes their ports or providers callable.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub runtime_artifacts: Vec<RuntimeArtifactCatalogEntry>,
    /// Dynamic capability definitions declared by installed runtime artifacts.
    /// Built-in definitions remain host-owned and may be referenced by bindings
    /// without appearing here.
    #[serde(default, skip_serializing_if = "CapabilityCatalogSnapshot::is_empty")]
    pub capability_catalog: CapabilityCatalogSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub static_build_provenance: Option<String>,
    pub static_inventory: Vec<StaticModuleRecord>,
}

impl RegistrySnapshot {
    /// Resolve durable intent, using current static build membership only as a
    /// read-time default. Defaults never create journal entries or revisions.
    pub fn effective_desired(&self, module_id: &str) -> Option<DesiredModuleState> {
        self.desired
            .iter()
            .find(|state| state.module_id == module_id)
            .cloned()
            .or_else(|| {
                self.static_inventory
                    .iter()
                    .find(|record| record.identity.id == module_id)
                    .map(|record| DesiredModuleState {
                        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                        module_id: module_id.to_string(),
                        selected_artifact: Some(record.identity.clone()),
                        enabled: true,
                        configuration_revision: 0,
                    })
            })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Access {
    Writable,
    ReadOnly,
}

/// Durable module facts for one injected Shipctl instance state root.
///
/// This service knows only contracts and persistence. It never loads module
/// behavior, selects Cargo features, or invokes Tauri.
pub struct ModuleRegistry {
    path: PathBuf,
    connection: Connection,
    access: Access,
}

impl ModuleRegistry {
    pub fn open_writable(paths: &ShipctlPaths) -> Result<Self, RegistryError> {
        Self::open_writable_path(&paths.module_registry_database)
    }

    pub fn open_read_only(paths: &ShipctlPaths) -> Result<Self, RegistryError> {
        Self::open_read_only_path(&paths.module_registry_database)
    }

    pub fn open_writable_path(path: &Path) -> Result<Self, RegistryError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                RegistryError::new(
                    REGISTRY_UNREADABLE,
                    format!(
                        "Cannot create registry parent {}: {error}",
                        parent.display()
                    ),
                )
            })?;
        }

        let mut connection = Connection::open(path).map_err(|error| {
            RegistryError::new(
                REGISTRY_UNREADABLE,
                format!("Cannot open registry {}: {error}", path.display()),
            )
        })?;
        enable_foreign_keys(&connection)?;
        initialize_schema(&mut connection)?;

        Ok(Self {
            path: path.to_path_buf(),
            connection,
            access: Access::Writable,
        })
    }

    pub fn open_read_only_path(path: &Path) -> Result<Self, RegistryError> {
        if !path.exists() {
            return Err(RegistryError::new(
                REGISTRY_ABSENT,
                format!("Registry {} does not exist", path.display()),
            ));
        }

        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|error| {
            RegistryError::new(
                REGISTRY_UNREADABLE,
                format!("Cannot open registry {} read-only: {error}", path.display()),
            )
        })?;
        enable_foreign_keys(&connection)?;
        require_supported_schema(&connection)?;

        Ok(Self {
            path: path.to_path_buf(),
            connection,
            access: Access::ReadOnly,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn revision(&self) -> Result<u64, RegistryError> {
        read_revision(&self.connection)
    }

    pub fn commit(
        &mut self,
        mutation: &RegistryMutation,
    ) -> Result<ModuleOperation, RegistryError> {
        self.commit_inner(mutation, false)
    }

    fn commit_inner(
        &mut self,
        mutation: &RegistryMutation,
        fail_before_commit: bool,
    ) -> Result<ModuleOperation, RegistryError> {
        if self.access != Access::Writable {
            return Err(RegistryError::new(
                REGISTRY_TRANSACTION_FAILED,
                "Cannot mutate a read-only registry",
            ));
        }

        let transaction = self.connection.transaction().map_err(transaction_error)?;
        if let Some(original) = load_operation_by_request(&transaction, mutation.request_id)? {
            return Ok(original);
        }

        validate_mutation(&transaction, mutation)?;
        let current_revision = read_revision(&transaction)?;
        let next_revision = current_revision.checked_add(1).ok_or_else(|| {
            RegistryError::new(
                REGISTRY_TRANSACTION_FAILED,
                "Registry revision cannot advance beyond u64::MAX",
            )
        })?;
        let next_revision_sql = sql_integer(next_revision, "registry revision")?;

        for artifact in &mutation.artifacts {
            insert_immutable_artifact(&transaction, artifact)?;
        }
        if let Some(desired) = &mutation.desired {
            store_desired(&transaction, desired)?;
        }
        for observation in &mutation.observations {
            store_observation(&transaction, observation)?;
        }

        let operation = committed_operation(mutation, next_revision);
        let operation_json = contract_json(&operation)?;
        transaction
            .execute(
                "INSERT INTO registry_revisions(revision, change_kind, request_id) VALUES (?1, 'operation', ?2)",
                params![next_revision_sql, mutation.request_id.to_string()],
            )
            .map_err(transaction_error)?;
        transaction
            .execute(
                "INSERT INTO operations(request_id, revision, instance_id, module_id, operation_json) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    mutation.request_id.to_string(),
                    next_revision_sql,
                    mutation.instance_id.to_string(),
                    mutation.module_id,
                    operation_json,
                ],
            )
            .map_err(transaction_error)?;
        transaction
            .execute(
                "UPDATE registry_metadata SET value = ?1 WHERE key = 'current_revision'",
                params![next_revision.to_string()],
            )
            .map_err(transaction_error)?;

        if fail_before_commit {
            return Err(RegistryError::new(
                REGISTRY_TRANSACTION_FAILED,
                "Injected failure before registry transaction commit",
            ));
        }
        transaction.commit().map_err(transaction_error)?;
        Ok(operation)
    }

    pub fn snapshot(&self) -> Result<RegistrySnapshot, RegistryError> {
        require_supported_schema(&self.connection)?;
        require_integrity(&self.connection)?;
        let revision = read_revision(&self.connection)?;
        validate_revision_sequence(&self.connection, revision)?;

        let artifacts = load_artifacts(&self.connection)?;
        let desired = load_contracts::<DesiredModuleState>(
            &self.connection,
            "SELECT state_json FROM desired_state ORDER BY module_id",
            REGISTRY_CONTRACT_INVALID,
        )?;
        let operations = load_operations(&self.connection)?;
        let observations = load_contracts::<ObservedModuleState>(
            &self.connection,
            "SELECT state_json FROM observations ORDER BY instance_id, module_id, observation_key",
            REGISTRY_CONTRACT_INVALID,
        )?;
        let (static_build_provenance, static_inventory) = load_static_inventory(&self.connection)?;
        let runtime_artifacts = load_runtime_artifact_catalog(&self.connection, &artifacts)?;
        let capability_catalog = load_capability_catalog(&self.connection)?;

        validate_artifact_references(&artifacts, &desired, &observations, &static_inventory)?;
        validate_catalog_snapshot(&artifacts, &runtime_artifacts, &capability_catalog)?;
        validate_operation_journal(&self.connection, &operations)?;

        Ok(RegistrySnapshot {
            registry_path: self.path.clone(),
            registry_revision: revision,
            artifacts,
            desired,
            operations,
            observations,
            runtime_artifacts,
            capability_catalog,
            static_build_provenance,
            static_inventory,
        })
    }

    #[cfg(test)]
    fn commit_with_failure(
        &mut self,
        mutation: &RegistryMutation,
    ) -> Result<ModuleOperation, RegistryError> {
        self.commit_inner(mutation, true)
    }

    #[cfg(test)]
    fn migration_failure_probe(&mut self) -> Result<(), RegistryError> {
        let transaction = self.connection.transaction().map_err(transaction_error)?;
        transaction
            .execute(
                "INSERT INTO registry_metadata(key, value) VALUES ('migration_probe', 'uncommitted')",
                [],
            )
            .map_err(|error| {
                RegistryError::new(
                    REGISTRY_MIGRATION_FAILED,
                    format!("Migration probe could not stage its change: {error}"),
                )
            })?;
        Err(RegistryError::new(
            REGISTRY_MIGRATION_FAILED,
            "Injected migration failure before schema-version commit",
        ))
    }
}

fn initialize_schema(connection: &mut Connection) -> Result<(), RegistryError> {
    let transaction = connection.transaction().map_err(|error| {
        RegistryError::new(
            REGISTRY_MIGRATION_FAILED,
            format!("Cannot begin registry schema transaction: {error}"),
        )
    })?;
    let version: i64 = transaction
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(migration_error)?;

    match version {
        0 => {
            transaction
                .execute_batch(
                    "
                    CREATE TABLE registry_metadata(
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    );
                    INSERT INTO registry_metadata(key, value) VALUES ('current_revision', '0');

                    CREATE TABLE registry_revisions(
                        revision INTEGER PRIMARY KEY CHECK(revision > 0),
                        change_kind TEXT NOT NULL,
                        request_id TEXT UNIQUE
                    );

                    CREATE TABLE artifacts(
                        module_id TEXT NOT NULL,
                        content_digest TEXT NOT NULL,
                        identity_json TEXT NOT NULL,
                        PRIMARY KEY(module_id, content_digest)
                    );

                    CREATE TABLE artifact_sources(
                        module_id TEXT NOT NULL,
                        content_digest TEXT NOT NULL,
                        source TEXT NOT NULL,
                        PRIMARY KEY(module_id, content_digest, source),
                        FOREIGN KEY(module_id, content_digest)
                            REFERENCES artifacts(module_id, content_digest)
                    );

                    CREATE TABLE desired_state(
                        module_id TEXT PRIMARY KEY,
                        selected_artifact_digest TEXT,
                        configuration_revision INTEGER NOT NULL CHECK(configuration_revision >= 0),
                        state_json TEXT NOT NULL,
                        FOREIGN KEY(module_id, selected_artifact_digest)
                            REFERENCES artifacts(module_id, content_digest)
                    );

                    CREATE TABLE operations(
                        request_id TEXT PRIMARY KEY,
                        revision INTEGER NOT NULL UNIQUE,
                        instance_id TEXT NOT NULL,
                        module_id TEXT NOT NULL,
                        operation_json TEXT NOT NULL,
                        FOREIGN KEY(revision) REFERENCES registry_revisions(revision)
                    );

                    CREATE TABLE observations(
                        instance_id TEXT NOT NULL,
                        module_id TEXT NOT NULL,
                        observation_key TEXT NOT NULL,
                        artifact_digest TEXT,
                        applied_registry_revision INTEGER NOT NULL CHECK(applied_registry_revision >= 0),
                        state_json TEXT NOT NULL,
                        PRIMARY KEY(instance_id, module_id, observation_key),
                        FOREIGN KEY(module_id, artifact_digest)
                            REFERENCES artifacts(module_id, content_digest)
                    );

                    CREATE TABLE static_inventory(
                        module_id TEXT PRIMARY KEY,
                        identity_digest TEXT NOT NULL,
                        build_provenance TEXT NOT NULL,
                        native_compiled INTEGER NOT NULL CHECK(native_compiled IN (0, 1)),
                        frontend_shipped INTEGER NOT NULL CHECK(frontend_shipped IN (0, 1)),
                        record_json TEXT NOT NULL,
                        FOREIGN KEY(module_id, identity_digest)
                            REFERENCES artifacts(module_id, content_digest)
                    );
                    ",
                )
                .map_err(migration_error)?;
            migrate_v1_to_v2(&transaction)?;
            transaction
                .pragma_update(None, "user_version", REGISTRY_SCHEMA_VERSION)
                .map_err(migration_error)?;
        }
        1 => {
            migrate_v1_to_v2(&transaction)?;
            transaction
                .pragma_update(None, "user_version", REGISTRY_SCHEMA_VERSION)
                .map_err(migration_error)?;
        }
        REGISTRY_SCHEMA_VERSION => {}
        other => {
            return Err(RegistryError::new(
                REGISTRY_SCHEMA_UNSUPPORTED,
                format!(
                    "Registry schema version {other} is unsupported; expected {REGISTRY_SCHEMA_VERSION}"
                ),
            ));
        }
    }
    transaction.commit().map_err(migration_error)
}

fn enable_foreign_keys(connection: &Connection) -> Result<(), RegistryError> {
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| {
            RegistryError::new(
                REGISTRY_UNREADABLE,
                format!("Cannot enable registry integrity checks: {error}"),
            )
        })
}

fn require_supported_schema(connection: &Connection) -> Result<(), RegistryError> {
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| {
            RegistryError::new(
                REGISTRY_UNREADABLE,
                format!("Cannot read registry schema version: {error}"),
            )
        })?;
    if version != REGISTRY_SCHEMA_VERSION {
        return Err(RegistryError::new(
            REGISTRY_SCHEMA_UNSUPPORTED,
            format!(
                "Registry schema version {version} is unsupported; expected {REGISTRY_SCHEMA_VERSION}"
            ),
        ));
    }
    Ok(())
}

fn require_integrity(connection: &Connection) -> Result<(), RegistryError> {
    let result: String = connection
        .pragma_query_value(None, "integrity_check", |row| row.get(0))
        .map_err(|error| {
            RegistryError::new(
                REGISTRY_INTEGRITY_FAILED,
                format!("Registry integrity check could not run: {error}"),
            )
        })?;
    if result != "ok" {
        return Err(RegistryError::new(
            REGISTRY_INTEGRITY_FAILED,
            format!("Registry integrity check failed: {result}"),
        ));
    }
    Ok(())
}

fn read_revision(connection: &Connection) -> Result<u64, RegistryError> {
    let value: String = connection
        .query_row(
            "SELECT value FROM registry_metadata WHERE key = 'current_revision'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| {
            RegistryError::new(
                REGISTRY_REVISION_DISCONTINUOUS,
                format!("Registry current revision is unavailable: {error}"),
            )
        })?;
    value.parse().map_err(|error| {
        RegistryError::new(
            REGISTRY_REVISION_DISCONTINUOUS,
            format!("Registry current revision {value:?} is invalid: {error}"),
        )
    })
}

fn validate_revision_sequence(connection: &Connection, current: u64) -> Result<(), RegistryError> {
    let mut statement = connection
        .prepare("SELECT revision FROM registry_revisions ORDER BY revision")
        .map_err(transaction_error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(transaction_error)?;
    let mut expected = 1_u64;
    for row in rows {
        let found = row.map_err(transaction_error)?;
        let found = u64::try_from(found).map_err(|_| {
            RegistryError::new(
                REGISTRY_REVISION_DISCONTINUOUS,
                format!("Registry revision {found} is negative"),
            )
        })?;
        if found != expected {
            return Err(RegistryError::new(
                REGISTRY_REVISION_DISCONTINUOUS,
                format!("Registry revision {expected} is missing; found {found}"),
            ));
        }
        expected += 1;
    }
    if expected.saturating_sub(1) != current {
        return Err(RegistryError::new(
            REGISTRY_REVISION_DISCONTINUOUS,
            format!(
                "Registry metadata records revision {current}, but the revision log ends at {}",
                expected.saturating_sub(1)
            ),
        ));
    }
    Ok(())
}

fn validate_mutation(
    transaction: &Transaction<'_>,
    mutation: &RegistryMutation,
) -> Result<(), RegistryError> {
    if mutation.module_id.trim().is_empty()
        || (mutation.artifacts.is_empty()
            && mutation.desired.is_none()
            && mutation.observations.is_empty())
    {
        return Err(RegistryError::new(
            REGISTRY_CONTRACT_INVALID,
            "A registry mutation requires a module id and at least one state change",
        ));
    }
    for artifact in &mutation.artifacts {
        validate_contract(&artifact.identity)?;
        if artifact.identity.id != mutation.module_id {
            return Err(RegistryError::new(
                REGISTRY_CONTRACT_INVALID,
                "Mutation artifacts must match its module id",
            ));
        }
    }
    if let Some(desired) = &mutation.desired {
        validate_contract(desired)?;
        if desired.module_id != mutation.module_id {
            return Err(RegistryError::new(
                REGISTRY_CONTRACT_INVALID,
                "Desired state must match the mutation module",
            ));
        }
        let previous: Option<i64> = transaction
            .query_row(
                "SELECT configuration_revision FROM desired_state WHERE module_id = ?1",
                params![mutation.module_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(transaction_error)?;
        let expected = previous.map_or(1_u64, |value| value as u64 + 1);
        if desired.configuration_revision != expected {
            return Err(RegistryError::new(
                REGISTRY_REVISION_DISCONTINUOUS,
                format!(
                    "Desired configuration revision must be {expected}, got {}",
                    desired.configuration_revision
                ),
            ));
        }
    }
    for observation in &mutation.observations {
        validate_contract(observation)?;
        if observation.module_id != mutation.module_id
            || observation.instance_id != mutation.instance_id
        {
            return Err(RegistryError::new(
                REGISTRY_CONTRACT_INVALID,
                "Observed state must match the mutation module and instance",
            ));
        }
    }
    Ok(())
}

fn insert_immutable_artifact(
    transaction: &Transaction<'_>,
    acquisition: &ArtifactAcquisition,
) -> Result<(), RegistryError> {
    let artifact = &acquisition.identity;
    catalog::validate_runtime_identity_conflict(transaction, artifact)?;
    let identity_json = contract_json(artifact)?;
    let existing: Option<String> = transaction
        .query_row(
            "SELECT identity_json FROM artifacts WHERE module_id = ?1 AND content_digest = ?2",
            params![artifact.id, artifact.content_digest],
            |row| row.get(0),
        )
        .optional()
        .map_err(transaction_error)?;
    match existing {
        Some(existing) => {
            let stored: ModuleIdentity =
                parse_stored_contract(&existing, REGISTRY_ARTIFACT_IMMUTABLE)?;
            if stored != *artifact {
                return Err(RegistryError::new(
                    REGISTRY_ARTIFACT_IMMUTABLE,
                    format!(
                        "Artifact {}@{} already has different immutable identity",
                        artifact.id, artifact.content_digest
                    ),
                ));
            }
        }
        None => {
            transaction
                .execute(
                "INSERT INTO artifacts(module_id, content_digest, identity_json) VALUES (?1, ?2, ?3)",
                params![artifact.id, artifact.content_digest, identity_json],
                )
                .map_err(transaction_error)?;
        }
    }
    transaction
        .execute(
            "INSERT OR IGNORE INTO artifact_sources(module_id, content_digest, source) VALUES (?1, ?2, ?3)",
            params![artifact.id, artifact.content_digest, module_source_name(acquisition.source)],
        )
        .map(|_| ())
        .map_err(transaction_error)
}

fn store_desired(
    transaction: &Transaction<'_>,
    desired: &DesiredModuleState,
) -> Result<(), RegistryError> {
    require_artifact(transaction, desired.selected_artifact.as_ref())?;
    let state_json = contract_json(desired)?;
    let digest = desired
        .selected_artifact
        .as_ref()
        .map(|artifact| artifact.content_digest.as_str());
    let configuration_revision = sql_integer(
        desired.configuration_revision,
        "desired configuration revision",
    )?;
    transaction
        .execute(
            "INSERT INTO desired_state(module_id, selected_artifact_digest, configuration_revision, state_json)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(module_id) DO UPDATE SET
                selected_artifact_digest = excluded.selected_artifact_digest,
                configuration_revision = excluded.configuration_revision,
                state_json = excluded.state_json",
            params![
                desired.module_id,
                digest,
                configuration_revision,
                state_json,
            ],
        )
        .map(|_| ())
        .map_err(transaction_error)
}

fn store_observation(
    transaction: &Transaction<'_>,
    observation: &ObservedModuleState,
) -> Result<(), RegistryError> {
    require_artifact(transaction, observation.artifact.as_ref())?;
    let state_json = contract_json(observation)?;
    let digest = observation
        .artifact
        .as_ref()
        .map(|artifact| artifact.content_digest.as_str());
    let observation_key = observation.module_instance_id.as_deref().unwrap_or("");
    let applied_revision = sql_integer(
        observation.applied_registry_revision,
        "observed applied registry revision",
    )?;
    transaction
        .execute(
            "INSERT INTO observations(instance_id, module_id, observation_key, artifact_digest, applied_registry_revision, state_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(instance_id, module_id, observation_key) DO UPDATE SET
                artifact_digest = excluded.artifact_digest,
                applied_registry_revision = excluded.applied_registry_revision,
                state_json = excluded.state_json",
            params![
                observation.instance_id.to_string(),
                observation.module_id,
                observation_key,
                digest,
                applied_revision,
                state_json,
            ],
        )
        .map(|_| ())
        .map_err(transaction_error)
}

fn require_artifact(
    transaction: &Transaction<'_>,
    artifact: Option<&ModuleIdentity>,
) -> Result<(), RegistryError> {
    let Some(artifact) = artifact else {
        return Ok(());
    };
    let stored: Option<String> = transaction
        .query_row(
            "SELECT identity_json FROM artifacts WHERE module_id = ?1 AND content_digest = ?2",
            params![artifact.id, artifact.content_digest],
            |row| row.get(0),
        )
        .optional()
        .map_err(transaction_error)?;
    let matches = stored
        .as_deref()
        .map(|stored| parse_stored_contract::<ModuleIdentity>(stored, REGISTRY_CONTRACT_INVALID))
        .transpose()?
        .as_ref()
        == Some(artifact);
    if !matches {
        return Err(RegistryError::new(
            REGISTRY_ARTIFACT_REFERENCE_MISSING,
            format!(
                "State references unknown artifact {}@{}",
                artifact.id, artifact.content_digest
            ),
        ));
    }
    Ok(())
}

fn committed_operation(mutation: &RegistryMutation, revision: u64) -> ModuleOperation {
    ModuleOperation {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        request_id: mutation.request_id,
        module_id: mutation.module_id.clone(),
        instance_id: mutation.instance_id,
        kind: mutation.kind,
        target_registry_revision: revision,
        transitions: vec![
            ModuleTransition {
                phase: ModuleOperationPhase::Received,
                registry_revision: None,
                diagnostics: Vec::new(),
            },
            ModuleTransition {
                phase: ModuleOperationPhase::Committed,
                registry_revision: Some(revision),
                diagnostics: Vec::new(),
            },
        ],
        result: ModuleOperationResult::Succeeded,
    }
}

fn load_operation_by_request(
    connection: &Connection,
    request_id: Uuid,
) -> Result<Option<ModuleOperation>, RegistryError> {
    let json: Option<String> = connection
        .query_row(
            "SELECT operation_json FROM operations WHERE request_id = ?1",
            params![request_id.to_string()],
            |row| row.get(0),
        )
        .optional()
        .map_err(transaction_error)?;
    json.map(|json| parse_stored_contract(&json, REGISTRY_JOURNAL_INCONSISTENT))
        .transpose()
}

fn load_operations(connection: &Connection) -> Result<Vec<ModuleOperation>, RegistryError> {
    load_contracts(
        connection,
        "SELECT operation_json FROM operations ORDER BY revision",
        REGISTRY_JOURNAL_INCONSISTENT,
    )
}

fn load_artifacts(connection: &Connection) -> Result<Vec<RegisteredArtifact>, RegistryError> {
    let identities = load_contracts::<ModuleIdentity>(
        connection,
        "SELECT identity_json FROM artifacts ORDER BY module_id, content_digest",
        REGISTRY_CONTRACT_INVALID,
    )?;
    let mut statement = connection
        .prepare(
            "SELECT module_id, content_digest, source FROM artifact_sources
             ORDER BY module_id, content_digest, source",
        )
        .map_err(transaction_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(transaction_error)?;
    let mut sources = BTreeMap::<(String, String), Vec<ModuleSource>>::new();
    for row in rows {
        let (module_id, digest, source) = row.map_err(transaction_error)?;
        sources
            .entry((module_id, digest))
            .or_default()
            .push(parse_module_source(&source)?);
    }
    identities
        .into_iter()
        .map(|identity| {
            let key = (identity.id.clone(), identity.content_digest.clone());
            let sources = sources.remove(&key).ok_or_else(|| {
                RegistryError::new(
                    REGISTRY_CONTRACT_INVALID,
                    format!(
                        "Artifact {}@{} has no acquisition provenance",
                        identity.id, identity.content_digest
                    ),
                )
            })?;
            Ok(RegisteredArtifact { identity, sources })
        })
        .collect()
}

fn module_source_name(source: ModuleSource) -> &'static str {
    match source {
        ModuleSource::Bundled => "bundled",
        ModuleSource::User => "user",
        ModuleSource::Development => "development",
    }
}

fn parse_module_source(source: &str) -> Result<ModuleSource, RegistryError> {
    match source {
        "bundled" => Ok(ModuleSource::Bundled),
        "user" => Ok(ModuleSource::User),
        "development" => Ok(ModuleSource::Development),
        other => Err(RegistryError::new(
            REGISTRY_CONTRACT_INVALID,
            format!("Artifact acquisition source {other:?} is invalid"),
        )),
    }
}

fn load_contracts<T: ModuleContract>(
    connection: &Connection,
    sql: &str,
    code: &'static str,
) -> Result<Vec<T>, RegistryError> {
    let mut statement = connection.prepare(sql).map_err(transaction_error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(transaction_error)?;
    rows.map(|row| {
        let json = row.map_err(transaction_error)?;
        parse_stored_contract(&json, code)
    })
    .collect()
}

fn validate_artifact_references(
    artifacts: &[RegisteredArtifact],
    desired: &[DesiredModuleState],
    observations: &[ObservedModuleState],
    static_inventory: &[StaticModuleRecord],
) -> Result<(), RegistryError> {
    let contains = |candidate: &ModuleIdentity| {
        artifacts
            .iter()
            .any(|item| item.identity == *candidate && !item.sources.is_empty())
    };
    for artifact in desired
        .iter()
        .filter_map(|state| state.selected_artifact.as_ref())
        .chain(
            observations
                .iter()
                .filter_map(|state| state.artifact.as_ref()),
        )
        .chain(static_inventory.iter().map(|record| &record.identity))
    {
        if !contains(artifact) {
            return Err(RegistryError::new(
                REGISTRY_ARTIFACT_REFERENCE_MISSING,
                format!(
                    "Registry state references missing artifact {}@{}",
                    artifact.id, artifact.content_digest
                ),
            ));
        }
    }
    Ok(())
}

fn validate_operation_journal(
    connection: &Connection,
    operations: &[ModuleOperation],
) -> Result<(), RegistryError> {
    let mut statement = connection
        .prepare(
            "SELECT o.request_id, o.revision, o.instance_id, o.module_id, r.change_kind, r.request_id
             FROM operations o JOIN registry_revisions r ON r.revision = o.revision
             ORDER BY o.revision",
        )
        .map_err(transaction_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(transaction_error)?;
    let stored = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(transaction_error)?;
    if stored.len() != operations.len() {
        return Err(RegistryError::new(
            REGISTRY_JOURNAL_INCONSISTENT,
            "Operation journal row count does not match its contracts",
        ));
    }
    for (operation, row) in operations.iter().zip(stored) {
        let (request_id, revision, instance_id, module_id, kind, revision_request_id) = row;
        if request_id != operation.request_id.to_string()
            || revision != sql_integer(operation.target_registry_revision, "operation revision")?
            || instance_id != operation.instance_id.to_string()
            || module_id != operation.module_id
            || kind != "operation"
            || revision_request_id.as_deref() != Some(request_id.as_str())
        {
            return Err(RegistryError::new(
                REGISTRY_JOURNAL_INCONSISTENT,
                format!("Operation journal is inconsistent at request {request_id}"),
            ));
        }
    }
    Ok(())
}

fn contract_json<T>(contract: &T) -> Result<String, RegistryError>
where
    T: ModuleContract + Serialize,
{
    validate_contract(contract)?;
    serde_json::to_string(contract).map_err(|error| {
        RegistryError::new(
            REGISTRY_CONTRACT_INVALID,
            format!("Cannot serialize module contract: {error}"),
        )
    })
}

fn validate_contract<T: ModuleContract>(contract: &T) -> Result<(), RegistryError> {
    contract.validate().map_err(|error| {
        RegistryError::new(
            REGISTRY_CONTRACT_INVALID,
            format!("{}: {}", error.code, error.message),
        )
    })
}

fn parse_stored_contract<T: ModuleContract>(
    json: &str,
    code: &'static str,
) -> Result<T, RegistryError> {
    parse_contract_json(json)
        .map_err(|error| RegistryError::new(code, format!("{}: {}", error.code, error.message)))
}

fn sql_integer(value: u64, name: &str) -> Result<i64, RegistryError> {
    i64::try_from(value).map_err(|_| {
        RegistryError::new(
            REGISTRY_CONTRACT_INVALID,
            format!("{name} {value} exceeds SQLite's signed integer range"),
        )
    })
}

fn transaction_error(error: rusqlite::Error) -> RegistryError {
    RegistryError::new(
        REGISTRY_TRANSACTION_FAILED,
        format!("Registry transaction failed: {error}"),
    )
}

fn migration_error(error: rusqlite::Error) -> RegistryError {
    RegistryError::new(
        REGISTRY_MIGRATION_FAILED,
        format!("Registry migration failed: {error}"),
    )
}

#[cfg(test)]
mod tests;
