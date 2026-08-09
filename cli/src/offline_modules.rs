use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use shipctl_core::instance::{
    resolve_state_root, resolve_state_root_read_only, ControlError, RootSource,
};
use shipctl_core::module_control::codes::{
    INVALID_OFFLINE_RESPONSE, MODULE_ABSENT, REGISTRY_DIAGNOSTICS_FAILED, REGISTRY_HEALTHY,
    REGISTRY_INVENTORY_ABSENT, REGISTRY_STATE_ROOT_INVALID, RUNTIME_OFFLINE,
    SCHEMA_VERSION_UNSUPPORTED, VERIFICATION_EXPECTATION_MODULE_MISMATCH,
    VERIFICATION_EXPECTATION_UNREADABLE, VERIFICATION_MATCHED, VERIFICATION_MISMATCH,
};
use shipctl_core::module_control::registry::{
    diagnose_registry, ModuleRegistry, RegisteredArtifact, RegistryError, RegistrySnapshot,
    StaticModuleRecord,
};
use shipctl_core::module_control::repository::{
    ArtifactRepository, OfflineArtifactAddReport, OfflineArtifactPreflightReport,
    OfflineCapabilityInspection, OfflineDisabledModuleInspection, ARTIFACT_REPOSITORY_MISSING,
};
use shipctl_core::module_control::{
    parse_contract_json, DesiredModuleState, Diagnostic, DiagnosticSeverity, ModuleContract,
    ModuleContractError, ModuleInspection, ModuleRuntimeKind, ObservedModuleState,
    RedactedEvidence, VerificationExpectation, VerificationObserved, VerificationResult,
    MODULE_CONTROL_SCHEMA_VERSION,
};
use shipctl_core::state::paths::ShipctlPaths;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfflineModuleSummary {
    pub module_id: String,
    pub runtime_kinds: Vec<ModuleRuntimeKind>,
    pub static_builtin: bool,
    pub desired_state_count: usize,
    pub last_reported_observation_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfflineModuleList {
    pub schema_version: u32,
    pub registry_revision: u64,
    pub state_root: PathBuf,
    pub state_root_source: RootSource,
    pub registry_path: PathBuf,
    pub runtime_available: bool,
    pub count: usize,
    pub modules: Vec<OfflineModuleSummary>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfflineModuleInspection {
    pub schema_version: u32,
    pub module_id: String,
    pub registry_revision: u64,
    pub state_root: PathBuf,
    pub state_root_source: RootSource,
    pub registry_path: PathBuf,
    pub runtime_available: bool,
    pub artifacts: Vec<RegisteredArtifact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub static_inventory: Option<StaticModuleRecord>,
    pub desired: Vec<DesiredModuleState>,
    pub last_reported_observations: Vec<ObservedModuleState>,
    pub diagnostics: Vec<Diagnostic>,
}

/// Offline module inspection is either a provenance-safe Phase 3 artifact
/// report or the legacy static-build inventory projection. Dynamic artifacts
/// never fall back to the registry's legacy artifact records.
#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum OfflineModuleInspectReport {
    DisabledArtifact(OfflineDisabledModuleInspection),
    StaticBuiltin(OfflineModuleInspection),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfflineDiagnosticReport {
    pub schema_version: u32,
    pub state_root: PathBuf,
    pub state_root_source: RootSource,
    pub registry_path: PathBuf,
    pub registry_revision: Option<u64>,
    pub static_build_provenance: Option<String>,
    pub runtime_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module: Option<OfflineModuleInspection>,
    pub healthy: bool,
    pub diagnostics: Vec<Diagnostic>,
}

impl ModuleContract for OfflineModuleList {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn validate(&self) -> Result<(), ModuleContractError> {
        validate_schema_version(self.schema_version)?;
        require_offline(self.runtime_available)?;
        if self.count != self.modules.len() {
            return Err(offline_invalid(format!(
                "Offline module count {} does not match {} module summaries",
                self.count,
                self.modules.len()
            )));
        }
        let mut module_ids = BTreeSet::new();
        for module in &self.modules {
            if module.module_id.trim().is_empty() {
                return Err(offline_invalid("Offline module id cannot be empty"));
            }
            if !module_ids.insert(module.module_id.as_str()) {
                return Err(offline_invalid(format!(
                    "Offline module {} appears more than once",
                    module.module_id
                )));
            }
            if module.desired_state_count > 1 {
                return Err(offline_invalid(format!(
                    "Offline module {} has more than one state-root desired state",
                    module.module_id
                )));
            }
        }
        validate_diagnostics(&self.diagnostics)
    }
}

impl ModuleContract for OfflineModuleInspection {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn validate(&self) -> Result<(), ModuleContractError> {
        validate_schema_version(self.schema_version)?;
        require_offline(self.runtime_available)?;
        if self.module_id.trim().is_empty() {
            return Err(offline_invalid("Offline module id cannot be empty"));
        }
        if self.desired.len() > 1 {
            return Err(offline_invalid(format!(
                "Offline module {} has more than one state-root desired state",
                self.module_id
            )));
        }
        for artifact in &self.artifacts {
            artifact.identity.validate()?;
            require_matching_module(&self.module_id, &artifact.identity.id, "artifact")?;
            if artifact.sources.is_empty() {
                return Err(offline_invalid(format!(
                    "Offline artifact {} has no recorded source",
                    artifact.identity.content_digest
                )));
            }
        }
        if let Some(record) = &self.static_inventory {
            record.identity.validate()?;
            require_matching_module(&self.module_id, &record.identity.id, "static inventory")?;
        }
        for desired in &self.desired {
            desired.validate()?;
            require_matching_module(&self.module_id, &desired.module_id, "desired state")?;
        }
        for observed in &self.last_reported_observations {
            observed.validate()?;
            require_matching_module(&self.module_id, &observed.module_id, "observation")?;
        }
        validate_diagnostics(&self.diagnostics)
    }
}

impl ModuleContract for OfflineDiagnosticReport {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn validate(&self) -> Result<(), ModuleContractError> {
        validate_schema_version(self.schema_version)?;
        require_offline(self.runtime_available)?;
        if let Some(module) = &self.module {
            module.validate()?;
            if self.registry_revision.is_none() {
                return Err(offline_invalid(
                    "Offline module inspection requires a registry revision",
                ));
            }
        }
        validate_diagnostics(&self.diagnostics)?;
        let computed_healthy = self
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.severity != DiagnosticSeverity::Error);
        if self.healthy != computed_healthy {
            return Err(offline_invalid(
                "Offline diagnostic healthy flag disagrees with diagnostic severity",
            ));
        }
        Ok(())
    }
}

struct OfflineSnapshot {
    state_root: PathBuf,
    state_root_source: RootSource,
    snapshot: RegistrySnapshot,
}

fn checked<T: ModuleContract>(value: T) -> Result<T, ControlError> {
    value
        .validate()
        .map_err(|error| ControlError::new(error.code, error.message))?;
    Ok(value)
}

fn validate_schema_version(schema_version: u32) -> Result<(), ModuleContractError> {
    if schema_version == MODULE_CONTROL_SCHEMA_VERSION {
        Ok(())
    } else {
        Err(ModuleContractError::new(
            SCHEMA_VERSION_UNSUPPORTED,
            format!(
                "Offline response schemaVersion {schema_version} is unsupported; expected {MODULE_CONTROL_SCHEMA_VERSION}"
            ),
        ))
    }
}

fn require_offline(runtime_available: bool) -> Result<(), ModuleContractError> {
    if runtime_available {
        Err(offline_invalid(
            "Offline response cannot claim that runtime evidence is available",
        ))
    } else {
        Ok(())
    }
}

fn require_matching_module(
    expected: &str,
    observed: &str,
    record_kind: &str,
) -> Result<(), ModuleContractError> {
    if expected == observed {
        Ok(())
    } else {
        Err(offline_invalid(format!(
            "Offline {record_kind} module {observed} does not match requested module {expected}"
        )))
    }
}

fn validate_diagnostics(diagnostics: &[Diagnostic]) -> Result<(), ModuleContractError> {
    for diagnostic in diagnostics {
        diagnostic.validate()?;
    }
    Ok(())
}

fn offline_invalid(message: impl Into<String>) -> ModuleContractError {
    ModuleContractError::new(INVALID_OFFLINE_RESPONSE, message)
}

pub fn list(state_root: Option<&Path>) -> Result<OfflineModuleList, ControlError> {
    let offline = read_snapshot(state_root)?;
    let module_ids = module_ids(&offline.snapshot);
    let modules = module_ids
        .into_iter()
        .map(|module_id| summary(&offline.snapshot, module_id))
        .collect::<Vec<_>>();
    checked(OfflineModuleList {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        registry_revision: offline.snapshot.registry_revision,
        state_root: offline.state_root.clone(),
        state_root_source: offline.state_root_source.clone(),
        registry_path: offline.snapshot.registry_path.clone(),
        runtime_available: false,
        count: modules.len(),
        modules,
        diagnostics: vec![runtime_unavailable(&offline.state_root)],
    })
}

/// Validate an archive through the disabled-artifact repository without
/// creating the selected state root or making any durable change.
pub fn preflight(
    state_root: Option<&Path>,
    archive: &Path,
) -> Result<OfflineArtifactPreflightReport, ControlError> {
    read_only_artifact_repository(state_root)?
        .preflight_report(archive)
        .map_err(|error| error.into_control_error())
}

/// Publish a validated archive and register it disabled through the sole
/// artifact repository write path.
pub fn add(
    state_root: Option<&Path>,
    archive: &Path,
) -> Result<OfflineArtifactAddReport, ControlError> {
    writable_artifact_repository(state_root)?
        .add_archive(archive)
        .map_err(|error| error.into_control_error())
}

pub fn inspect(
    state_root: Option<&Path>,
    module_id: &str,
) -> Result<OfflineModuleInspectReport, ControlError> {
    let repository = read_only_artifact_repository(state_root)?;
    match repository.inspect_disabled_module(module_id) {
        Ok(report) => Ok(OfflineModuleInspectReport::DisabledArtifact(report)),
        Err(error) if error.code == ARTIFACT_REPOSITORY_MISSING => {
            let offline = read_snapshot(state_root)?;
            let static_builtin = static_builtin_inspection(&offline, module_id)
                .map(checked)
                .transpose()?
                .map(OfflineModuleInspectReport::StaticBuiltin);
            static_builtin.ok_or_else(|| error.into_control_error())
        }
        Err(error) => Err(error.into_control_error()),
    }
}

/// Inspect one declared dynamic capability without selecting or activating a
/// provider.
pub fn inspect_capability(
    state_root: Option<&Path>,
    capability_id: &str,
) -> Result<OfflineCapabilityInspection, ControlError> {
    read_only_artifact_repository(state_root)?
        .inspect_capability(capability_id)
        .map_err(|error| error.into_control_error())
}

fn read_only_artifact_repository(
    state_root: Option<&Path>,
) -> Result<ArtifactRepository, ControlError> {
    let (state_root, _) = resolve_state_root_read_only(state_root)
        .map_err(|error| ControlError::new(REGISTRY_STATE_ROOT_INVALID, error))?;
    Ok(artifact_repository(state_root))
}

fn writable_artifact_repository(
    state_root: Option<&Path>,
) -> Result<ArtifactRepository, ControlError> {
    let (state_root, _) = resolve_state_root(state_root)
        .map_err(|error| ControlError::new(REGISTRY_STATE_ROOT_INVALID, error))?;
    Ok(artifact_repository(state_root))
}

fn artifact_repository(state_root: PathBuf) -> ArtifactRepository {
    ArtifactRepository::for_offline(
        ShipctlPaths::new(state_root, PathBuf::new()),
        crate::APP_VERSION,
    )
}

fn static_builtin_inspection(
    offline: &OfflineSnapshot,
    module_id: &str,
) -> Option<OfflineModuleInspection> {
    let static_inventory = offline
        .snapshot
        .static_inventory
        .iter()
        .find(|record| record.identity.id == module_id)
        .cloned()?;
    Some(OfflineModuleInspection {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        module_id: module_id.to_string(),
        registry_revision: offline.snapshot.registry_revision,
        state_root: offline.state_root.clone(),
        state_root_source: offline.state_root_source.clone(),
        registry_path: offline.snapshot.registry_path.clone(),
        runtime_available: false,
        artifacts: Vec::new(),
        static_inventory: Some(static_inventory),
        desired: offline
            .snapshot
            .effective_desired(module_id)
            .into_iter()
            .collect(),
        last_reported_observations: Vec::new(),
        diagnostics: vec![runtime_unavailable(&offline.state_root)],
    })
}

pub fn inspection_code(report: &OfflineModuleInspectReport) -> &'static str {
    match report {
        OfflineModuleInspectReport::DisabledArtifact(_) => {
            shipctl_core::module_control::ARTIFACT_DISABLED_INSPECTED
        }
        OfflineModuleInspectReport::StaticBuiltin(_) => {
            shipctl_core::module_control::REGISTRY_INSPECTED
        }
    }
}

