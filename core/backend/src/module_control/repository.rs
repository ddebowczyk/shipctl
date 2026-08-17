//! Offline repository boundary for immutable runtime module artifacts.
//!
//! The repository owns filesystem admission and registry coordination.  It
//! deliberately does not import module code, start a provider, construct a
//! route, or interact with a webview.  Those are Phase 4 concerns.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};

use crate::state::DurableWriteBarrier;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::artifact::{
    canonical_content_digest, ArtifactContractError, ArtifactIntegrityFile, ArtifactIntegrityIndex,
    ArtifactPreflightContext, CanonicalArtifactMetadata, CapabilityDefinition,
    CapabilityDefinitionIndex, RuntimeArtifactArchive, RuntimeArtifactManifest,
    ValidatedRuntimeArtifact, ARTIFACT_INTEGRITY_PATH, ARTIFACT_MANIFEST_PATH,
};
use super::contracts::{
    DesiredModuleState, ModuleIdentity, ModuleSource, MODULE_CONTROL_SCHEMA_VERSION,
};
use super::registry::{
    ArtifactInstallReceipt, ModuleRegistry, PendingArtifactInstall,
    PendingArtifactInstallResolution, RegisteredCapabilityBinding, RuntimeArtifactRegistration,
};
use crate::instance::ControlError;
use crate::state::paths::ShipctlPaths;

/// Stable repository errors that are safe to expose through the offline CLI.
pub const ARTIFACT_REPOSITORY_ARCHIVE_UNREADABLE: &str =
    "module.artifact.repository.archive_unreadable";
pub const ARTIFACT_REPOSITORY_ARCHIVE_UNSAFE: &str = "module.artifact.repository.archive_unsafe";
pub const ARTIFACT_REPOSITORY_STATE_UNREADABLE: &str =
    "module.artifact.repository.state_unreadable";
pub const ARTIFACT_REPOSITORY_LOCK_UNAVAILABLE: &str =
    "module.artifact.repository.lock_unavailable";
pub const ARTIFACT_REPOSITORY_STAGE_FAILED: &str = "module.artifact.repository.stage_failed";
pub const ARTIFACT_REPOSITORY_PUBLISH_FAILED: &str = "module.artifact.repository.publish_failed";
pub const ARTIFACT_REPOSITORY_PACK_FAILED: &str = "module.artifact.repository.pack_failed";
pub const ARTIFACT_REPOSITORY_MISSING: &str = "module.artifact.repository.missing";
pub const ARTIFACT_REPOSITORY_INCONSISTENT: &str = "module.artifact.repository.inconsistent";

const STAGING_DIRECTORY: &str = ".staging";
const REPOSITORY_LOCK_FILE: &str = ".module-artifact.lock";
const HOST_SUPPORTED_ARTIFACT_GRANTS: [&str; 20] = [
    "assistant.launch",
    "assistant.session-record",
    "credential.inspect",
    "credential.write",
    "terminal.start",
    "terminal.attach",
    "terminal.input",
    "terminal.resize",
    "semantic-terminal.attach",
    "semantic-terminal.input",
    "semantic-terminal.inspect",
    "usage-source.read",
    "usage-source.refresh",
    "usage-source.observe",
    "plugin-data.read",
    "plugin-data.write",
    "message.send.usage.refresh-request",
    "message.publish.usage.ingest-completed",
    "message.subscribe.usage.ingest-completed",
    "schedule.register",
];

/// A stable failure from the offline artifact repository.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactRepositoryError {
    pub code: String,
    pub message: String,
}

impl ArtifactRepositoryError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }

    pub fn into_control_error(self) -> ControlError {
        ControlError::new(self.code, self.message)
    }
}

impl std::fmt::Display for ArtifactRepositoryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ArtifactRepositoryError {}

impl From<ArtifactContractError> for ArtifactRepositoryError {
    fn from(error: ArtifactContractError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

impl From<super::registry::RegistryError> for ArtifactRepositoryError {
    fn from(error: super::registry::RegistryError) -> Self {
        Self {
            code: error.code.to_string(),
            message: error.message,
        }
    }
}

/// The repository boundary for one selected Shipctl state root.
///
/// `preflight_context` comes from trusted host policy, not from a candidate
/// archive.  In particular, accepted grants and native adapters are never
/// inferred from module-provided data.
pub struct ArtifactRepository {
    paths: ShipctlPaths,
    durable_writes: DurableWriteBarrier,
    preflight_context: ArtifactPreflightContext,
}

/// Provenance-free metadata that is safe to return from the offline public
/// boundary. The stored archive's raw provenance stays internal to trust
/// policy; it is intentionally not CLI output or artifact identity.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfflineArtifactMetadata {
    pub identity: ModuleIdentity,
    pub canonical: CanonicalArtifactMetadata,
    pub integrity: ArtifactIntegrityIndex,
}

impl OfflineArtifactMetadata {
    fn from_validated(artifact: &ValidatedRuntimeArtifact) -> Self {
        Self {
            identity: artifact.identity(),
            canonical: artifact.canonical_metadata(),
            integrity: artifact.integrity.clone(),
        }
    }
}

/// A successful preflight result. It is explicit that metadata validation did
/// not start a runtime or make a capability surface callable.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfflineArtifactPreflightReport {
    pub schema_version: u32,
    pub runtime_available: bool,
    pub callable: bool,
    pub artifact: OfflineArtifactMetadata,
}

/// A deterministic package result. It is explicit that packaging validates
/// declarations and bytes but does not load code or make a capability live.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfflineArtifactPackReport {
    pub schema_version: u32,
    pub source_directory: PathBuf,
    pub output_path: PathBuf,
    pub archive_digest_sha256: String,
    pub archive_size_bytes: u64,
    pub runtime_available: bool,
    pub callable: bool,
    pub artifact: OfflineArtifactMetadata,
}

