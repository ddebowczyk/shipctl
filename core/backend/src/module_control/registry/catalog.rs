//! Durable catalog records for disabled runtime artifacts.
//!
//! The catalog is intentionally a Phase 3 boundary: it records validated
//! archive metadata and capability declarations, but it has no activation
//! identity, route, runtime handle, or callable surface.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::module_control::artifact::{
    CapabilityConsumerBinding, CapabilityDefinition, CapabilityDefinitionIndex,
    CapabilityProviderBinding, CapabilityReference, ValidatedRuntimeArtifact,
};
use crate::module_control::{
    DesiredModuleState, ModuleIdentity, ModuleRuntimeKind, ModuleSource,
    MODULE_CONTROL_SCHEMA_VERSION,
};

use super::{
    load_artifacts, parse_stored_contract, read_revision, sql_integer, transaction_error,
    validate_contract, ArtifactAcquisition, ModuleRegistry, RegisteredArtifact, RegistryError,
    REGISTRY_ARTIFACT_IMMUTABLE, REGISTRY_ARTIFACT_REFERENCE_MISSING, REGISTRY_CONTRACT_INVALID,
    REGISTRY_JOURNAL_INCONSISTENT, REGISTRY_MIGRATION_FAILED, REGISTRY_TRANSACTION_FAILED,
};

/// Version of the registry-owned runtime-catalog records.
pub const RUNTIME_ARTIFACT_CATALOG_SCHEMA_VERSION: u32 = 1;

/// A validated archive ready for durable disabled registration.
///
/// Archive extraction, filesystem publication, locking, and host-environment
/// preflight live in the artifact repository. This value deliberately carries
/// no path: the catalog only accepts an already validated canonical artifact.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeArtifactRegistration {
    pub request_id: Uuid,
    pub artifact: ValidatedRuntimeArtifact,
    pub source: ModuleSource,
}

/// One catalog entry for a registered runtime artifact.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeArtifactCatalogEntry {
    pub artifact: ValidatedRuntimeArtifact,
    pub sources: Vec<ModuleSource>,
}

impl RuntimeArtifactCatalogEntry {
    pub fn identity(&self) -> ModuleIdentity {
        self.artifact.identity()
    }
}

/// Whether a binding declares a provider implementation or a consumer need.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityBindingRole {
    Provider,
    Consumer,
}

impl CapabilityBindingRole {
    fn database_name(self) -> &'static str {
        match self {
            Self::Provider => "provider",
            Self::Consumer => "consumer",
        }
    }

    fn parse_database_name(value: &str) -> Result<Self, RegistryError> {
        match value {
            "provider" => Ok(Self::Provider),
            "consumer" => Ok(Self::Consumer),
            other => Err(RegistryError::new(
                REGISTRY_CONTRACT_INVALID,
                format!("Stored capability binding role {other:?} is invalid"),
            )),
        }
    }
}

/// A typed declaration attached to an immutable runtime artifact. It remains
/// offline metadata until Phase 4 publishes a separate active snapshot.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "role", deny_unknown_fields)]
pub enum RegisteredCapabilityBinding {
    Provider {
        artifact: ModuleIdentity,
        binding: CapabilityProviderBinding,
    },
    Consumer {
        artifact: ModuleIdentity,
        binding: CapabilityConsumerBinding,
    },
}

impl RegisteredCapabilityBinding {
    pub fn artifact(&self) -> &ModuleIdentity {
        match self {
            Self::Provider { artifact, .. } | Self::Consumer { artifact, .. } => artifact,
        }
    }

    pub fn capability(&self) -> &CapabilityReference {
        match self {
            Self::Provider { binding, .. } => &binding.capability,
            Self::Consumer { binding, .. } => &binding.capability,
        }
    }

    pub fn role(&self) -> CapabilityBindingRole {
        match self {
            Self::Provider { .. } => CapabilityBindingRole::Provider,
            Self::Consumer { .. } => CapabilityBindingRole::Consumer,
        }
    }
}

/// The public catalog projection used by the repository's offline inspection
/// surface. There is deliberately no `activeProvider` field in Phase 3.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityCatalogSnapshot {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub definitions: Vec<CapabilityDefinition>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bindings: Vec<RegisteredCapabilityBinding>,
}

impl CapabilityCatalogSnapshot {
    pub fn is_empty(&self) -> bool {
        self.definitions.is_empty() && self.bindings.is_empty()
    }

    /// Rebuild the strict definition index used by archive preflight. The
    /// repository combines this with trusted host definitions before it asks
    /// an archive to resolve its bindings.
    pub fn definition_index(&self) -> Result<CapabilityDefinitionIndex, RegistryError> {
        CapabilityDefinitionIndex::from_definitions(&self.definitions).map_err(artifact_error)
    }
}

/// Receipt for a disabled registration. `changed` is false only for a new
/// request that repeats an already-recorded catalog entry and source.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactInstallReceipt {
    pub schema_version: u32,
    pub request_id: Uuid,
    pub artifact: ModuleIdentity,
    pub source: ModuleSource,
    pub registry_revision: u64,
    pub changed: bool,
    /// The durable desired state, if this module has one. A static build
    /// selection intentionally remains outside this field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desired: Option<DesiredModuleState>,
    /// The add operation selected this artifact only when there was no prior
    /// durable or static selection. It never enables the module.
    pub selected_by_install: bool,
}

/// Durable intent used to recover the filesystem/SQLite split around artifact
/// publication. Pending intents are never returned from `RegistrySnapshot`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingArtifactInstall {
    pub schema_version: u32,
    pub request_id: Uuid,
    pub artifact: ValidatedRuntimeArtifact,
    pub source: ModuleSource,
    pub stage_id: String,
}

/// A repository can use this to decide whether to resume a staged install,
/// treat it as already completed, or clean an orphaned stage.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PendingArtifactInstallResolution {
    Absent,
    Pending(PendingArtifactInstall),
    Installed(ArtifactInstallReceipt),
}

impl ModuleRegistry {
    /// Return all runtime metadata declared by installed artifacts. This read
    /// is intentionally data-only and has no runtime activation side effect.
    pub fn runtime_artifact_catalog(
        &self,
    ) -> Result<Vec<RuntimeArtifactCatalogEntry>, RegistryError> {
        let artifacts = load_artifacts(&self.connection)?;
        load_runtime_artifact_catalog(&self.connection, &artifacts)
    }

    /// Return dynamic definitions and provider/consumer declarations. Built-in
    /// host definitions are not fabricated here; they remain host-owned input
    /// to the artifact repository's preflight boundary.
    pub fn capability_catalog(&self) -> Result<CapabilityCatalogSnapshot, RegistryError> {
        let artifacts = load_artifacts(&self.connection)?;
        let runtime_artifacts = load_runtime_artifact_catalog(&self.connection, &artifacts)?;
        let catalog = load_capability_catalog(&self.connection)?;
        validate_catalog_snapshot(&artifacts, &runtime_artifacts, &catalog)?;
        Ok(catalog)
    }