pub fn diagnose(
    state_root: Option<&Path>,
    module_id: Option<&str>,
) -> Result<OfflineDiagnosticReport, ControlError> {
    let (state_root, state_root_source) = resolve_state_root_read_only(state_root)
        .map_err(|error| ControlError::new(REGISTRY_STATE_ROOT_INVALID, error))?;
    let paths = ShipctlPaths::new(state_root.clone(), PathBuf::new());
    let mut diagnostics = diagnose_registry(&paths.module_registry_database);
    let snapshot = ModuleRegistry::open_read_only(&paths)
        .and_then(|registry| registry.snapshot())
        .ok();
    let module = module_id.and_then(|module_id| {
        snapshot.as_ref().and_then(|snapshot| {
            inspection(
                &OfflineSnapshot {
                    state_root: state_root.clone(),
                    state_root_source: state_root_source.clone(),
                    snapshot: snapshot.clone(),
                },
                module_id,
            )
        })
    });

    if let Some(module_id) = module_id {
        if snapshot.is_some() && module.is_none() {
            diagnostics.push(module_absent(module_id, &state_root));
        }
    }
    if snapshot
        .as_ref()
        .is_some_and(|snapshot| snapshot.static_build_provenance.is_none())
    {
        diagnostics.push(static_inventory_absent(&paths.module_registry_database));
    }
    diagnostics.push(runtime_unavailable(&state_root));
    let healthy = diagnostics
        .iter()
        .all(|diagnostic| diagnostic.severity != DiagnosticSeverity::Error);

    checked(OfflineDiagnosticReport {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        state_root,
        state_root_source,
        registry_path: paths.module_registry_database,
        registry_revision: snapshot.as_ref().map(|snapshot| snapshot.registry_revision),
        static_build_provenance: snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.static_build_provenance.clone()),
        runtime_available: false,
        module,
        healthy,
        diagnostics,
    })
}