/// Seal one staging directory into a byte-reproducible immutable artifact.
///
/// The staging directory supplies every declared file except `integrity.json`.
/// This function owns integrity generation, validates exact manifest closure,
/// and publishes the completed TAR atomically without replacing an output.
pub fn pack_artifact_directory(
    source_directory: &Path,
    output_path: &Path,
) -> Result<OfflineArtifactPackReport, ArtifactRepositoryError> {
    if output_path.exists() {
        return Err(ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_PACK_FAILED,
            format!("Artifact output {} already exists", output_path.display()),
        ));
    }

    let source_metadata = fs::symlink_metadata(source_directory).map_err(|error| {
        ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_PACK_FAILED,
            format!(
                "Could not inspect artifact staging directory {}: {error}",
                source_directory.display()
            ),
        )
    })?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
        return Err(ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_PACK_FAILED,
            format!(
                "Artifact staging path {} is not a directory",
                source_directory.display()
            ),
        ));
    }

    let mut files = BTreeMap::new();
    collect_artifact_directory(source_directory, source_directory, &mut files)?;
    if files.contains_key(ARTIFACT_INTEGRITY_PATH) {
        return Err(ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_PACK_FAILED,
            "Artifact staging directories must not supply integrity.json",
        ));
    }
    let manifest_bytes = files.get(ARTIFACT_MANIFEST_PATH).ok_or_else(|| {
        ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_PACK_FAILED,
            "Artifact staging directory does not contain module.yaml",
        )
    })?;
    let manifest: RuntimeArtifactManifest =
        serde_yaml::from_slice(manifest_bytes).map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_PACK_FAILED,
                format!("Artifact module.yaml cannot be decoded: {error}"),
            )
        })?;
    let integrity_files = files
        .iter()
        .map(|(path, contents)| ArtifactIntegrityFile {
            path: path.clone(),
            digest_sha256: sha256_hex(contents),
        })
        .collect::<Vec<_>>();
    let integrity = ArtifactIntegrityIndex {
        schema_version: manifest.schema_version,
        content_digest_sha256: canonical_content_digest(&manifest, &integrity_files)?,
        files: integrity_files,
    };
    files.insert(
        ARTIFACT_INTEGRITY_PATH.to_string(),
        serde_json::to_vec(&integrity).map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_PACK_FAILED,
                format!("Could not encode artifact integrity index: {error}"),
            )
        })?,
    );

    let archive = RuntimeArtifactArchive::new(files)?;
    let validated = archive.inspect()?;
    let archive_bytes = deterministic_tar_bytes(&archive)?;
    let archive_digest_sha256 = sha256_hex(&archive_bytes);
    let archive_size_bytes = archive_bytes.len() as u64;

    let output_parent = output_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent_metadata = fs::symlink_metadata(output_parent).map_err(|error| {
        ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_PACK_FAILED,
            format!(
                "Could not inspect artifact output directory {}: {error}",
                output_parent.display()
            ),
        )
    })?;
    if !parent_metadata.is_dir() {
        return Err(ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_PACK_FAILED,
            format!(
                "Artifact output parent {} is not a directory",
                output_parent.display()
            ),
        ));
    }

    let mut temporary = tempfile::NamedTempFile::new_in(output_parent).map_err(|error| {
        ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_PACK_FAILED,
            format!("Could not create temporary artifact output: {error}"),
        )
    })?;
    temporary.write_all(&archive_bytes).map_err(|error| {
        ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_PACK_FAILED,
            format!("Could not write temporary artifact output: {error}"),
        )
    })?;
    temporary.as_file().sync_all().map_err(|error| {
        ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_PACK_FAILED,
            format!("Could not sync temporary artifact output: {error}"),
        )
    })?;
    temporary.persist_noclobber(output_path).map_err(|error| {
        ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_PACK_FAILED,
            format!(
                "Could not publish artifact output {}: {}",
                output_path.display(),
                error.error
            ),
        )
    })?;
    sync_directory(output_parent).map_err(|error| {
        ArtifactRepositoryError::new(ARTIFACT_REPOSITORY_PACK_FAILED, error.message)
    })?;

    Ok(OfflineArtifactPackReport {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        source_directory: source_directory.to_path_buf(),
        output_path: output_path.to_path_buf(),
        archive_digest_sha256,
        archive_size_bytes,
        runtime_available: false,
        callable: false,
        artifact: OfflineArtifactMetadata::from_validated(&validated),
    })
}

/// A successful immutable publication and disabled registry registration.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfflineArtifactAddReport {
    pub schema_version: u32,
    pub runtime_available: bool,
    pub callable: bool,
    pub receipt: ArtifactInstallReceipt,
    pub artifact: OfflineArtifactMetadata,
}

/// Read-only inspection for runtime artifacts declared by one module ID.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfflineDisabledModuleInspection {
    pub schema_version: u32,
    pub module_id: String,
    pub registry_revision: u64,
    pub runtime_available: bool,
    pub callable: bool,
    pub artifacts: Vec<OfflineArtifactMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desired: Option<DesiredModuleState>,
}

/// Read-only inspection for one dynamically declared capability ID. The
/// definition and binding records are declarations, not live endpoints.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfflineCapabilityInspection {
    pub schema_version: u32,
    pub capability_id: String,
    pub registry_revision: u64,
    pub runtime_available: bool,
    pub callable: bool,
    pub definitions: Vec<CapabilityDefinition>,
    pub bindings: Vec<RegisteredCapabilityBinding>,
    pub declaring_artifacts: Vec<OfflineArtifactMetadata>,
}

impl ArtifactRepository {
    /// Construct an offline repository with the same declared frontend
    /// compatibility surface that the Tauri host supplies at activation.
    pub fn for_offline(paths: ShipctlPaths, host_api_version: impl Into<String>) -> Self {
        Self::for_host(paths, DurableWriteBarrier::default(), host_api_version)
    }

    /// Construct a host repository that participates in the caller's durable
    /// write barrier while using the public frontend compatibility catalog.
    pub fn for_host(
        paths: ShipctlPaths,
        durable_writes: DurableWriteBarrier,
        host_api_version: impl Into<String>,
    ) -> Self {
        let preflight_context = ArtifactPreflightContext {
            host_api_version: Some(host_api_version.into()),
            peer_versions: BTreeMap::from([
                ("react".to_string(), "19.2.8".to_string()),
                ("react-dom".to_string(), "19.2.8".to_string()),
            ]),
            service_versions: BTreeMap::from([
                ("shipctl.assistant-launch".to_string(), 1),
                ("shipctl.credential-store".to_string(), 1),
                ("shipctl.git".to_string(), 1),
                ("shipctl.plugin-data".to_string(), 1),
                ("shipctl.processes".to_string(), 1),
                ("shipctl.project-documents".to_string(), 1),
                ("shipctl.skill-installation".to_string(), 2),
                ("shipctl.semantic-terminals".to_string(), 1),
                ("shipctl.terminal-sessions".to_string(), 1),
                ("shipctl.usage-sources".to_string(), 2),
                ("shipctl.messages".to_string(), 1),
                ("shipctl.scheduler".to_string(), 1),
            ]),
            contribution_schema_versions: [
                "command",
                "global-navigation",
                "global-surface",
                "message-graph",
                "panel",
                "project-action",
                "project-facts",
                "project-import",
                "project-layout",
                "project-navigation",
                "scheduled-task",
                "settings",
                "sidebar",
                "skills-provider",
                "terminal-presentation",
            ]
            .into_iter()
            .map(|family| (family.to_string(), 1))
            .collect(),
            allowed_grants: HOST_SUPPORTED_ARTIFACT_GRANTS
                .into_iter()
                .map(str::to_string)
                .collect(),
            ..ArtifactPreflightContext::default()
        };
        Self::new(paths, durable_writes, preflight_context)
    }

    /// Construct a repository with an explicit durable-write barrier and
    /// trusted host preflight facts.
    pub fn new(
        paths: ShipctlPaths,
        durable_writes: DurableWriteBarrier,
        preflight_context: ArtifactPreflightContext,
    ) -> Self {
        Self {
            paths,
            durable_writes,
            preflight_context,
        }
    }

    pub fn paths(&self) -> &ShipctlPaths {
        &self.paths
    }

    /// Read and validate a candidate archive without creating state-root
    /// paths, publishing files, or mutating the registry.
    pub fn preflight_archive(
        &self,
        archive_path: &Path,
    ) -> Result<ValidatedRuntimeArtifact, ArtifactRepositoryError> {
        let archive = read_tar_archive(archive_path)?;
        let known_definitions = self.read_only_definition_index()?;
        let artifact = archive.preflight(&known_definitions)?;
        self.preflight_context.validate_requirements(&artifact)?;
        Ok(artifact)
    }

    /// Return the public provenance-free projection of a read-only preflight.
    pub fn preflight_report(
        &self,
        archive_path: &Path,
    ) -> Result<OfflineArtifactPreflightReport, ArtifactRepositoryError> {
        let artifact = self.preflight_archive(archive_path)?;
        Ok(OfflineArtifactPreflightReport {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            runtime_available: false,
            callable: false,
            artifact: OfflineArtifactMetadata::from_validated(&artifact),
        })
    }

    /// Add a user-provided archive with a private durable request identity.
    pub fn add_archive(
        &self,
        archive_path: &Path,
    ) -> Result<OfflineArtifactAddReport, ArtifactRepositoryError> {
        self.add_archive_with_request(archive_path, Uuid::new_v4(), ModuleSource::User)
    }