    /// Return registry-owned dynamic definitions in the archive-preflight
    /// index shape. This is a data conversion only; it does not publish,
    /// activate, or invoke any provider.
    pub fn capability_definition_index(&self) -> Result<CapabilityDefinitionIndex, RegistryError> {
        self.capability_catalog()?.definition_index()
    }

    pub fn runtime_artifact(
        &self,
        identity: &ModuleIdentity,
    ) -> Result<Option<RuntimeArtifactCatalogEntry>, RegistryError> {
        validate_contract(identity)?;
        let artifacts = load_artifacts(&self.connection)?;
        load_runtime_artifact_catalog(&self.connection, &artifacts).map(|entries| {
            entries
                .into_iter()
                .find(|entry| entry.identity() == *identity)
        })
    }

    pub fn capability_definition(
        &self,
        reference: &CapabilityReference,
    ) -> Result<Option<CapabilityDefinition>, RegistryError> {
        validate_capability_reference(reference)?;
        Ok(self
            .capability_catalog()?
            .definitions
            .into_iter()
            .find(|definition| definition.reference() == *reference))
    }

    pub fn capability_bindings(
        &self,
        reference: &CapabilityReference,
    ) -> Result<Vec<RegisteredCapabilityBinding>, RegistryError> {
        validate_capability_reference(reference)?;
        let mut catalog = self.capability_catalog()?;
        catalog
            .bindings
            .retain(|binding| binding.capability() == reference);
        Ok(catalog.bindings)
    }

    /// Persist an intent before the artifact repository renames a staged
    /// digest directory into its published location. Repeating the same
    /// request returns the original intent; a contradictory request ID is
    /// rejected without altering it.
    pub fn begin_pending_artifact_install(
        &mut self,
        intent: &PendingArtifactInstall,
    ) -> Result<PendingArtifactInstallResolution, RegistryError> {
        require_writable(self)?;
        validate_pending_install(intent)?;
        let transaction = self.connection.transaction().map_err(transaction_error)?;

        if let Some(receipt) = load_install_receipt_by_request(&transaction, intent.request_id)? {
            ensure_receipt_replay_matches_intent(&receipt, intent)?;
            let stored = load_runtime_artifact_by_identity(&transaction, &receipt.artifact)?
                .ok_or_else(|| {
                    RegistryError::new(
                        REGISTRY_JOURNAL_INCONSISTENT,
                        "Completed artifact install has no runtime catalog record",
                    )
                })?;
            ensure_same_runtime_artifact(&stored, &intent.artifact)?;
            return Ok(PendingArtifactInstallResolution::Installed(receipt));
        }
        if let Some(existing) = load_pending_install_by_request(&transaction, intent.request_id)? {
            ensure_same_pending_install(&existing, intent)?;
            return Ok(PendingArtifactInstallResolution::Pending(existing));
        }
        if request_id_is_used(&transaction, intent.request_id)? {
            return Err(RegistryError::new(
                REGISTRY_CONTRACT_INVALID,
                format!(
                    "Artifact install request {} is already used by a registry operation",
                    intent.request_id
                ),
            ));
        }

        let intent_json = catalog_json(intent)?;
        let identity = intent.artifact.identity();
        transaction
            .execute(
                "INSERT INTO pending_artifact_installs(
                    request_id, module_id, content_digest, stage_id, intent_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    intent.request_id.to_string(),
                    identity.id,
                    identity.content_digest,
                    intent.stage_id,
                    intent_json,
                ],
            )
            .map_err(transaction_error)?;
        transaction.commit().map_err(transaction_error)?;
        Ok(PendingArtifactInstallResolution::Pending(intent.clone()))
    }

    pub fn pending_artifact_install(
        &self,
        request_id: Uuid,
    ) -> Result<PendingArtifactInstallResolution, RegistryError> {
        if let Some(receipt) = load_install_receipt_by_request(&self.connection, request_id)? {
            return Ok(PendingArtifactInstallResolution::Installed(receipt));
        }
        Ok(
            load_pending_install_by_request(&self.connection, request_id)?
                .map(PendingArtifactInstallResolution::Pending)
                .unwrap_or(PendingArtifactInstallResolution::Absent),
        )
    }

    /// Hidden recovery input. Callers must not expose this as an installed
    /// module; only `register_disabled_artifact` makes an artifact visible.
    pub fn pending_artifact_installs(&self) -> Result<Vec<PendingArtifactInstall>, RegistryError> {
        load_pending_installs(&self.connection)
    }

    /// Remove a pending intent after the repository has safely removed or
    /// quarantined its corresponding staged/published payload.
    pub fn clear_pending_artifact_install(
        &mut self,
        request_id: Uuid,
    ) -> Result<(), RegistryError> {
        require_writable(self)?;
        self.connection
            .execute(
                "DELETE FROM pending_artifact_installs WHERE request_id = ?1",
                params![request_id.to_string()],
            )
            .map(|_| ())
            .map_err(transaction_error)
    }

    /// Register validated metadata as disabled durable intent. This method
    /// never loads code, creates routes, or writes observations. It is safe for
    /// a repository that already published a validated immutable digest.
    pub fn register_disabled_artifact(
        &mut self,
        registration: &RuntimeArtifactRegistration,
    ) -> Result<ArtifactInstallReceipt, RegistryError> {
        self.register_disabled_artifact_inner(registration, false)
    }

    /// Finalize an install that was protected by a pending intent. The intent
    /// is consumed atomically with catalog publication and its receipt.
    pub fn finalize_pending_disabled_artifact(
        &mut self,
        registration: &RuntimeArtifactRegistration,
    ) -> Result<ArtifactInstallReceipt, RegistryError> {
        self.register_disabled_artifact_inner(registration, true)
    }

    fn register_disabled_artifact_inner(
        &mut self,
        registration: &RuntimeArtifactRegistration,
        require_pending: bool,
    ) -> Result<ArtifactInstallReceipt, RegistryError> {
        require_writable(self)?;
        validate_runtime_registration(registration)?;
        let transaction = self.connection.transaction().map_err(transaction_error)?;

        if let Some(receipt) =
            load_install_receipt_by_request(&transaction, registration.request_id)?
        {
            ensure_receipt_replay_matches(&receipt, registration)?;
            let stored = load_runtime_artifact_by_identity(&transaction, &receipt.artifact)?
                .ok_or_else(|| {
                    RegistryError::new(
                        REGISTRY_JOURNAL_INCONSISTENT,
                        "Completed artifact install has no runtime catalog record",
                    )
                })?;
            ensure_same_runtime_artifact(&stored, &registration.artifact)?;
            return Ok(receipt);
        }
        if request_id_is_used(&transaction, registration.request_id)? {
            return Err(RegistryError::new(
                REGISTRY_CONTRACT_INVALID,
                format!(
                    "Artifact install request {} is already used by a registry operation",
                    registration.request_id
                ),
            ));
        }

        let pending = load_pending_install_by_request(&transaction, registration.request_id)?;
        if require_pending && pending.is_none() {
            return Err(RegistryError::new(
                REGISTRY_CONTRACT_INVALID,
                format!(
                    "Artifact install request {} has no pending recovery intent",
                    registration.request_id
                ),
            ));
        }
        if let Some(pending) = &pending {
            ensure_pending_matches_registration(pending, registration)?;
        }

        let identity = registration.artifact.identity();
        validate_runtime_identity_conflict(&transaction, &identity)?;
        validate_capability_definition_conflicts(&transaction, registration)?;
        validate_binding_references(&transaction, registration)?;

        let existing_catalog = load_runtime_artifact_by_identity(&transaction, &identity)?;
        if let Some(existing) = &existing_catalog {
            ensure_same_runtime_artifact(existing, &registration.artifact)?;
        }
        let catalog_is_new = existing_catalog.is_none();
        let source_is_new = !artifact_source_exists(&transaction, &identity, registration.source)?;

        super::insert_immutable_artifact(
            &transaction,
            &ArtifactAcquisition {
                identity: identity.clone(),
                source: registration.source,
            },
        )?;

        if catalog_is_new {
            insert_runtime_artifact_catalog(&transaction, &registration.artifact)?;
            insert_capability_definitions(&transaction, registration)?;
            insert_capability_bindings(&transaction, registration)?;
        }

        let (desired, selected_by_install, desired_changed) =
            ensure_disabled_desired_state(&transaction, &identity)?;
        let changed = catalog_is_new || source_is_new || desired_changed;
        let current_revision = read_revision(&transaction)?;
        let registry_revision = if changed {
            let next_revision = current_revision.checked_add(1).ok_or_else(|| {
                RegistryError::new(
                    REGISTRY_TRANSACTION_FAILED,
                    "Registry revision cannot advance beyond u64::MAX",
                )
            })?;
            transaction
                .execute(
                    "INSERT INTO registry_revisions(revision, change_kind, request_id)
                     VALUES (?1, 'artifact_install', ?2)",
                    params![
                        sql_integer(next_revision, "registry revision")?,
                        registration.request_id.to_string(),
                    ],
                )
                .map_err(transaction_error)?;
            transaction
                .execute(
                    "UPDATE registry_metadata SET value = ?1 WHERE key = 'current_revision'",
                    params![next_revision.to_string()],
                )
                .map_err(transaction_error)?;
            next_revision
        } else {
            current_revision
        };

        let receipt = ArtifactInstallReceipt {
            schema_version: RUNTIME_ARTIFACT_CATALOG_SCHEMA_VERSION,
            request_id: registration.request_id,
            artifact: identity.clone(),
            source: registration.source,
            registry_revision,
            changed,
            desired,
            selected_by_install,
        };
        validate_install_receipt(&receipt)?;
        transaction
            .execute(
                "INSERT INTO artifact_install_requests(
                    request_id, module_id, content_digest, source, registry_revision, changed, receipt_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    registration.request_id.to_string(),
                    identity.id,
                    identity.content_digest,
                    super::module_source_name(registration.source),
                    sql_integer(registry_revision, "artifact install registry revision")?,
                    changed,
                    catalog_json(&receipt)?,
                ],
            )
            .map_err(transaction_error)?;
        if pending.is_some() {
            transaction
                .execute(
                    "DELETE FROM pending_artifact_installs WHERE request_id = ?1",
                    params![registration.request_id.to_string()],
                )
                .map_err(transaction_error)?;
        }
        transaction.commit().map_err(transaction_error)?;
        Ok(receipt)
    }
}