pub fn verify(
    state_root: Option<&Path>,
    module_id: &str,
    expectation_path: &Path,
) -> Result<VerificationResult, ControlError> {
    let source = fs::read_to_string(expectation_path).map_err(|error| {
        ControlError::new(
            VERIFICATION_EXPECTATION_UNREADABLE,
            format!(
                "Could not read expectation {}: {error}",
                expectation_path.display()
            ),
        )
    })?;
    let expected: VerificationExpectation = parse_contract_json(&source)
        .map_err(|error| ControlError::new(error.code, error.message))?;
    if expected.module_id != module_id {
        return Err(ControlError::new(
            VERIFICATION_EXPECTATION_MODULE_MISMATCH,
            "Expectation moduleId differs from the requested module",
        )
        .with_selector(module_id)
        .with_expected_observed(module_id, expected.module_id));
    }

    let offline = read_snapshot(state_root)?;
    let record = inspection(&offline, module_id).ok_or_else(|| {
        ControlError::new(
            MODULE_ABSENT,
            format!("Module {module_id} is absent from the selected registry"),
        )
        .with_selector(module_id)
    })?;
    record
        .validate()
        .map_err(|error| ControlError::new(error.code, error.message))?;
    let desired = record.desired.first().cloned();
    let manifest = desired
        .as_ref()
        .and_then(|desired| desired.selected_artifact.clone())
        .or_else(|| {
            record
                .static_inventory
                .as_ref()
                .map(|record| record.identity.clone())
        })
        .or_else(|| {
            record
                .artifacts
                .first()
                .map(|artifact| artifact.identity.clone())
        });
    let observed_states = record
        .last_reported_observations
        .iter()
        .filter(|observed| observed.instance_id == expected.instance_id)
        .cloned()
        .collect::<Vec<_>>();
    let inspection = desired
        .as_ref()
        .zip(manifest.as_ref())
        .map(|(desired, manifest)| ModuleInspection {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            manifest: manifest.clone(),
            desired: desired.clone(),
            observed: observed_states.clone(),
            grants: Vec::new(),
            contributions: Vec::new(),
            leases: Vec::new(),
            diagnostics: record.diagnostics.clone(),
        });
    let mut diagnostic_codes = record
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code.clone())
        .collect::<Vec<_>>();
    diagnostic_codes.sort();
    diagnostic_codes.dedup();

    let mut mismatches = Vec::new();
    if inspection.is_none() {
        mismatches.push("desired instance state is absent".to_string());
    }
    if expected
        .expected_enabled
        .is_some_and(|value| desired.as_ref().map(|state| state.enabled) != Some(value))
    {
        mismatches.push("enabled".to_string());
    }
    if expected
        .expected_artifact_digest
        .as_ref()
        .is_some_and(|digest| {
            manifest.as_ref().map(|artifact| &artifact.content_digest) != Some(digest)
        })
    {
        mismatches.push("artifact digest".to_string());
    }
    if expected
        .expected_configuration_revision
        .is_some_and(|revision| {
            desired.as_ref().map(|state| state.configuration_revision) != Some(revision)
        })
    {
        mismatches.push("configuration revision".to_string());
    }
    if expected
        .expected_applied_registry_revision
        .is_some_and(|revision| {
            !observed_states
                .iter()
                .any(|state| state.applied_registry_revision == revision)
        })
    {
        mismatches.push("applied registry revision".to_string());
    }
    if expected.expected_lifecycle.is_some_and(|lifecycle| {
        !observed_states
            .iter()
            .any(|state| state.lifecycle == lifecycle)
    }) {
        mismatches.push("lifecycle".to_string());
    }
    for code in &expected.expected_diagnostic_codes {
        if !diagnostic_codes.contains(code) {
            mismatches.push(format!("diagnostic {code}"));
        }
    }

    let matched = mismatches.is_empty();
    let diagnostics = if matched {
        Vec::new()
    } else {
        vec![verification_mismatch(&mismatches, &offline.state_root)]
    };
    let mut artifact_markers = BTreeMap::new();
    for artifact in &record.artifacts {
        artifact_markers.insert(
            artifact.identity.content_digest.clone(),
            format!(
                "present:{}",
                artifact
                    .sources
                    .iter()
                    .map(|source| format!("{source:?}").to_lowercase())
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        );
    }
    if let Some(static_record) = &record.static_inventory {
        artifact_markers.insert(
            static_record.identity.content_digest.clone(),
            format!("static_builtin:{}", static_record.build_provenance),
        );
    }
    let result = VerificationResult {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        fixture_id: expected.fixture_id.clone(),
        expected,
        observed: VerificationObserved {
            inspection,
            diagnostic_codes,
        },
        matched,
        diagnostics,
        resolved_paths: BTreeMap::from([
            (
                "registryPath".to_string(),
                offline.snapshot.registry_path.display().to_string(),
            ),
            (
                "stateRoot".to_string(),
                offline.state_root.display().to_string(),
            ),
        ]),
        artifact_markers,
    };
    result
        .validate()
        .map_err(|error| ControlError::new(error.code, error.message))?;
    Ok(result)
}