    /// Install a host-embedded artifact through the same validation and
    /// publication path as an external archive. The archive digest supplies a
    /// stable request identity, so repeated application starts are idempotent.
    pub fn ensure_bundled_archive(
        &self,
        archive_bytes: &[u8],
    ) -> Result<OfflineArtifactAddReport, ArtifactRepositoryError> {
        let mut archive = tempfile::NamedTempFile::new().map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_STAGE_FAILED,
                format!("Cannot create a temporary bundled artifact: {error}"),
            )
        })?;
        archive.write_all(archive_bytes).map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_STAGE_FAILED,
                format!("Cannot stage a bundled artifact: {error}"),
            )
        })?;
        archive.as_file().sync_all().map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_STAGE_FAILED,
                format!("Cannot sync a bundled artifact: {error}"),
            )
        })?;
        let archive_digest = sha256_hex(archive_bytes);
        let request_id = Uuid::new_v5(
            &Uuid::NAMESPACE_URL,
            format!("shipctl:bundled:{archive_digest}").as_bytes(),
        );
        self.add_archive_with_request(archive.path(), request_id, ModuleSource::Bundled)
    }

    /// Add an archive without activating it. The request identity makes the
    /// repository recovery-safe while the registry's pending intent bridges
    /// atomic filesystem publication and its SQLite transaction.
    fn add_archive_with_request(
        &self,
        archive_path: &Path,
        request_id: Uuid,
        source: ModuleSource,
    ) -> Result<OfflineArtifactAddReport, ArtifactRepositoryError> {
        // Validate before this method creates a state-root directory or opens
        // a writable registry. The second validation under the writer lease
        // below closes the catalog race.
        let candidate_archive = read_tar_archive(archive_path)?;
        let initial_definitions = self.read_only_definition_index()?;
        let initial_artifact = candidate_archive.preflight(&initial_definitions)?;
        self.preflight_context
            .validate_requirements(&initial_artifact)?;

        let _durable_update = self.durable_writes.enter_update().map_err(|error| {
            ArtifactRepositoryError::new(ARTIFACT_REPOSITORY_LOCK_UNAVAILABLE, error)
        })?;
        let _lease = ArtifactRepositoryLease::acquire(&self.paths.state_root)?;
        let mut registry = ModuleRegistry::open_writable(&self.paths)?;
        self.recover_pending_installs(&mut registry)?;

        let known_definitions = registry.capability_definition_index()?;
        let candidate = candidate_archive.preflight(&known_definitions)?;
        self.preflight_context.validate_requirements(&candidate)?;

        let receipt = match registry.pending_artifact_install(request_id)? {
            PendingArtifactInstallResolution::Installed(receipt) => {
                ensure_receipt_matches_candidate(&receipt, &candidate, source)?;
                let stored = self.read_published_artifact(&receipt.artifact)?;
                ensure_same_canonical_artifact(&stored, &candidate)?;
                receipt
            }
            PendingArtifactInstallResolution::Pending(intent) => {
                ensure_pending_matches_candidate(&intent, &candidate, source)?;
                self.resume_pending_install(
                    &mut registry,
                    intent,
                    Some((&candidate_archive, &candidate)),
                )?
                .ok_or_else(|| {
                    ArtifactRepositoryError::new(
                        ARTIFACT_REPOSITORY_INCONSISTENT,
                        "A caller-supplied candidate did not resolve its pending artifact install",
                    )
                })?
            }
            PendingArtifactInstallResolution::Absent => {
                let stage_id = Uuid::new_v4().to_string();
                let intent = PendingArtifactInstall {
                    schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                    request_id,
                    artifact: candidate.clone(),
                    source,
                    stage_id,
                };
                match registry.begin_pending_artifact_install(&intent)? {
                    PendingArtifactInstallResolution::Pending(intent) => self
                        .resume_pending_install(
                            &mut registry,
                            intent,
                            Some((&candidate_archive, &candidate)),
                        )?
                        .ok_or_else(|| {
                            ArtifactRepositoryError::new(
                                ARTIFACT_REPOSITORY_INCONSISTENT,
                                "A newly staged artifact did not resolve its pending install",
                            )
                        })?,
                    PendingArtifactInstallResolution::Installed(receipt) => {
                        // The pending intent was reconciled by another writer
                        // before this request acquired the catalog slot. No
                        // stage exists yet, so there is nothing to clean up.
                        ensure_receipt_matches_candidate(&receipt, &candidate, source)?;
                        let stored = self.read_published_artifact(&receipt.artifact)?;
                        ensure_same_canonical_artifact(&stored, &candidate)?;
                        receipt
                    }
                    PendingArtifactInstallResolution::Absent => {
                        return Err(ArtifactRepositoryError::new(
                            ARTIFACT_REPOSITORY_INCONSISTENT,
                            "Registry discarded a newly persisted artifact install intent",
                        ));
                    }
                }
            }
        };

        let stored = self.read_published_artifact(&receipt.artifact)?;
        ensure_same_canonical_artifact(&stored, &candidate)?;
        Ok(OfflineArtifactAddReport {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            runtime_available: false,
            callable: false,
            receipt,
            artifact: OfflineArtifactMetadata::from_validated(&stored),
        })
    }

    /// Inspect installed Phase 3 runtime artifacts for a module without
    /// constructing an active route or reading arbitrary directories.
    pub fn inspect_disabled_module(
        &self,
        module_id: &str,
    ) -> Result<OfflineDisabledModuleInspection, ArtifactRepositoryError> {
        let registry = ModuleRegistry::open_read_only(&self.paths)?;
        let snapshot = registry.snapshot()?;
        let mut artifacts = Vec::new();
        for entry in snapshot
            .runtime_artifacts
            .iter()
            .filter(|entry| entry.identity().id == module_id)
        {
            let stored = self.read_published_artifact(&entry.identity())?;
            ensure_same_canonical_artifact(&stored, &entry.artifact)?;
            artifacts.push(OfflineArtifactMetadata::from_validated(&stored));
        }
        if artifacts.is_empty() {
            return Err(ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_MISSING,
                format!("No disabled runtime artifact is registered for module {module_id}"),
            ));
        }
        artifacts.sort_by(|left, right| {
            left.identity
                .content_digest
                .cmp(&right.identity.content_digest)
        });

        Ok(OfflineDisabledModuleInspection {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            module_id: module_id.to_string(),
            registry_revision: snapshot.registry_revision,
            runtime_available: false,
            callable: false,
            artifacts,
            desired: snapshot.effective_desired(module_id),
        })
    }

    /// Inspect all installed definitions for a dynamic capability ID. It is
    /// deliberately an ID query rather than a provider selection mechanism.
    pub fn inspect_capability(
        &self,
        capability_id: &str,
    ) -> Result<OfflineCapabilityInspection, ArtifactRepositoryError> {
        let registry = ModuleRegistry::open_read_only(&self.paths)?;
        let snapshot = registry.snapshot()?;
        let mut definitions = snapshot
            .capability_catalog
            .definitions
            .clone()
            .into_iter()
            .filter(|definition| definition.id == capability_id)
            .collect::<Vec<_>>();
        definitions.sort_by(|left, right| left.version.cmp(&right.version));
        if definitions.is_empty() {
            return Err(ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_MISSING,
                format!("No installed dynamic capability definition matches {capability_id}"),
            ));
        }

        let references = definitions
            .iter()
            .map(CapabilityDefinition::reference)
            .collect::<Vec<_>>();
        let mut bindings = snapshot
            .capability_catalog
            .bindings
            .clone()
            .into_iter()
            .filter(|binding| {
                references
                    .iter()
                    .any(|reference| binding.capability() == reference)
            })
            .collect::<Vec<_>>();
        bindings.sort_by(|left, right| {
            left.capability()
                .cmp(right.capability())
                .then_with(|| {
                    left.artifact()
                        .content_digest
                        .cmp(&right.artifact().content_digest)
                })
                .then_with(|| format!("{:?}", left.role()).cmp(&format!("{:?}", right.role())))
        });

        let mut declaring_artifacts = Vec::new();
        for entry in snapshot.runtime_artifacts.iter().filter(|entry| {
            entry
                .artifact
                .manifest
                .capabilities
                .definitions
                .iter()
                .any(|definition| {
                    references
                        .iter()
                        .any(|reference| definition.reference() == *reference)
                })
        }) {
            let stored = self.read_published_artifact(&entry.identity())?;
            ensure_same_canonical_artifact(&stored, &entry.artifact)?;
            declaring_artifacts.push(OfflineArtifactMetadata::from_validated(&stored));
        }
        declaring_artifacts.sort_by(|left, right| {
            left.identity
                .content_digest
                .cmp(&right.identity.content_digest)
        });

        Ok(OfflineCapabilityInspection {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            capability_id: capability_id.to_string(),
            registry_revision: snapshot.registry_revision,
            runtime_available: false,
            callable: false,
            definitions,
            bindings,
            declaring_artifacts,
        })
    }

    fn read_only_definition_index(
        &self,
    ) -> Result<CapabilityDefinitionIndex, ArtifactRepositoryError> {
        if !self.paths.module_registry_database.exists() {
            return Ok(CapabilityDefinitionIndex::default());
        }
        let registry = ModuleRegistry::open_read_only(&self.paths)?;
        Ok(registry.capability_definition_index()?)
    }

    fn recover_pending_installs(
        &self,
        registry: &mut ModuleRegistry,
    ) -> Result<(), ArtifactRepositoryError> {
        for intent in registry.pending_artifact_installs()? {
            let _ = self.resume_pending_install(registry, intent, None)?;
        }
        Ok(())
    }

    /// Resume a crash-safe install intent. A missing payload with no candidate
    /// can only be an interrupted pre-publish stage, so the hidden intent is
    /// cleared. A malformed or mismatching payload is never silently adopted.
    fn resume_pending_install(
        &self,
        registry: &mut ModuleRegistry,
        intent: PendingArtifactInstall,
        candidate: Option<(&RuntimeArtifactArchive, &ValidatedRuntimeArtifact)>,
    ) -> Result<Option<ArtifactInstallReceipt>, ArtifactRepositoryError> {
        let identity = intent.artifact.identity();
        let destination = self.artifact_path(&identity)?;
        let stage = self.stage_path(&intent.stage_id)?;
        let definitions = registry.capability_definition_index()?;

        let stored = if destination.exists() {
            let stored = self.preflight_directory(&destination, &definitions)?;
            ensure_same_canonical_artifact(&stored, &intent.artifact)?;
            if stage.exists() {
                self.remove_stage(&intent.stage_id)?;
            }
            stored
        } else if stage.exists() {
            let staged = self.preflight_directory(&stage, &definitions)?;
            ensure_same_canonical_artifact(&staged, &intent.artifact)?;
            self.publish_stage(&intent.stage_id, &intent.artifact)?
        } else if let Some((archive, expected)) = candidate {
            ensure_same_canonical_artifact(expected, &intent.artifact)?;
            self.stage_candidate(&intent.stage_id, archive)?;
            self.publish_stage(&intent.stage_id, &intent.artifact)?
        } else {
            registry.clear_pending_artifact_install(intent.request_id)?;
            return Ok(None);
        };

        let registration = RuntimeArtifactRegistration {
            request_id: intent.request_id,
            artifact: stored,
            source: intent.source,
        };
        Ok(Some(
            registry.finalize_pending_disabled_artifact(&registration)?,
        ))
    }

    fn stage_candidate(
        &self,
        stage_id: &str,
        archive: &RuntimeArtifactArchive,
    ) -> Result<(), ArtifactRepositoryError> {
        let staging_root = self.staging_root();
        create_private_directory(&self.paths.module_artifact_root)?;
        create_private_directory(&staging_root)?;
        let stage = self.stage_path(stage_id)?;
        if stage.exists() {
            let existing = read_artifact_directory(&stage)?;
            let existing = existing.inspect()?;
            let expected = archive.inspect()?;
            ensure_same_canonical_artifact(&existing, &expected)?;
            return Ok(());
        }

        fs::create_dir(&stage).map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_STAGE_FAILED,
                format!(
                    "Could not create artifact staging directory {}: {error}",
                    stage.display()
                ),
            )
        })?;
        secure_directory(&stage)?;

        let write_result = (|| {
            for (portable_path, contents) in archive.files() {
                let target = safe_child_path(&stage, portable_path)?;
                let parent = target.parent().ok_or_else(|| {
                    ArtifactRepositoryError::new(
                        ARTIFACT_REPOSITORY_STAGE_FAILED,
                        "Runtime artifact staging target has no parent directory",
                    )
                })?;
                create_private_directory(parent)?;
                let mut target_file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)
                    .map_err(|error| {
                        ArtifactRepositoryError::new(
                            ARTIFACT_REPOSITORY_STAGE_FAILED,
                            format!(
                                "Could not stage runtime artifact entry {}: {error}",
                                portable_path
                            ),
                        )
                    })?;
                target_file.write_all(contents).map_err(|error| {
                    ArtifactRepositoryError::new(
                        ARTIFACT_REPOSITORY_STAGE_FAILED,
                        format!(
                            "Could not write staged runtime artifact entry {}: {error}",
                            portable_path
                        ),
                    )
                })?;
                target_file.sync_all().map_err(|error| {
                    ArtifactRepositoryError::new(
                        ARTIFACT_REPOSITORY_STAGE_FAILED,
                        format!(
                            "Could not durably stage runtime artifact entry {}: {error}",
                            portable_path
                        ),
                    )
                })?;
                secure_open_file(&target_file, &target)?;
            }
            sync_directory(&stage)?;
            sync_directory(&staging_root)?;
            let staged = read_artifact_directory(&stage)?.inspect()?;
            let expected = archive.inspect()?;
            ensure_same_canonical_artifact(&staged, &expected)
        })();
        if let Err(error) = write_result {
            let _ = self.remove_stage(stage_id);
            return Err(error);
        }
        Ok(())
    }

    fn publish_stage(
        &self,
        stage_id: &str,
        expected: &ValidatedRuntimeArtifact,
    ) -> Result<ValidatedRuntimeArtifact, ArtifactRepositoryError> {
        let stage = self.stage_path(stage_id)?;
        let destination = self.artifact_path(&expected.identity())?;
        let staging_root = self.staging_root();
        if !stage.exists() {
            return Err(ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_INCONSISTENT,
                format!(
                    "Pending artifact stage {} is missing before publication",
                    stage.display()
                ),
            ));
        }

        let staged = read_artifact_directory(&stage)?.inspect()?;
        ensure_same_canonical_artifact(&staged, expected)?;

        if destination.exists() {
            let stored = self.read_published_artifact(&expected.identity())?;
            ensure_same_canonical_artifact(&stored, expected)?;
            self.remove_stage(stage_id)?;
            return Ok(stored);
        }

        sync_directory(&stage)?;
        fs::rename(&stage, &destination).map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_PUBLISH_FAILED,
                format!(
                    "Could not atomically publish runtime artifact {}: {error}",
                    expected.identity().content_digest
                ),
            )
        })?;
        sync_directory(&self.paths.module_artifact_root)?;
        sync_directory(&staging_root)?;

        let stored = self.read_published_artifact(&expected.identity())?;
        ensure_same_canonical_artifact(&stored, expected)?;
        Ok(stored)
    }

    fn preflight_directory(
        &self,
        directory: &Path,
        definitions: &CapabilityDefinitionIndex,
    ) -> Result<ValidatedRuntimeArtifact, ArtifactRepositoryError> {
        let archive = read_artifact_directory(directory)?;
        let artifact = archive.preflight(definitions)?;
        self.preflight_context.validate_requirements(&artifact)?;
        Ok(artifact)
    }

    fn read_published_artifact(
        &self,
        identity: &ModuleIdentity,
    ) -> Result<ValidatedRuntimeArtifact, ArtifactRepositoryError> {
        let directory = self.artifact_path(identity)?;
        if !directory.exists() {
            return Err(ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_MISSING,
                format!(
                    "Published runtime artifact {} is missing from the selected state root",
                    identity.content_digest
                ),
            ));
        }
        let artifact = read_artifact_directory(&directory)?.inspect()?;
        if artifact.identity() != *identity {
            return Err(ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_INCONSISTENT,
                format!(
                    "Published runtime artifact {} does not match its registry identity",
                    directory.display()
                ),
            ));
        }
        Ok(artifact)
    }

    fn artifact_path(&self, identity: &ModuleIdentity) -> Result<PathBuf, ArtifactRepositoryError> {
        let digest = &identity.content_digest;
        if !is_sha256_digest(digest) {
            return Err(ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_INCONSISTENT,
                "Runtime artifact identity has an invalid content digest",
            ));
        }
        Ok(self.paths.module_artifact_root.join(digest))
    }

    fn staging_root(&self) -> PathBuf {
        self.paths.module_artifact_root.join(STAGING_DIRECTORY)
    }

    fn stage_path(&self, stage_id: &str) -> Result<PathBuf, ArtifactRepositoryError> {
        let parsed = Uuid::parse_str(stage_id).map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_INCONSISTENT,
                format!("Artifact staging identity is invalid: {error}"),
            )
        })?;
        Ok(self.staging_root().join(parsed.to_string()))
    }

    fn remove_stage(&self, stage_id: &str) -> Result<(), ArtifactRepositoryError> {
        let stage = self.stage_path(stage_id)?;
        if !stage.exists() {
            return Ok(());
        }
        let metadata = fs::symlink_metadata(&stage).map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_STAGE_FAILED,
                format!(
                    "Could not inspect artifact stage {}: {error}",
                    stage.display()
                ),
            )
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_INCONSISTENT,
                format!(
                    "Artifact stage {} is not a private directory",
                    stage.display()
                ),
            ));
        }
        fs::remove_dir_all(&stage).map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_STAGE_FAILED,
                format!(
                    "Could not remove resolved artifact stage {}: {error}",
                    stage.display()
                ),
            )
        })?;
        if self.staging_root().exists() {
            sync_directory(&self.staging_root())?;
        }
        Ok(())
    }
}