/// Perform the additive v1 -> v2 migration in the caller's schema
/// transaction. The original artifact, desired-state, observation, operation,
/// and static-inventory tables remain unchanged.
pub(super) fn migrate_v1_to_v2(transaction: &Transaction<'_>) -> Result<(), RegistryError> {
    transaction
        .execute_batch(
            "
            CREATE TABLE runtime_artifact_catalog(
                module_id TEXT NOT NULL,
                content_digest TEXT NOT NULL,
                record_json TEXT NOT NULL,
                canonical_metadata_json TEXT NOT NULL,
                PRIMARY KEY(module_id, content_digest),
                FOREIGN KEY(module_id, content_digest)
                    REFERENCES artifacts(module_id, content_digest)
            );

            CREATE TABLE capability_definitions(
                capability_id TEXT NOT NULL,
                capability_version TEXT NOT NULL,
                definition_digest TEXT NOT NULL,
                definition_json TEXT NOT NULL,
                PRIMARY KEY(capability_id, capability_version)
            );

            CREATE TABLE artifact_capability_bindings(
                module_id TEXT NOT NULL,
                content_digest TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('provider', 'consumer')),
                capability_id TEXT NOT NULL,
                capability_version TEXT NOT NULL,
                definition_digest TEXT NOT NULL,
                binding_key TEXT NOT NULL,
                binding_json TEXT NOT NULL,
                PRIMARY KEY(
                    module_id,
                    content_digest,
                    role,
                    capability_id,
                    capability_version,
                    definition_digest,
                    binding_key
                ),
                FOREIGN KEY(module_id, content_digest)
                    REFERENCES runtime_artifact_catalog(module_id, content_digest)
            );

            CREATE TABLE artifact_install_requests(
                request_id TEXT PRIMARY KEY,
                module_id TEXT NOT NULL,
                content_digest TEXT NOT NULL,
                source TEXT NOT NULL,
                registry_revision INTEGER NOT NULL CHECK(registry_revision >= 0),
                changed INTEGER NOT NULL CHECK(changed IN (0, 1)),
                receipt_json TEXT NOT NULL,
                FOREIGN KEY(module_id, content_digest)
                    REFERENCES runtime_artifact_catalog(module_id, content_digest)
            );

            CREATE TABLE pending_artifact_installs(
                request_id TEXT PRIMARY KEY,
                module_id TEXT NOT NULL,
                content_digest TEXT NOT NULL,
                stage_id TEXT NOT NULL UNIQUE,
                intent_json TEXT NOT NULL
            );

            CREATE INDEX artifact_capability_bindings_capability_idx
                ON artifact_capability_bindings(
                    capability_id,
                    capability_version,
                    definition_digest,
                    role
                );
            CREATE INDEX pending_artifact_installs_identity_idx
                ON pending_artifact_installs(module_id, content_digest);
            ",
        )
        .map_err(|error| {
            RegistryError::new(
                REGISTRY_MIGRATION_FAILED,
                format!("Cannot migrate module registry catalog to schema v2: {error}"),
            )
        })
}