fn read_snapshot(state_root: Option<&Path>) -> Result<OfflineSnapshot, ControlError> {
    let (state_root, state_root_source) = resolve_state_root_read_only(state_root)
        .map_err(|error| ControlError::new(REGISTRY_STATE_ROOT_INVALID, error))?;
    let paths = ShipctlPaths::new(state_root.clone(), PathBuf::new());
    let snapshot = ModuleRegistry::open_read_only(&paths)
        .and_then(|registry| registry.snapshot())
        .map_err(registry_error)?;
    Ok(OfflineSnapshot {
        state_root,
        state_root_source,
        snapshot,
    })
}

fn registry_error(error: RegistryError) -> ControlError {
    ControlError::new(error.code, error.message)
}

fn module_ids(snapshot: &RegistrySnapshot) -> BTreeSet<&str> {
    snapshot
        .artifacts
        .iter()
        .map(|artifact| artifact.identity.id.as_str())
        .chain(
            snapshot
                .desired
                .iter()
                .map(|desired| desired.module_id.as_str()),
        )
        .chain(
            snapshot
                .observations
                .iter()
                .map(|observed| observed.module_id.as_str()),
        )
        .chain(
            snapshot
                .static_inventory
                .iter()
                .map(|record| record.identity.id.as_str()),
        )
        .collect()
}