/// A process-wide writer lease for this state root's artifact store. SQLite
/// serializes registry transactions; this lock additionally covers the
/// filesystem portion of an offline add and its recovery intent.
#[derive(Debug)]
struct ArtifactRepositoryLease {
    _file: File,
}

impl ArtifactRepositoryLease {
    fn acquire(state_root: &Path) -> Result<Self, ArtifactRepositoryError> {
        fs::create_dir_all(state_root).map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_STATE_UNREADABLE,
                format!(
                    "Could not create selected state root {}: {error}",
                    state_root.display()
                ),
            )
        })?;
        let path = state_root.join(REPOSITORY_LOCK_FILE);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(ArtifactRepositoryError::new(
                    ARTIFACT_REPOSITORY_LOCK_UNAVAILABLE,
                    format!(
                        "Module artifact lease {} is not a regular file",
                        path.display()
                    ),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(ArtifactRepositoryError::new(
                    ARTIFACT_REPOSITORY_LOCK_UNAVAILABLE,
                    format!(
                        "Could not inspect module artifact lease {}: {error}",
                        path.display()
                    ),
                ));
            }
        }

        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;

            // The state root is selected by the caller, but the lock entry is
            // repository-owned. Never follow a substituted link or block on a
            // special file while acquiring that ownership boundary.
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = options.open(&path).map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_LOCK_UNAVAILABLE,
                format!(
                    "Could not open module artifact lease {}: {error}",
                    path.display()
                ),
            )
        })?;
        let metadata = file.metadata().map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_LOCK_UNAVAILABLE,
                format!(
                    "Could not inspect opened module artifact lease {}: {error}",
                    path.display()
                ),
            )
        })?;
        if !metadata.is_file() {
            return Err(ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_LOCK_UNAVAILABLE,
                format!(
                    "Module artifact lease {} is not a regular file",
                    path.display()
                ),
            ));
        }
        secure_open_file(&file, &path)?;
        file.lock().map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_LOCK_UNAVAILABLE,
                format!(
                    "Could not acquire module artifact lease {}: {error}",
                    path.display()
                ),
            )
        })?;
        Ok(Self { _file: file })
    }
}