/// Rewrite persisted artifact documents from before the Cordis runtime
/// migration. `uiContributions` was removed from the native manifest contract,
/// so it must be discarded from every durable copy before strict deserialization.
pub(super) fn migrate_v3_to_v4(transaction: &Transaction<'_>) -> Result<(), RegistryError> {
    let catalog_rows = {
        let mut statement = transaction
            .prepare(
                "SELECT module_id, content_digest, record_json, canonical_metadata_json
                 FROM runtime_artifact_catalog",
            )
            .map_err(|error| {
                RegistryError::new(
                    REGISTRY_MIGRATION_FAILED,
                    format!("Cannot read runtime artifact catalog for migration: {error}"),
                )
            })?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| {
                RegistryError::new(
                    REGISTRY_MIGRATION_FAILED,
                    format!("Cannot enumerate runtime artifact catalog for migration: {error}"),
                )
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                RegistryError::new(
                    REGISTRY_MIGRATION_FAILED,
                    format!("Cannot decode runtime artifact catalog row for migration: {error}"),
                )
            })?;
        rows
    };
    for (module_id, content_digest, record, canonical_metadata) in catalog_rows {
        let record = remove_legacy_ui_contributions(
            &record,
            "runtime artifact catalog record",
            "/manifest",
        )?;
        let canonical_metadata = remove_legacy_ui_contributions(
            &canonical_metadata,
            "runtime artifact canonical metadata",
            "/manifest",
        )?;
        transaction
            .execute(
                "UPDATE runtime_artifact_catalog
                 SET record_json = ?3, canonical_metadata_json = ?4
                 WHERE module_id = ?1 AND content_digest = ?2",
                params![module_id, content_digest, record, canonical_metadata],
            )
            .map_err(|error| {
                RegistryError::new(
                    REGISTRY_MIGRATION_FAILED,
                    format!("Cannot rewrite runtime artifact catalog record: {error}"),
                )
            })?;
    }

    let pending_rows = {
        let mut statement = transaction
            .prepare("SELECT request_id, intent_json FROM pending_artifact_installs")
            .map_err(|error| {
                RegistryError::new(
                    REGISTRY_MIGRATION_FAILED,
                    format!("Cannot read pending artifact installs for migration: {error}"),
                )
            })?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| {
                RegistryError::new(
                    REGISTRY_MIGRATION_FAILED,
                    format!("Cannot enumerate pending artifact installs for migration: {error}"),
                )
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                RegistryError::new(
                    REGISTRY_MIGRATION_FAILED,
                    format!("Cannot decode pending artifact install for migration: {error}"),
                )
            })?;
        rows
    };
    for (request_id, intent) in pending_rows {
        let intent = remove_legacy_ui_contributions(
            &intent,
            "pending artifact install",
            "/artifact/manifest",
        )?;
        transaction
            .execute(
                "UPDATE pending_artifact_installs SET intent_json = ?2 WHERE request_id = ?1",
                params![request_id, intent],
            )
            .map_err(|error| {
                RegistryError::new(
                    REGISTRY_MIGRATION_FAILED,
                    format!("Cannot rewrite pending artifact install: {error}"),
                )
            })?;
    }
    Ok(())
}

fn remove_legacy_ui_contributions(
    source: &str,
    subject: &str,
    manifest_pointer: &str,
) -> Result<String, RegistryError> {
    let mut document: serde_json::Value = serde_json::from_str(source).map_err(|error| {
        RegistryError::new(
            REGISTRY_MIGRATION_FAILED,
            format!("Stored {subject} JSON cannot be migrated: {error}"),
        )
    })?;
    let manifest = document
        .pointer_mut(manifest_pointer)
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| {
            RegistryError::new(
                REGISTRY_MIGRATION_FAILED,
                format!("Stored {subject} JSON lacks an object manifest"),
            )
        })?;
    manifest.remove("uiContributions");
    serde_json::to_string(&canonicalize_json(document)).map_err(|error| {
        RegistryError::new(
            REGISTRY_MIGRATION_FAILED,
            format!("Cannot serialize migrated {subject} JSON: {error}"),
        )
    })
}

fn require_writable(registry: &ModuleRegistry) -> Result<(), RegistryError> {
    if registry.access != super::Access::Writable {
        return Err(RegistryError::new(
            REGISTRY_TRANSACTION_FAILED,
            "Cannot mutate a read-only registry",
        ));
    }
    Ok(())
}

fn artifact_error(error: crate::module_control::artifact::ArtifactContractError) -> RegistryError {
    RegistryError::new(
        REGISTRY_CONTRACT_INVALID,
        format!("{}: {}", error.code, error.message),
    )
}

fn validate_runtime_registration(
    registration: &RuntimeArtifactRegistration,
) -> Result<(), RegistryError> {
    let artifact = &registration.artifact;
    let identity = artifact.identity();
    validate_contract(&identity)?;
    if identity.runtime_kind != ModuleRuntimeKind::FrontendEsm {
        return Err(RegistryError::new(
            REGISTRY_CONTRACT_INVALID,
            "Phase 3 runtime catalog accepts frontend_esm artifacts only",
        ));
    }
    if artifact.content_digest != artifact.integrity.content_digest_sha256 {
        return Err(RegistryError::new(
            REGISTRY_CONTRACT_INVALID,
            "Validated runtime artifact content digest does not match its integrity index",
        ));
    }
    artifact.manifest.validate().map_err(artifact_error)?;
    validate_integrity_metadata(artifact)?;
    Ok(())
}

fn validate_integrity_metadata(artifact: &ValidatedRuntimeArtifact) -> Result<(), RegistryError> {
    let mut previous = None;
    let mut paths = BTreeSet::new();
    for file in &artifact.integrity.files {
        if !valid_archive_path(&file.path)
            || file.path == crate::module_control::artifact::ARTIFACT_INTEGRITY_PATH
            || !is_sha256(&file.digest_sha256)
        {
            return Err(RegistryError::new(
                REGISTRY_CONTRACT_INVALID,
                "Validated runtime artifact has an invalid integrity metadata entry",
            ));
        }
        if previous
            .as_deref()
            .is_some_and(|value: &str| value >= file.path.as_str())
            || !paths.insert(file.path.as_str())
        {
            return Err(RegistryError::new(
                REGISTRY_CONTRACT_INVALID,
                "Validated runtime artifact integrity entries must be sorted and unique",
            ));
        }
        previous = Some(file.path.clone());
    }
    Ok(())
}

fn valid_archive_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_pending_install(intent: &PendingArtifactInstall) -> Result<(), RegistryError> {
    if intent.schema_version != RUNTIME_ARTIFACT_CATALOG_SCHEMA_VERSION {
        return Err(RegistryError::new(
            REGISTRY_CONTRACT_INVALID,
            format!(
                "Pending artifact install schema version {} is unsupported",
                intent.schema_version
            ),
        ));
    }
    if !valid_stage_id(&intent.stage_id) {
        return Err(RegistryError::new(
            REGISTRY_CONTRACT_INVALID,
            "Pending artifact install stage id is invalid",
        ));
    }
    validate_runtime_registration(&RuntimeArtifactRegistration {
        request_id: intent.request_id,
        artifact: intent.artifact.clone(),
        source: intent.source,
    })
}

fn valid_stage_id(stage_id: &str) -> bool {
    !stage_id.is_empty()
        && stage_id != "."
        && stage_id != ".."
        && !stage_id.contains("..")
        && stage_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn validate_capability_reference(reference: &CapabilityReference) -> Result<(), RegistryError> {
    if reference.id.trim().is_empty()
        || reference.id.contains(char::is_whitespace)
        || semver::Version::parse(&reference.version).is_err()
        || !is_sha256(&reference.definition_digest_sha256)
    {
        return Err(RegistryError::new(
            REGISTRY_CONTRACT_INVALID,
            "Capability reference requires a nonempty id, semantic version, and SHA-256 definition digest",
        ));
    }
    Ok(())
}

fn canonicalize_json(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(values) => serde_json::Value::Array(
            values
                .into_iter()
                .map(canonicalize_json)
                .collect::<Vec<_>>(),
        ),
        serde_json::Value::Object(values) => {
            let values = values.into_iter().collect::<BTreeMap<_, _>>();
            let mut canonical = serde_json::Map::new();
            for (key, value) in values {
                canonical.insert(key, canonicalize_json(value));
            }
            serde_json::Value::Object(canonical)
        }
        other => other,
    }
}