fn summary(snapshot: &RegistrySnapshot, module_id: &str) -> OfflineModuleSummary {
    let mut runtime_kinds = snapshot
        .artifacts
        .iter()
        .filter(|artifact| artifact.identity.id == module_id)
        .map(|artifact| artifact.identity.runtime_kind)
        .collect::<Vec<_>>();
    runtime_kinds.sort_by_key(|kind| format!("{kind:?}"));
    runtime_kinds.dedup();
    OfflineModuleSummary {
        module_id: module_id.to_string(),
        runtime_kinds,
        static_builtin: snapshot
            .static_inventory
            .iter()
            .any(|record| record.identity.id == module_id),
        desired_state_count: usize::from(snapshot.effective_desired(module_id).is_some()),
        last_reported_observation_count: snapshot
            .observations
            .iter()
            .filter(|observed| observed.module_id == module_id)
            .count(),
    }
}

fn inspection(offline: &OfflineSnapshot, module_id: &str) -> Option<OfflineModuleInspection> {
    let artifacts = offline
        .snapshot
        .artifacts
        .iter()
        .filter(|artifact| artifact.identity.id == module_id)
        .cloned()
        .collect::<Vec<_>>();
    let static_inventory = offline
        .snapshot
        .static_inventory
        .iter()
        .find(|record| record.identity.id == module_id)
        .cloned();
    let desired = offline
        .snapshot
        .effective_desired(module_id)
        .into_iter()
        .collect::<Vec<_>>();
    let last_reported_observations = offline
        .snapshot
        .observations
        .iter()
        .filter(|observed| observed.module_id == module_id)
        .cloned()
        .collect::<Vec<_>>();
    if artifacts.is_empty()
        && static_inventory.is_none()
        && desired.is_empty()
        && last_reported_observations.is_empty()
    {
        return None;
    }
    Some(OfflineModuleInspection {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        module_id: module_id.to_string(),
        registry_revision: offline.snapshot.registry_revision,
        state_root: offline.state_root.clone(),
        state_root_source: offline.state_root_source.clone(),
        registry_path: offline.snapshot.registry_path.clone(),
        runtime_available: false,
        artifacts,
        static_inventory,
        desired,
        last_reported_observations,
        diagnostics: vec![runtime_unavailable(&offline.state_root)],
    })
}