fn ensure_same_canonical_artifact(
    actual: &ValidatedRuntimeArtifact,
    expected: &ValidatedRuntimeArtifact,
) -> Result<(), ArtifactRepositoryError> {
    if actual.identity() != expected.identity()
        || actual.canonical_metadata() != expected.canonical_metadata()
    {
        return Err(ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_INCONSISTENT,
            "Runtime artifact identity or provenance-free canonical metadata does not match",
        ));
    }
    Ok(())
}

fn ensure_pending_matches_candidate(
    pending: &PendingArtifactInstall,
    candidate: &ValidatedRuntimeArtifact,
    source: ModuleSource,
) -> Result<(), ArtifactRepositoryError> {
    if pending.source != source {
        return Err(ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_INCONSISTENT,
            "Pending artifact install source differs from the retry request",
        ));
    }
    ensure_same_canonical_artifact(&pending.artifact, candidate)
}

fn ensure_receipt_matches_candidate(
    receipt: &ArtifactInstallReceipt,
    candidate: &ValidatedRuntimeArtifact,
    source: ModuleSource,
) -> Result<(), ArtifactRepositoryError> {
    if receipt.source != source || receipt.artifact != candidate.identity() {
        return Err(ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_INCONSISTENT,
            "Artifact install request identity was previously used for different content or source",
        ));
    }
    Ok(())
}

/// Read only one known content-addressed or pending-stage directory. This
/// never walks `modules/` itself and rejects links, special files, and
/// undeclared entries when `RuntimeArtifactArchive::inspect` checks integrity.
pub(super) fn read_artifact_directory(
    directory: &Path,
) -> Result<RuntimeArtifactArchive, ArtifactRepositoryError> {
    let metadata = fs::symlink_metadata(directory).map_err(|error| {
        ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_STATE_UNREADABLE,
            format!(
                "Could not inspect runtime artifact directory {}: {error}",
                directory.display()
            ),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_INCONSISTENT,
            format!(
                "Runtime artifact path {} is not a directory",
                directory.display()
            ),
        ));
    }

    let mut files = BTreeMap::new();
    collect_artifact_directory(directory, directory, &mut files)?;
    RuntimeArtifactArchive::new(files).map_err(Into::into)
}

fn collect_artifact_directory(
    root: &Path,
    directory: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> Result<(), ArtifactRepositoryError> {
    for entry in fs::read_dir(directory).map_err(|error| {
        ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_STATE_UNREADABLE,
            format!(
                "Could not read runtime artifact directory {}: {error}",
                directory.display()
            ),
        )
    })? {
        let entry = entry.map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_STATE_UNREADABLE,
                format!("Could not enumerate runtime artifact entry: {error}"),
            )
        })?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_STATE_UNREADABLE,
                format!(
                    "Could not inspect runtime artifact entry {}: {error}",
                    path.display()
                ),
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_INCONSISTENT,
                format!(
                    "Runtime artifact entry {} must not be a link",
                    path.display()
                ),
            ));
        }
        if metadata.is_dir() {
            collect_artifact_directory(root, &path, files)?;
            continue;
        }
        if !metadata.is_file() {
            return Err(ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_INCONSISTENT,
                format!(
                    "Runtime artifact entry {} is not a regular file",
                    path.display()
                ),
            ));
        }
        let relative = path.strip_prefix(root).map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_INCONSISTENT,
                format!("Could not derive runtime artifact entry path: {error}"),
            )
        })?;
        let portable = portable_relative_path(relative)?;
        let contents = fs::read(&path).map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_STATE_UNREADABLE,
                format!("Could not read runtime artifact entry {portable}: {error}"),
            )
        })?;
        if files.insert(portable.clone(), contents).is_some() {
            return Err(ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_INCONSISTENT,
                format!("Runtime artifact directory contains duplicate entry {portable}"),
            ));
        }
    }
    Ok(())
}