fn catalog_json<T: Serialize>(value: &T) -> Result<String, RegistryError> {
    let value = serde_json::to_value(value).map_err(|error| {
        RegistryError::new(
            REGISTRY_CONTRACT_INVALID,
            format!("Cannot serialize registry catalog metadata: {error}"),
        )
    })?;
    serde_json::to_string(&canonicalize_json(value)).map_err(|error| {
        RegistryError::new(
            REGISTRY_CONTRACT_INVALID,
            format!("Cannot canonicalize registry catalog metadata: {error}"),
        )
    })
}

fn parse_catalog_json<T: serde::de::DeserializeOwned>(
    source: &str,
    code: &'static str,
    subject: &str,
) -> Result<T, RegistryError> {
    serde_json::from_str(source).map_err(|error| {
        RegistryError::new(code, format!("Stored {subject} JSON is invalid: {error}"))
    })
}

fn canonical_metadata_json(artifact: &ValidatedRuntimeArtifact) -> Result<String, RegistryError> {
    catalog_json(&artifact.canonical_metadata())
}

fn same_canonical_artifact(
    left: &ValidatedRuntimeArtifact,
    right: &ValidatedRuntimeArtifact,
) -> Result<bool, RegistryError> {
    Ok(left.identity() == right.identity()
        && canonical_metadata_json(left)? == canonical_metadata_json(right)?)
}

fn ensure_same_runtime_artifact(
    existing: &ValidatedRuntimeArtifact,
    candidate: &ValidatedRuntimeArtifact,
) -> Result<(), RegistryError> {
    if !same_canonical_artifact(existing, candidate)? {
        return Err(RegistryError::new(
            REGISTRY_ARTIFACT_IMMUTABLE,
            format!(
                "Runtime artifact {}@{} already has different immutable canonical metadata",
                existing.identity().id,
                existing.identity().content_digest
            ),
        ));
    }
    Ok(())
}

/// Enforce the runtime identity rule for both the Phase 3 catalog intake and
/// the established generic registry mutation path. Static inventory remains
/// deliberately exempt: it is build membership, not a replaceable archive.
pub(super) fn validate_runtime_identity_conflict(
    transaction: &Transaction<'_>,
    identity: &ModuleIdentity,
) -> Result<(), RegistryError> {
    if identity.runtime_kind == ModuleRuntimeKind::StaticBuiltin {
        return Ok(());
    }
    let mut statement = transaction
        .prepare("SELECT identity_json FROM artifacts WHERE module_id = ?1")
        .map_err(transaction_error)?;
    let identities = statement
        .query_map(params![identity.id], |row| row.get::<_, String>(0))
        .map_err(transaction_error)?;
    for stored in identities {
        let stored: ModuleIdentity = parse_stored_contract(
            &stored.map_err(transaction_error)?,
            REGISTRY_ARTIFACT_IMMUTABLE,
        )?;
        if stored.runtime_kind != ModuleRuntimeKind::StaticBuiltin
            && stored.version == identity.version
            && stored.content_digest != identity.content_digest
        {
            return Err(RegistryError::new(
                REGISTRY_ARTIFACT_IMMUTABLE,
                format!(
                    "Runtime module {} version {} is already bound to immutable content digest {}",
                    identity.id, identity.version, stored.content_digest
                ),
            ));
        }
    }
    Ok(())
}