fn runtime_unavailable(state_root: &Path) -> Diagnostic {
    diagnostic(
        RUNTIME_OFFLINE,
        DiagnosticSeverity::Info,
        "runtime_availability",
        "Offline inspection does not claim a running module runtime".to_string(),
        BTreeMap::from([
            ("runtimeAvailable".to_string(), "false".to_string()),
            ("stateRoot".to_string(), state_root.display().to_string()),
        ]),
        None,
    )
}

fn module_absent(module_id: &str, state_root: &Path) -> Diagnostic {
    diagnostic(
        MODULE_ABSENT,
        DiagnosticSeverity::Error,
        "module_presence",
        format!("Module {module_id} is absent from the selected registry"),
        BTreeMap::from([
            ("moduleId".to_string(), module_id.to_string()),
            ("stateRoot".to_string(), state_root.display().to_string()),
        ]),
        Some("Inspect the offline module list before selecting a module".to_string()),
    )
}

fn static_inventory_absent(registry_path: &Path) -> Diagnostic {
    diagnostic(
        REGISTRY_INVENTORY_ABSENT,
        DiagnosticSeverity::Warning,
        "static_build_provenance",
        "Registry has no recorded static build provenance".to_string(),
        BTreeMap::from([(
            "registryPath".to_string(),
            registry_path.display().to_string(),
        )]),
        Some(
            "Open this state root with the matching shipctl-ui build to seed inventory".to_string(),
        ),
    )
}