fn safe_child_path(root: &Path, portable_path: &str) -> Result<PathBuf, ArtifactRepositoryError> {
    let canonical = portable_relative_path(Path::new(portable_path))?;
    if canonical != portable_path {
        return Err(ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_STAGE_FAILED,
            "Runtime artifact archive path is not in canonical portable form",
        ));
    }
    let path = root.join(Path::new(portable_path));
    if !path.starts_with(root) {
        return Err(ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_STAGE_FAILED,
            "Runtime artifact staging target escapes its isolated directory",
        ));
    }
    Ok(path)
}

fn create_private_directory(path: &Path) -> Result<(), ArtifactRepositoryError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(ArtifactRepositoryError::new(
                    ARTIFACT_REPOSITORY_STATE_UNREADABLE,
                    format!("Expected private directory at {}", path.display()),
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|error| {
                ArtifactRepositoryError::new(
                    ARTIFACT_REPOSITORY_STAGE_FAILED,
                    format!(
                        "Could not create private directory {}: {error}",
                        path.display()
                    ),
                )
            })?;
        }
        Err(error) => {
            return Err(ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_STATE_UNREADABLE,
                format!(
                    "Could not inspect private directory {}: {error}",
                    path.display()
                ),
            ));
        }
    }
    secure_directory(path)
}

fn secure_directory(path: &Path) -> Result<(), ArtifactRepositoryError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_STATE_UNREADABLE,
                format!("Could not secure directory {}: {error}", path.display()),
            )
        })?;
    }
    Ok(())
}

fn secure_open_file(file: &File, path: &Path) -> Result<(), ArtifactRepositoryError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| {
                ArtifactRepositoryError::new(
                    ARTIFACT_REPOSITORY_STATE_UNREADABLE,
                    format!("Could not secure file {}: {error}", path.display()),
                )
            })?;
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), ArtifactRepositoryError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_STATE_UNREADABLE,
                format!(
                    "Could not sync artifact directory {}: {error}",
                    path.display()
                ),
            )
        })
}

fn is_sha256_digest(value: &str) -> bool {
    value.len() == 64
        && value.bytes().all(|byte| {
            byte.is_ascii_digit() || (byte.is_ascii_lowercase() && byte.is_ascii_hexdigit())
        })
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn deterministic_tar_bytes(
    archive: &RuntimeArtifactArchive,
) -> Result<Vec<u8>, ArtifactRepositoryError> {
    let mut builder = tar::Builder::new(Vec::new());
    for (path, contents) in archive.files() {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_mode(0o600);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_size(contents.len() as u64);
        header.set_cksum();
        builder
            .append_data(&mut header, path, Cursor::new(contents))
            .map_err(|error| {
                ArtifactRepositoryError::new(
                    ARTIFACT_REPOSITORY_PACK_FAILED,
                    format!("Could not encode artifact entry {path}: {error}"),
                )
            })?;
    }
    builder.finish().map_err(|error| {
        ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_PACK_FAILED,
            format!("Could not finish artifact archive: {error}"),
        )
    })?;
    builder.into_inner().map_err(|error| {
        ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_PACK_FAILED,
            format!("Could not finalize artifact archive: {error}"),
        )
    })
}

/// Decode a TAR archive without extracting it to the filesystem.  Only
/// portable regular files are admitted; duplicate, non-UTF-8, absolute, and
/// traversal paths are rejected before a path can influence local storage.
fn read_tar_archive(path: &Path) -> Result<RuntimeArtifactArchive, ArtifactRepositoryError> {
    let source = File::open(path).map_err(|error| {
        ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_ARCHIVE_UNREADABLE,
            format!(
                "Could not open runtime artifact {}: {error}",
                path.display()
            ),
        )
    })?;
    let mut tar = tar::Archive::new(source);
    let entries = tar.entries().map_err(|error| {
        ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_ARCHIVE_UNSAFE,
            format!(
                "Could not enumerate runtime artifact {}: {error}",
                path.display()
            ),
        )
    })?;

    let mut files = BTreeMap::new();
    for entry in entries {
        let mut entry = entry.map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_ARCHIVE_UNSAFE,
                format!("Could not read runtime artifact entry: {error}"),
            )
        })?;
        if !entry.header().entry_type().is_file() {
            return Err(ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_ARCHIVE_UNSAFE,
                "Runtime artifacts may contain only regular files",
            ));
        }
        let entry_path = entry.path().map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_ARCHIVE_UNSAFE,
                format!("Runtime artifact entry path is invalid: {error}"),
            )
        })?;
        let portable_path = portable_relative_path(&entry_path)?;
        let mut contents = Vec::new();
        entry.read_to_end(&mut contents).map_err(|error| {
            ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_ARCHIVE_UNREADABLE,
                format!("Could not read runtime artifact entry {portable_path}: {error}"),
            )
        })?;
        if files.insert(portable_path.clone(), contents).is_some() {
            return Err(ArtifactRepositoryError::new(
                ARTIFACT_REPOSITORY_ARCHIVE_UNSAFE,
                format!("Runtime artifact contains duplicate entry {portable_path}"),
            ));
        }
    }

    RuntimeArtifactArchive::new(files).map_err(Into::into)
}