fn load_runtime_artifact_by_identity(
    connection: &Connection,
    identity: &ModuleIdentity,
) -> Result<Option<ValidatedRuntimeArtifact>, RegistryError> {
    let record: Option<(String, String)> = connection
        .query_row(
            "SELECT record_json, canonical_metadata_json
             FROM runtime_artifact_catalog
             WHERE module_id = ?1 AND content_digest = ?2",
            params![identity.id, identity.content_digest],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(transaction_error)?;
    let Some((record, canonical_metadata)) = record else {
        return Ok(None);
    };
    let artifact: ValidatedRuntimeArtifact = parse_catalog_json(
        &record,
        REGISTRY_JOURNAL_INCONSISTENT,
        "runtime artifact catalog record",
    )?;
    validate_stored_runtime_artifact(&artifact, identity, &canonical_metadata)?;
    Ok(Some(artifact))
}

fn validate_stored_runtime_artifact(
    artifact: &ValidatedRuntimeArtifact,
    identity: &ModuleIdentity,
    stored_canonical_metadata: &str,
) -> Result<(), RegistryError> {
    validate_runtime_registration(&RuntimeArtifactRegistration {
        request_id: Uuid::nil(),
        artifact: artifact.clone(),
        source: ModuleSource::User,
    })?;
    if artifact.identity() != *identity
        || canonical_metadata_json(artifact)? != stored_canonical_metadata
    {
        return Err(RegistryError::new(
            REGISTRY_JOURNAL_INCONSISTENT,
            format!(
                "Runtime artifact catalog metadata for {}@{} is inconsistent",
                identity.id, identity.content_digest
            ),
        ));
    }
    Ok(())
}

pub(super) fn load_runtime_artifact_catalog(
    connection: &Connection,
    artifacts: &[RegisteredArtifact],
) -> Result<Vec<RuntimeArtifactCatalogEntry>, RegistryError> {
    let sources = artifacts
        .iter()
        .map(|artifact| {
            (
                (
                    artifact.identity.id.clone(),
                    artifact.identity.content_digest.clone(),
                ),
                artifact.sources.clone(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut statement = connection
        .prepare(
            "SELECT module_id, content_digest, record_json, canonical_metadata_json
             FROM runtime_artifact_catalog
             ORDER BY module_id, content_digest",
        )
        .map_err(transaction_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(transaction_error)?;
    rows.map(|row| {
        let (module_id, content_digest, record, canonical_metadata) =
            row.map_err(transaction_error)?;
        let artifact: ValidatedRuntimeArtifact = parse_catalog_json(
            &record,
            REGISTRY_JOURNAL_INCONSISTENT,
            "runtime artifact catalog record",
        )?;
        let identity = artifact.identity();
        if identity.id != module_id || identity.content_digest != content_digest {
            return Err(RegistryError::new(
                REGISTRY_JOURNAL_INCONSISTENT,
                "Runtime artifact catalog key does not match its validated record",
            ));
        }
        validate_stored_runtime_artifact(&artifact, &identity, &canonical_metadata)?;
        let sources = sources
            .get(&(module_id.clone(), content_digest.clone()))
            .cloned()
            .filter(|sources| !sources.is_empty())
            .ok_or_else(|| {
                RegistryError::new(
                    REGISTRY_ARTIFACT_REFERENCE_MISSING,
                    format!(
                        "Runtime artifact catalog record {}@{} lacks immutable artifact provenance",
                        module_id, content_digest
                    ),
                )
            })?;
        Ok(RuntimeArtifactCatalogEntry { artifact, sources })
    })
    .collect()
}

pub(super) fn load_capability_catalog(
    connection: &Connection,
) -> Result<CapabilityCatalogSnapshot, RegistryError> {
    let mut definition_statement = connection
        .prepare(
            "SELECT capability_id, capability_version, definition_digest, definition_json
             FROM capability_definitions
             ORDER BY capability_id, capability_version",
        )
        .map_err(transaction_error)?;
    let definition_rows = definition_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(transaction_error)?;
    let definitions = definition_rows
        .map(|row| {
            let (id, version, digest, record) = row.map_err(transaction_error)?;
            let definition: CapabilityDefinition = parse_catalog_json(
                &record,
                REGISTRY_JOURNAL_INCONSISTENT,
                "capability definition",
            )?;
            definition.validate().map_err(artifact_error)?;
            if definition.id != id
                || definition.version != version
                || definition.definition_digest_sha256 != digest
            {
                return Err(RegistryError::new(
                    REGISTRY_JOURNAL_INCONSISTENT,
                    "Stored capability definition key does not match its metadata",
                ));
            }
            Ok(definition)
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut binding_statement = connection
        .prepare(
            "SELECT b.role, a.identity_json, b.capability_id, b.capability_version,
                    b.definition_digest, b.binding_key, b.binding_json
             FROM artifact_capability_bindings b
             JOIN artifacts a
               ON a.module_id = b.module_id AND a.content_digest = b.content_digest
             ORDER BY b.capability_id, b.capability_version, b.definition_digest,
                      b.role, b.module_id, b.content_digest, b.binding_key",
        )
        .map_err(transaction_error)?;
    let binding_rows = binding_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(transaction_error)?;
    let bindings = binding_rows
        .map(|row| {
            let (
                role,
                identity_json,
                capability_id,
                capability_version,
                digest,
                binding_key,
                record,
            ) = row.map_err(transaction_error)?;
            let artifact: ModuleIdentity =
                parse_stored_contract(&identity_json, REGISTRY_JOURNAL_INCONSISTENT)?;
            validate_contract(&artifact)?;
            let role = CapabilityBindingRole::parse_database_name(&role)?;
            let binding = match role {
                CapabilityBindingRole::Provider => {
                    let binding: CapabilityProviderBinding = parse_catalog_json(
                        &record,
                        REGISTRY_JOURNAL_INCONSISTENT,
                        "provider capability binding",
                    )?;
                    RegisteredCapabilityBinding::Provider { artifact, binding }
                }
                CapabilityBindingRole::Consumer => {
                    let binding: CapabilityConsumerBinding = parse_catalog_json(
                        &record,
                        REGISTRY_JOURNAL_INCONSISTENT,
                        "consumer capability binding",
                    )?;
                    RegisteredCapabilityBinding::Consumer { artifact, binding }
                }
            };
            let reference = binding.capability();
            validate_capability_reference(reference)?;
            if reference.id != capability_id
                || reference.version != capability_version
                || reference.definition_digest_sha256 != digest
                || binding_key != binding_storage_key(&binding)?
            {
                return Err(RegistryError::new(
                    REGISTRY_JOURNAL_INCONSISTENT,
                    "Stored capability binding key does not match its metadata",
                ));
            }
            Ok(binding)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CapabilityCatalogSnapshot {
        definitions,
        bindings,
    })
}

fn artifact_source_exists(
    transaction: &Transaction<'_>,
    identity: &ModuleIdentity,
    source: ModuleSource,
) -> Result<bool, RegistryError> {
    transaction
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM artifact_sources
                 WHERE module_id = ?1 AND content_digest = ?2 AND source = ?3
            )",
            params![
                identity.id,
                identity.content_digest,
                super::module_source_name(source),
            ],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(transaction_error)
}

fn insert_runtime_artifact_catalog(
    transaction: &Transaction<'_>,
    artifact: &ValidatedRuntimeArtifact,
) -> Result<(), RegistryError> {
    let identity = artifact.identity();
    transaction
        .execute(
            "INSERT INTO runtime_artifact_catalog(
                module_id, content_digest, record_json, canonical_metadata_json
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                identity.id,
                identity.content_digest,
                catalog_json(artifact)?,
                canonical_metadata_json(artifact)?,
            ],
        )
        .map(|_| ())
        .map_err(transaction_error)
}

fn validate_capability_definition_conflicts(
    transaction: &Transaction<'_>,
    registration: &RuntimeArtifactRegistration,
) -> Result<(), RegistryError> {
    for definition in &registration.artifact.manifest.capabilities.definitions {
        let stored: Option<(String, String)> = transaction
            .query_row(
                "SELECT definition_digest, definition_json
                 FROM capability_definitions
                 WHERE capability_id = ?1 AND capability_version = ?2",
                params![definition.id, definition.version],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(transaction_error)?;
        let Some((digest, record)) = stored else {
            continue;
        };
        let existing: CapabilityDefinition = parse_catalog_json(
            &record,
            REGISTRY_JOURNAL_INCONSISTENT,
            "capability definition",
        )?;
        existing.validate().map_err(artifact_error)?;
        if digest != definition.definition_digest_sha256
            || catalog_json(&existing)? != catalog_json(definition)?
        {
            return Err(RegistryError::new(
                REGISTRY_ARTIFACT_IMMUTABLE,
                format!(
                    "Capability {}@{} already has different immutable definition content",
                    definition.id, definition.version
                ),
            ));
        }
    }
    Ok(())
}

fn validate_binding_references(
    transaction: &Transaction<'_>,
    registration: &RuntimeArtifactRegistration,
) -> Result<(), RegistryError> {
    let mut known = BTreeMap::<(String, String), String>::new();
    let mut statement = transaction
        .prepare(
            "SELECT capability_id, capability_version, definition_digest
             FROM capability_definitions",
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
    for row in rows {
        let (id, version, digest) = row.map_err(transaction_error)?;
        known.insert((id, version), digest);
    }
    for definition in &registration.artifact.manifest.capabilities.definitions {
        known.insert(
            (definition.id.clone(), definition.version.clone()),
            definition.definition_digest_sha256.clone(),
        );
    }
    for reference in registration
        .artifact
        .manifest
        .capabilities
        .providers
        .iter()
        .map(|binding| &binding.capability)
        .chain(
            registration
                .artifact
                .manifest
                .capabilities
                .consumers
                .iter()
                .map(|binding| &binding.capability),
        )
    {
        if let Some(expected) = known.get(&(reference.id.clone(), reference.version.clone())) {
            if expected != &reference.definition_digest_sha256 {
                return Err(RegistryError::new(
                    REGISTRY_ARTIFACT_IMMUTABLE,
                    format!(
                        "Capability binding {}@{} conflicts with immutable definition digest",
                        reference.id, reference.version
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn insert_capability_definitions(
    transaction: &Transaction<'_>,
    registration: &RuntimeArtifactRegistration,
) -> Result<(), RegistryError> {
    for definition in &registration.artifact.manifest.capabilities.definitions {
        transaction
            .execute(
                "INSERT OR IGNORE INTO capability_definitions(
                    capability_id, capability_version, definition_digest, definition_json
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    definition.id,
                    definition.version,
                    definition.definition_digest_sha256,
                    catalog_json(definition)?,
                ],
            )
            .map_err(transaction_error)?;
    }
    Ok(())
}

fn binding_storage_key(binding: &RegisteredCapabilityBinding) -> Result<String, RegistryError> {
    let canonical = catalog_json(binding)?;
    Ok(format!("{:x}", Sha256::digest(canonical.as_bytes())))
}

fn insert_capability_binding<T: Serialize>(
    transaction: &Transaction<'_>,
    identity: &ModuleIdentity,
    role: CapabilityBindingRole,
    reference: &CapabilityReference,
    binding: &T,
) -> Result<(), RegistryError> {
    let stored = match role {
        CapabilityBindingRole::Provider => {
            let binding: CapabilityProviderBinding = parse_catalog_json(
                &catalog_json(binding)?,
                REGISTRY_CONTRACT_INVALID,
                "provider capability binding",
            )?;
            RegisteredCapabilityBinding::Provider {
                artifact: identity.clone(),
                binding,
            }
        }
        CapabilityBindingRole::Consumer => {
            let binding: CapabilityConsumerBinding = parse_catalog_json(
                &catalog_json(binding)?,
                REGISTRY_CONTRACT_INVALID,
                "consumer capability binding",
            )?;
            RegisteredCapabilityBinding::Consumer {
                artifact: identity.clone(),
                binding,
            }
        }
    };
    transaction
        .execute(
            "INSERT INTO artifact_capability_bindings(
                module_id, content_digest, role, capability_id, capability_version,
                definition_digest, binding_key, binding_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                identity.id,
                identity.content_digest,
                role.database_name(),
                reference.id,
                reference.version,
                reference.definition_digest_sha256,
                binding_storage_key(&stored)?,
                catalog_json(binding)?,
            ],
        )
        .map(|_| ())
        .map_err(transaction_error)
}

fn insert_capability_bindings(
    transaction: &Transaction<'_>,
    registration: &RuntimeArtifactRegistration,
) -> Result<(), RegistryError> {
    let identity = registration.artifact.identity();
    for binding in &registration.artifact.manifest.capabilities.providers {
        insert_capability_binding(
            transaction,
            &identity,
            CapabilityBindingRole::Provider,
            &binding.capability,
            binding,
        )?;
    }
    for binding in &registration.artifact.manifest.capabilities.consumers {
        insert_capability_binding(
            transaction,
            &identity,
            CapabilityBindingRole::Consumer,
            &binding.capability,
            binding,
        )?;
    }
    Ok(())
}

fn ensure_disabled_desired_state(
    transaction: &Transaction<'_>,
    identity: &ModuleIdentity,
) -> Result<(Option<DesiredModuleState>, bool, bool), RegistryError> {
    let existing: Option<String> = transaction
        .query_row(
            "SELECT state_json FROM desired_state WHERE module_id = ?1",
            params![identity.id],
            |row| row.get(0),
        )
        .optional()
        .map_err(transaction_error)?;
    if let Some(existing) = existing {
        return Ok((
            Some(parse_stored_contract(
                &existing,
                REGISTRY_JOURNAL_INCONSISTENT,
            )?),
            false,
            false,
        ));
    }
    let static_selection: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM static_inventory WHERE module_id = ?1)",
            params![identity.id],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(transaction_error)?;
    if static_selection {
        return Ok((None, false, false));
    }
    let desired = DesiredModuleState {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        module_id: identity.id.clone(),
        selected_artifact: Some(identity.clone()),
        enabled: false,
        configuration_revision: 1,
    };
    validate_contract(&desired)?;
    super::store_desired(transaction, &desired)?;
    Ok((Some(desired), true, true))
}

fn request_id_is_used(connection: &Connection, request_id: Uuid) -> Result<bool, RegistryError> {
    connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM registry_revisions WHERE request_id = ?1
                UNION
                SELECT 1 FROM operations WHERE request_id = ?1
            )",
            params![request_id.to_string()],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(transaction_error)
}

fn validate_install_receipt(receipt: &ArtifactInstallReceipt) -> Result<(), RegistryError> {
    if receipt.schema_version != RUNTIME_ARTIFACT_CATALOG_SCHEMA_VERSION {
        return Err(RegistryError::new(
            REGISTRY_JOURNAL_INCONSISTENT,
            "Artifact install receipt has an unsupported schema version",
        ));
    }
    validate_contract(&receipt.artifact)?;
    if receipt.selected_by_install {
        let desired = receipt.desired.as_ref().ok_or_else(|| {
            RegistryError::new(
                REGISTRY_JOURNAL_INCONSISTENT,
                "Artifact install receipt selected an artifact without a desired state",
            )
        })?;
        if desired.enabled
            || desired.selected_artifact.as_ref() != Some(&receipt.artifact)
            || desired.configuration_revision != 1
        {
            return Err(RegistryError::new(
                REGISTRY_JOURNAL_INCONSISTENT,
                "Artifact install receipt has an invalid disabled desired selection",
            ));
        }
    }
    Ok(())
}

fn load_install_receipt_by_request(
    connection: &Connection,
    request_id: Uuid,
) -> Result<Option<ArtifactInstallReceipt>, RegistryError> {
    let row: Option<(String, String, String, i64, i64, String)> = connection
        .query_row(
            "SELECT module_id, content_digest, source, registry_revision, changed, receipt_json
             FROM artifact_install_requests WHERE request_id = ?1",
            params![request_id.to_string()],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()
        .map_err(transaction_error)?;
    let Some((module_id, content_digest, source, revision, changed, record)) = row else {
        return Ok(None);
    };
    let receipt: ArtifactInstallReceipt = parse_catalog_json(
        &record,
        REGISTRY_JOURNAL_INCONSISTENT,
        "artifact install receipt",
    )?;
    validate_install_receipt(&receipt)?;
    if receipt.request_id != request_id
        || receipt.artifact.id != module_id
        || receipt.artifact.content_digest != content_digest
        || super::module_source_name(receipt.source) != source
        || receipt.registry_revision
            != u64::try_from(revision).map_err(|_| {
                RegistryError::new(
                    REGISTRY_JOURNAL_INCONSISTENT,
                    "Artifact install receipt registry revision is negative",
                )
            })?
        || (if receipt.changed { 1 } else { 0 }) != changed
    {
        return Err(RegistryError::new(
            REGISTRY_JOURNAL_INCONSISTENT,
            "Artifact install receipt row does not match its receipt metadata",
        ));
    }
    Ok(Some(receipt))
}

fn ensure_receipt_replay_matches(
    receipt: &ArtifactInstallReceipt,
    registration: &RuntimeArtifactRegistration,
) -> Result<(), RegistryError> {
    if receipt.artifact != registration.artifact.identity() || receipt.source != registration.source
    {
        return Err(RegistryError::new(
            REGISTRY_CONTRACT_INVALID,
            format!(
                "Artifact install request {} is already bound to another artifact or source",
                registration.request_id
            ),
        ));
    }
    Ok(())
}

fn ensure_receipt_replay_matches_intent(
    receipt: &ArtifactInstallReceipt,
    intent: &PendingArtifactInstall,
) -> Result<(), RegistryError> {
    if receipt.artifact != intent.artifact.identity() || receipt.source != intent.source {
        return Err(RegistryError::new(
            REGISTRY_CONTRACT_INVALID,
            format!(
                "Artifact install request {} is already bound to another artifact or source",
                intent.request_id
            ),
        ));
    }
    Ok(())
}

fn ensure_same_pending_install(
    existing: &PendingArtifactInstall,
    candidate: &PendingArtifactInstall,
) -> Result<(), RegistryError> {
    if existing.source != candidate.source
        || existing.stage_id != candidate.stage_id
        || !same_canonical_artifact(&existing.artifact, &candidate.artifact)?
    {
        return Err(RegistryError::new(
            REGISTRY_CONTRACT_INVALID,
            format!(
                "Pending artifact install request {} is already bound to different immutable intent",
                candidate.request_id
            ),
        ));
    }
    Ok(())
}

fn ensure_pending_matches_registration(
    pending: &PendingArtifactInstall,
    registration: &RuntimeArtifactRegistration,
) -> Result<(), RegistryError> {
    if pending.source != registration.source
        || !same_canonical_artifact(&pending.artifact, &registration.artifact)?
    {
        return Err(RegistryError::new(
            REGISTRY_CONTRACT_INVALID,
            format!(
                "Pending artifact install request {} does not match final registration",
                registration.request_id
            ),
        ));
    }
    Ok(())
}

fn load_pending_install_by_request(
    connection: &Connection,
    request_id: Uuid,
) -> Result<Option<PendingArtifactInstall>, RegistryError> {
    let row: Option<(String, String, String, String)> = connection
        .query_row(
            "SELECT module_id, content_digest, stage_id, intent_json
             FROM pending_artifact_installs WHERE request_id = ?1",
            params![request_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(transaction_error)?;
    let Some((module_id, content_digest, stage_id, record)) = row else {
        return Ok(None);
    };
    let intent: PendingArtifactInstall = parse_catalog_json(
        &record,
        REGISTRY_JOURNAL_INCONSISTENT,
        "pending artifact install",
    )?;
    validate_pending_install(&intent)?;
    let identity = intent.artifact.identity();
    if intent.request_id != request_id
        || identity.id != module_id
        || identity.content_digest != content_digest
        || intent.stage_id != stage_id
    {
        return Err(RegistryError::new(
            REGISTRY_JOURNAL_INCONSISTENT,
            "Pending artifact install row does not match its intent metadata",
        ));
    }
    Ok(Some(intent))
}

fn load_pending_installs(
    connection: &Connection,
) -> Result<Vec<PendingArtifactInstall>, RegistryError> {
    let request_ids = {
        let mut statement = connection
            .prepare("SELECT request_id FROM pending_artifact_installs ORDER BY request_id")
            .map_err(transaction_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(transaction_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(transaction_error)?
    };
    request_ids
        .into_iter()
        .map(|request_id| {
            let request_id = Uuid::parse_str(&request_id).map_err(|error| {
                RegistryError::new(
                    REGISTRY_JOURNAL_INCONSISTENT,
                    format!("Pending artifact install request id is invalid: {error}"),
                )
            })?;
            load_pending_install_by_request(connection, request_id)?.ok_or_else(|| {
                RegistryError::new(
                    REGISTRY_JOURNAL_INCONSISTENT,
                    "Pending artifact install disappeared during catalog read",
                )
            })
        })
        .collect()
}

pub(super) fn validate_catalog_snapshot(
    artifacts: &[RegisteredArtifact],
    runtime_artifacts: &[RuntimeArtifactCatalogEntry],
    capability_catalog: &CapabilityCatalogSnapshot,
) -> Result<(), RegistryError> {
    let artifact_identities = artifacts
        .iter()
        .map(|artifact| {
            (
                (
                    artifact.identity.id.clone(),
                    artifact.identity.content_digest.clone(),
                ),
                artifact,
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut expected_definitions = BTreeMap::<(String, String), String>::new();
    let mut expected_bindings = BTreeSet::new();
    for entry in runtime_artifacts {
        let identity = entry.identity();
        if identity.runtime_kind == ModuleRuntimeKind::StaticBuiltin
            || entry.sources.is_empty()
            || artifact_identities
                .get(&(identity.id.clone(), identity.content_digest.clone()))
                .map_or(true, |artifact| artifact.identity != identity)
        {
            return Err(RegistryError::new(
                REGISTRY_JOURNAL_INCONSISTENT,
                "Runtime catalog contains an invalid or unproven artifact record",
            ));
        }
        for definition in &entry.artifact.manifest.capabilities.definitions {
            let key = (definition.id.clone(), definition.version.clone());
            let canonical = catalog_json(definition)?;
            if let Some(existing) = expected_definitions.insert(key.clone(), canonical.clone()) {
                if existing != canonical {
                    return Err(RegistryError::new(
                        REGISTRY_ARTIFACT_IMMUTABLE,
                        format!(
                            "Capability {}@{} has conflicting catalog definitions",
                            key.0, key.1
                        ),
                    ));
                }
            }
        }
        for binding in &entry.artifact.manifest.capabilities.providers {
            expected_bindings.insert(catalog_json(&RegisteredCapabilityBinding::Provider {
                artifact: identity.clone(),
                binding: binding.clone(),
            })?);
        }
        for binding in &entry.artifact.manifest.capabilities.consumers {
            expected_bindings.insert(catalog_json(&RegisteredCapabilityBinding::Consumer {
                artifact: identity.clone(),
                binding: binding.clone(),
            })?);
        }
    }
    let actual_definitions = capability_catalog
        .definitions
        .iter()
        .map(|definition| {
            Ok::<_, RegistryError>((
                (definition.id.clone(), definition.version.clone()),
                catalog_json(definition)?,
            ))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    if expected_definitions != actual_definitions {
        return Err(RegistryError::new(
            REGISTRY_JOURNAL_INCONSISTENT,
            "Capability definition catalog does not match immutable runtime artifact metadata",
        ));
    }
    let actual_bindings = capability_catalog
        .bindings
        .iter()
        .map(catalog_json)
        .collect::<Result<BTreeSet<_>, _>>()?;
    if expected_bindings != actual_bindings {
        return Err(RegistryError::new(
            REGISTRY_JOURNAL_INCONSISTENT,
            "Capability binding catalog does not match immutable runtime artifact metadata",
        ));
    }
    for binding in &capability_catalog.bindings {
        let reference = binding.capability();
        if let Some(definition) = capability_catalog.definitions.iter().find(|definition| {
            definition.id == reference.id && definition.version == reference.version
        }) {
            if definition.definition_digest_sha256 != reference.definition_digest_sha256 {
                return Err(RegistryError::new(
                    REGISTRY_ARTIFACT_IMMUTABLE,
                    format!(
                        "Capability binding {}@{} conflicts with stored definition digest",
                        reference.id, reference.version
                    ),
                ));
            }
        }
    }
    Ok(())
}