fn verification_mismatch(mismatches: &[String], state_root: &Path) -> Diagnostic {
    diagnostic(
        VERIFICATION_MISMATCH,
        DiagnosticSeverity::Error,
        "offline_expectation",
        "Offline registry facts do not satisfy the supplied expectation".to_string(),
        BTreeMap::from([
            ("mismatches".to_string(), mismatches.join(", ")),
            ("stateRoot".to_string(), state_root.display().to_string()),
        ]),
        Some(
            "Inspect the module offline and update either desired state or the expectation"
                .to_string(),
        ),
    )
}

fn diagnostic(
    code: &str,
    severity: DiagnosticSeverity,
    check: &str,
    summary: String,
    fields: BTreeMap<String, String>,
    remedy: Option<String>,
) -> Diagnostic {
    Diagnostic {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        code: code.to_string(),
        severity,
        check: check.to_string(),
        summary,
        evidence: RedactedEvidence { fields },
        remedy,
    }
}

pub fn diagnostics_code(report: &OfflineDiagnosticReport) -> &'static str {
    if report.healthy {
        REGISTRY_HEALTHY
    } else {
        REGISTRY_DIAGNOSTICS_FAILED
    }
}

pub fn verification_code(result: &VerificationResult) -> &'static str {
    if result.matched {
        VERIFICATION_MATCHED
    } else {
        VERIFICATION_MISMATCH
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_list_json(extra: &str, count: usize) -> String {
        format!(
            r#"{{
                "schemaVersion": {MODULE_CONTROL_SCHEMA_VERSION},
                "registryRevision": 0,
                "stateRoot": "/tmp/shipctl-state",
                "stateRootSource": "explicit",
                "registryPath": "/tmp/shipctl-state/module-control.sqlite3",
                "runtimeAvailable": false,
                "count": {count},
                "modules": [],
                "diagnostics": []
                {extra}
            }}"#
        )
    }

    #[test]
    fn offline_envelope_rejects_unknown_fields() {
        let error = parse_contract_json::<OfflineModuleList>(&empty_list_json(
            r#", "unexpected": true"#,
            0,
        ))
        .unwrap_err();

        assert_eq!(
            error.code,
            shipctl_core::module_control::codes::UNKNOWN_FIELD
        );
    }

    #[test]
    fn offline_envelope_validates_its_outer_shape() {
        let error = parse_contract_json::<OfflineModuleList>(&empty_list_json("", 1)).unwrap_err();

        assert_eq!(error.code, INVALID_OFFLINE_RESPONSE);
    }
}