/// Convert a filesystem path to the canonical slash-separated archive path.
fn portable_relative_path(path: &Path) -> Result<String, ArtifactRepositoryError> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_ARCHIVE_UNSAFE,
            "Runtime artifact entry path must be non-empty and relative",
        ));
    }

    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_str().ok_or_else(|| {
                    ArtifactRepositoryError::new(
                        ARTIFACT_REPOSITORY_ARCHIVE_UNSAFE,
                        "Runtime artifact entry paths must be valid UTF-8",
                    )
                })?;
                if part.is_empty() || part == "." || part == ".." || part.contains('\\') {
                    return Err(ArtifactRepositoryError::new(
                        ARTIFACT_REPOSITORY_ARCHIVE_UNSAFE,
                        "Runtime artifact entry path is not portable",
                    ));
                }
                parts.push(part);
            }
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                return Err(ArtifactRepositoryError::new(
                    ARTIFACT_REPOSITORY_ARCHIVE_UNSAFE,
                    "Runtime artifact entry path must not escape its archive root",
                ));
            }
        }
    }
    if parts.is_empty() {
        return Err(ArtifactRepositoryError::new(
            ARTIFACT_REPOSITORY_ARCHIVE_UNSAFE,
            "Runtime artifact entry path must name a file",
        ));
    }
    Ok(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::io::Cursor;

    use serde_json::json;
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::message_bus::{
        CapabilityPortDeclaration, MessageDeclarations, MessageSchemaDescriptor,
        MessageTypeContract, MessageTypeId, MESSAGE_CONTRACT_SCHEMA_VERSION,
    };
    use crate::module_control::artifact::{
        canonical_content_digest, ArtifactIntegrityFile, CapabilityAgentAccess,
        CapabilityAgentWatchAccess, CapabilityDefinition, CapabilityManifest,
        CapabilityPortDefinition, CapabilityPortKind, CapabilityProviderBinding,
        CapabilityProviderCardinality, CapabilityProviderSelection, CapabilityScope,
        CapabilitySurfaceBinding, RuntimeArtifactManifest, ARTIFACT_CONTRACT_SCHEMA_VERSION,
        CAPABILITY_CONTRACT_SCHEMA_VERSION,
    };
    fn sha256_hex(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn message_contract(id: &str) -> MessageTypeContract {
        let path = format!("messages/{}.json", id.replace('.', "-"));
        MessageTypeContract {
            message: MessageTypeId {
                id: id.to_string(),
                version: 1,
            },
            schema: MessageSchemaDescriptor {
                draft: "https://json-schema.org/draft/2020-12/schema".to_string(),
                root: path.clone(),
                resources: BTreeMap::from([(
                    path.clone(),
                    json!({
                        "$schema": "https://json-schema.org/draft/2020-12/schema",
                        "$id": format!("shipctl-artifact:///{path}"),
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["value"],
                        "properties": {"value": {"type": "string"}}
                    }),
                )]),
                max_encoded_bytes: 256,
                redacted_fields: Vec::new(),
                compatible_versions: vec![1],
            },
        }
    }

    /// Build an admitted archive through the public artifact contract rather
    /// than fabricating a validated catalog record. The fixture declares a
    /// new capability and matching typed port, but no live route exists.
    fn fixture_archive() -> RuntimeArtifactArchive {
        fixture_archive_with_grants(&[])
    }

    fn fixture_archive_with_grants(requested_grants: &[&str]) -> RuntimeArtifactArchive {
        let module_id = "fixture.repository";
        let capability_id = "fixture.repository-capability";
        let request = message_contract("fixture.repository.request");
        let response = message_contract("fixture.repository.response");
        let port_id = "fixture.repository.port";
        let mut definition = CapabilityDefinition {
            id: capability_id.to_string(),
            version: "1.0.0".to_string(),
            definition_digest_sha256: String::new(),
            schemas: vec![request.clone(), response.clone()],
            ports: vec![CapabilityPortDefinition {
                id: port_id.to_string(),
                kind: CapabilityPortKind::Query,
                request: request.message.clone(),
                response: response.message.clone(),
            }],
            events: Vec::new(),
            topics: Vec::new(),
            streams: Vec::new(),
            provider_cardinality: CapabilityProviderCardinality::Multiple,
            selection: CapabilityProviderSelection::All,
            scopes: vec![CapabilityScope::Instance],
            agent_access: CapabilityAgentAccess {
                inspect: true,
                invoke: vec![port_id.to_string()],
                watch: CapabilityAgentWatchAccess {
                    events: Vec::new(),
                    topics: Vec::new(),
                },
                attach: Vec::new(),
            },
        };
        definition.definition_digest_sha256 = definition.calculated_digest_sha256().unwrap();
        let capabilities = CapabilityManifest {
            schema_version: CAPABILITY_CONTRACT_SCHEMA_VERSION,
            definitions: vec![definition.clone()],
            providers: vec![CapabilityProviderBinding {
                capability: definition.reference(),
                surfaces: CapabilitySurfaceBinding {
                    ports: vec![port_id.to_string()],
                    events: Vec::new(),
                    topics: Vec::new(),
                    streams: Vec::new(),
                },
                scopes: vec![CapabilityScope::Instance],
                priority: None,
            }],
            consumers: Vec::new(),
        };
        let messages = MessageDeclarations {
            schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
            provides: vec![request.clone(), response.clone()],
            handles: Vec::new(),
            publishes: Vec::new(),
            subscribes: Vec::new(),
            ports: vec![CapabilityPortDeclaration {
                id: port_id.to_string(),
                request: request.message.clone(),
                response: response.message.clone(),
                capacity: 8,
                required_grant: "message.request.fixture.repository.port".to_string(),
                scheduler_allowed: false,
            }],
        };
        let manifest_value = json!({
            "schemaVersion": ARTIFACT_CONTRACT_SCHEMA_VERSION,
            "id": module_id,
            "name": "Repository fixture",
            "version": "1.0.0",
            "apiRange": "^1.0.0",
            "runtimeKind": "frontend_esm",
            "entry": "dist/index.js",
            "styles": [],
            "assets": [],
            "messages": messages,
            "capabilities": capabilities,
            "application": {
                "schemaVersion": 1,
                "role": "headless",
                "requiredServices": [],
                "providedServices": [],
                "backgroundEffects": [],
                "contributions": []
            },
            "uiContributions": [],
            "requestedGrants": requested_grants,
            "nativeAdapters": [],
            "peerDependencies": {},
            "supportedScopes": ["instance"],
            "lifecycle": "live",
            "sourceProvenance": {"builder": "repository-test"}
        });
        let manifest: RuntimeArtifactManifest =
            serde_json::from_value(manifest_value.clone()).unwrap();
        let mut files = BTreeMap::from([
            (
                "dist/index.js".to_string(),
                b"export const offline = true;".to_vec(),
            ),
            (
                "module.yaml".to_string(),
                serde_yaml::to_string(&manifest_value).unwrap().into_bytes(),
            ),
        ]);
        for contract in [&request, &response] {
            for (path, schema) in &contract.schema.resources {
                files.insert(path.clone(), serde_json::to_vec(schema).unwrap());
            }
        }
        files.insert(
            format!("capabilities/{}.json", definition.id),
            serde_json::to_vec(&definition).unwrap(),
        );
        let integrity_files = files
            .iter()
            .map(|(path, contents)| ArtifactIntegrityFile {
                path: path.clone(),
                digest_sha256: sha256_hex(contents),
            })
            .collect::<Vec<_>>();
        let integrity = ArtifactIntegrityIndex {
            schema_version: ARTIFACT_CONTRACT_SCHEMA_VERSION,
            content_digest_sha256: canonical_content_digest(&manifest, &integrity_files).unwrap(),
            files: integrity_files,
        };
        files.insert(
            "integrity.json".to_string(),
            serde_json::to_vec(&integrity).unwrap(),
        );
        RuntimeArtifactArchive::new(files).unwrap()
    }

    fn write_archive(archive: &RuntimeArtifactArchive) -> tempfile::NamedTempFile {
        let file = tempfile::NamedTempFile::new().unwrap();
        let writer = file.reopen().unwrap();
        let mut builder = tar::Builder::new(writer);
        for (path, contents) in archive.files() {
            let mut header = tar::Header::new_gnu();
            header.set_mode(0o600);
            header.set_size(contents.len() as u64);
            builder
                .append_data(&mut header, path, Cursor::new(contents))
                .unwrap();
        }
        builder.into_inner().unwrap().sync_all().unwrap();
        file
    }

    fn write_staging_directory(directory: &Path, archive: &RuntimeArtifactArchive) {
        fs::create_dir_all(directory).unwrap();
        for (path, contents) in archive.files() {
            if path == ARTIFACT_INTEGRITY_PATH {
                continue;
            }
            let target = directory.join(path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, contents).unwrap();
        }
    }

    #[test]
    fn packer_seals_the_exact_closure_deterministically() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let first_output = temporary.path().join("first.shipctl-module");
        let second_output = temporary.path().join("second.shipctl-module");
        let fixture = fixture_archive();
        write_staging_directory(&source, &fixture);

        let first = pack_artifact_directory(&source, &first_output).unwrap();
        let second = pack_artifact_directory(&source, &second_output).unwrap();

        assert_eq!(
            fs::read(&first_output).unwrap(),
            fs::read(&second_output).unwrap()
        );
        assert_eq!(first.archive_digest_sha256, second.archive_digest_sha256);
        assert_eq!(first.artifact, second.artifact);
        assert_eq!(
            first.artifact.identity,
            fixture.inspect().unwrap().identity()
        );
        assert!(!first.runtime_available);
        assert!(!first.callable);
        assert_eq!(
            read_tar_archive(&first_output)
                .unwrap()
                .inspect()
                .unwrap()
                .identity(),
            first.artifact.identity
        );

        let error = pack_artifact_directory(&source, &first_output).unwrap_err();
        assert_eq!(error.code, ARTIFACT_REPOSITORY_PACK_FAILED);
    }

    #[test]
    fn packer_rejects_builder_owned_or_undeclared_content_without_output() {
        let temporary = tempfile::tempdir().unwrap();
        let fixture = fixture_archive();

        let indexed_source = temporary.path().join("indexed");
        let indexed_output = temporary.path().join("indexed.shipctl-module");
        write_staging_directory(&indexed_source, &fixture);
        fs::write(
            indexed_source.join(ARTIFACT_INTEGRITY_PATH),
            fixture.files().get(ARTIFACT_INTEGRITY_PATH).unwrap(),
        )
        .unwrap();
        let error = pack_artifact_directory(&indexed_source, &indexed_output).unwrap_err();
        assert_eq!(error.code, ARTIFACT_REPOSITORY_PACK_FAILED);
        assert!(!indexed_output.exists());

        let extra_source = temporary.path().join("extra");
        let extra_output = temporary.path().join("extra.shipctl-module");
        write_staging_directory(&extra_source, &fixture);
        fs::write(extra_source.join("undeclared.txt"), b"not in module.yaml").unwrap();
        let error = pack_artifact_directory(&extra_source, &extra_output).unwrap_err();
        assert_eq!(
            error.code,
            crate::module_control::artifact::ARTIFACT_MANIFEST_INVALID
        );
        assert!(!extra_output.exists());
    }

    #[cfg(unix)]
    #[test]
    fn packer_rejects_links_without_output() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let output = temporary.path().join("linked.shipctl-module");
        write_staging_directory(&source, &fixture_archive());
        symlink(source.join("dist/index.js"), source.join("linked.js")).unwrap();

        let error = pack_artifact_directory(&source, &output).unwrap_err();
        assert_eq!(error.code, ARTIFACT_REPOSITORY_INCONSISTENT);
        assert!(!output.exists());
    }

    fn tar_with_entry(path: &str, entry_type: tar::EntryType) -> tempfile::NamedTempFile {
        let file = tempfile::NamedTempFile::new().unwrap();
        let writer = file.reopen().unwrap();
        let mut builder = tar::Builder::new(writer);
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(entry_type);
        header.set_mode(0o600);
        header.set_size(1);
        header.set_path("entry").unwrap();
        // `tar` quite properly refuses to produce traversal names through its
        // safe path setter. Mutate the wire header after a valid setup so this
        // test exercises our decoder against an archive supplied by another
        // producer.
        let name = path.as_bytes();
        assert!(name.len() < 100);
        header.as_mut_bytes()[..100].fill(0);
        header.as_mut_bytes()[..name.len()].copy_from_slice(name);
        header.set_cksum();
        builder.append(&header, Cursor::new(b"x")).unwrap();
        builder.into_inner().unwrap().sync_all().unwrap();
        file
    }

    #[test]
    fn tar_decoder_rejects_traversal_before_any_state_root_write() {
        let temporary = tempfile::tempdir().unwrap();
        let paths = ShipctlPaths::new(
            temporary.path().join("state"),
            temporary.path().join("runtime"),
        );
        let repository = ArtifactRepository::for_offline(paths.clone(), "1.0.0");
        let source = tar_with_entry("../escape", tar::EntryType::Regular);
        let error = repository.preflight_report(source.path()).unwrap_err();
        assert_eq!(error.code, ARTIFACT_REPOSITORY_ARCHIVE_UNSAFE);
        assert!(!paths.state_root.exists());
        assert!(!paths.runtime_root.exists());
    }

    #[test]
    fn tar_decoder_rejects_non_regular_entries() {
        let source = tar_with_entry("module.yaml", tar::EntryType::Symlink);
        let error = read_tar_archive(source.path()).unwrap_err();
        assert_eq!(error.code, ARTIFACT_REPOSITORY_ARCHIVE_UNSAFE);
    }

    #[test]
    fn portable_paths_reject_platform_escape_spellings() {
        for value in [
            Path::new("/absolute"),
            Path::new("../escape"),
            Path::new("./current"),
            Path::new("folder\\escape"),
        ] {
            assert!(portable_relative_path(value).is_err(), "{value:?}");
        }
        assert_eq!(
            portable_relative_path(Path::new("assets/icon.svg")).unwrap(),
            "assets/icon.svg"
        );
    }

    #[test]
    fn repository_preflights_publishes_and_inspects_a_disabled_capability() {
        let temporary = tempfile::tempdir().unwrap();
        let paths = ShipctlPaths::new(
            temporary.path().join("state"),
            temporary.path().join("runtime"),
        );
        let repository = ArtifactRepository::for_offline(paths.clone(), "1.0.0");
        let archive = write_archive(&fixture_archive());

        let preflight = repository.preflight_report(archive.path()).unwrap();
        assert!(!preflight.runtime_available);
        assert!(!preflight.callable);
        assert!(!paths.state_root.exists());
        assert!(!paths.runtime_root.exists());

        let added = repository.add_archive(archive.path()).unwrap();
        assert!(!added.runtime_available);
        assert!(!added.callable);
        assert!(added.receipt.changed);
        assert!(added.receipt.selected_by_install);
        assert!(!added.receipt.desired.as_ref().unwrap().enabled);
        assert_eq!(added.artifact, preflight.artifact);
        assert!(paths
            .module_artifact_root
            .join(&added.artifact.identity.content_digest)
            .is_dir());
        assert!(!paths.runtime_root.exists());
        assert!(!paths.module_control_evidence_root.exists());

        let module = repository
            .inspect_disabled_module("fixture.repository")
            .unwrap();
        assert!(!module.runtime_available);
        assert!(!module.callable);
        assert_eq!(module.artifacts, vec![added.artifact.clone()]);
        assert!(!module.desired.unwrap().enabled);

        let capability = repository
            .inspect_capability("fixture.repository-capability")
            .unwrap();
        assert!(!capability.runtime_available);
        assert!(!capability.callable);
        assert_eq!(capability.definitions.len(), 1);
        assert_eq!(capability.bindings.len(), 1);
        assert_eq!(capability.declaring_artifacts, vec![added.artifact.clone()]);
        assert!(!serde_json::to_string(&capability)
            .unwrap()
            .contains("sourceProvenance"));

        let repeated = repository.add_archive(archive.path()).unwrap();
        assert!(!repeated.receipt.changed);
        assert_eq!(repeated.artifact, added.artifact);
        let published = fs::read_dir(&paths.module_artifact_root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name != STAGING_DIRECTORY)
            .collect::<Vec<_>>();
        assert_eq!(published, vec![added.artifact.identity.content_digest]);
        assert_eq!(
            fs::read_dir(paths.module_artifact_root.join(STAGING_DIRECTORY))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn host_preflight_approves_only_its_supported_artifact_grants() {
        let temporary = tempfile::tempdir().unwrap();
        let paths = ShipctlPaths::new(
            temporary.path().join("state"),
            temporary.path().join("runtime"),
        );
        let repository = ArtifactRepository::for_offline(paths, "1.0.0");

        for grant in HOST_SUPPORTED_ARTIFACT_GRANTS {
            let archive = write_archive(&fixture_archive_with_grants(&[grant]));
            assert!(
                repository.preflight_report(archive.path()).is_ok(),
                "{grant}"
            );
        }

        let archive = write_archive(&fixture_archive_with_grants(&["terminal.unknown"]));
        assert_eq!(
            repository
                .preflight_report(archive.path())
                .unwrap_err()
                .code,
            crate::module_control::artifact::ARTIFACT_GRANT_DENIED
        );
    }

    #[cfg(unix)]
    #[test]
    fn repository_lease_rejects_a_substituted_link() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let state_root = temporary.path().join("state");
        fs::create_dir_all(&state_root).unwrap();
        let target = temporary.path().join("outside-lock");
        File::create(&target).unwrap();
        symlink(&target, state_root.join(REPOSITORY_LOCK_FILE)).unwrap();

        let error = ArtifactRepositoryLease::acquire(&state_root).unwrap_err();
        assert_eq!(error.code, ARTIFACT_REPOSITORY_LOCK_UNAVAILABLE);
        assert_eq!(fs::read(&target).unwrap(), Vec::<u8>::new());
    }
}
