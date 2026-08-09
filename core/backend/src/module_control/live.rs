use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::codes::{
    BUILD_PROVENANCE, DESIRED_STATE_ABSENT, MODULE_ABSENT, MODULE_ACTIVE, MODULE_STARTUP_FAILED,
    MODULE_UNOBSERVED, OPERATION_ABSENT, REVISION_INVALID, REVISION_LAG, SNAPSHOT_AVAILABLE,
    SNAPSHOT_INVALID, SNAPSHOT_UNAVAILABLE,
};
use super::registry::{
    diagnose_registry, CapabilityCatalogSnapshot, ModuleRegistry, RegistryError, RegistrySnapshot,
};
use super::{
    artifact::{CapabilityManifest, RuntimeArtifactManifest, ValidatedRuntimeArtifact},
    Diagnostic, DiagnosticSeverity, ModuleContribution, ModuleInspection, ModuleLifecycleState,
    ModuleOperation, ObservedModuleState, RedactedEvidence, MODULE_CONTROL_SCHEMA_VERSION,
};
use crate::instance::{ControlError, ModuleControlStatus};
use crate::state::paths::ShipctlPaths;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendContributionInput {
    pub id: String,
    pub kind: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendModuleRuntimeInput {
    pub module_id: String,
    #[serde(default)]
    pub contributions: Vec<FrontendContributionInput>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupModuleStatus {
    Active,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupModulePhase {
    Descriptor,
    Resolve,
    Import,
    Validate,
    Bridge,
    Activation,
    Active,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendStartupModuleInput {
    pub module_id: String,
    pub status: StartupModuleStatus,
    pub phase: StartupModulePhase,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendRuntimeSnapshotInput {
    pub schema_version: u32,
    pub modules: Vec<FrontendModuleRuntimeInput>,
    #[serde(default)]
    pub startup_modules: Vec<FrontendStartupModuleInput>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeSnapshotReceipt {
    pub schema_version: u32,
    pub instance_id: Uuid,
    pub registry_revision: u64,
    pub published_at_unix_ms: u64,
    pub module_count: usize,
    pub contribution_count: usize,
}

/// One immutable runtime artifact selected for the next process start.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartupModuleDescriptor {
    pub schema_version: u32,
    pub module_id: String,
    pub version: String,
    pub content_digest: String,
    pub entry_path: PathBuf,
    pub manifest: RuntimeArtifactManifest,
    pub capabilities: CapabilityManifest,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartupModuleCatalog {
    pub schema_version: u32,
    pub registry_revision: u64,
    pub modules: Vec<StartupModuleDescriptor>,
}

#[derive(Clone, Debug)]
struct RuntimeModuleObservation {
    observed: ObservedModuleState,
    contributions: Vec<ModuleContribution>,
}

#[derive(Clone, Debug)]
struct RuntimeStartupObservation {
    status: StartupModuleStatus,
    phase: StartupModulePhase,
    route_count: usize,
    capability_count: usize,
}

#[derive(Clone, Debug)]
struct RuntimeSnapshot {
    registry_revision: u64,
    published_at_unix_ms: u64,
    modules: BTreeMap<String, RuntimeModuleObservation>,
    startup_modules: BTreeMap<String, RuntimeStartupObservation>,
}

#[derive(Clone)]
pub struct ModuleControlService {
    paths: ShipctlPaths,
    instance_id: Uuid,
    runtime: Arc<RwLock<Option<RuntimeSnapshot>>>,
}

impl ModuleControlService {
    /// Attach the current process incarnation to its state-root registry.
    /// Static build membership is resolved as a read-time enabled default and
    /// never creates desired rows, operations, or revisions during boot.
    pub fn initialize(paths: ShipctlPaths, instance_id: Uuid) -> Result<Self, RegistryError> {
        ModuleRegistry::open_writable(&paths)?.snapshot()?;

        Ok(Self {
            paths,
            instance_id,
            runtime: Arc::new(RwLock::new(None)),
        })
    }

    pub fn instance_id(&self) -> Uuid {
        self.instance_id
    }

    pub fn status(&self) -> ModuleControlStatus {
        let registry_revision = self
            .read_snapshot()
            .ok()
            .map(|snapshot| snapshot.registry_revision);
        let runtime = self
            .runtime
            .read()
            .ok()
            .and_then(|snapshot| snapshot.clone());
        let observed_registry_revision =
            runtime.as_ref().map(|snapshot| snapshot.registry_revision);
        ModuleControlStatus {
            registry_available: registry_revision.is_some(),
            registry_revision,
            runtime_snapshot_available: runtime.is_some(),
            runtime_snapshot_published_at_unix_ms: runtime
                .as_ref()
                .map(|snapshot| snapshot.published_at_unix_ms),
            observed_registry_revision,
            revision_lag: registry_revision
                .zip(observed_registry_revision)
                .map(|(registry, observed)| registry.saturating_sub(observed)),
        }
    }

    /// Resolve enabled dynamic artifacts once for process startup. This is a
    /// read-only projection: desired-state changes require a user restart and
    /// never reconcile this running process.
    pub fn startup_modules(&self) -> Result<StartupModuleCatalog, ControlError> {
        let snapshot = self.read_snapshot().map_err(registry_error)?;
        let mut modules = Vec::new();
        for desired in snapshot.desired.iter().filter(|desired| desired.enabled) {
            let Some(selected) = desired.selected_artifact.as_ref() else {
                continue;
            };
            let Some(entry) = snapshot
                .runtime_artifacts
                .iter()
                .find(|entry| entry.identity() == *selected)
            else {
                continue;
            };
            let manifest = entry.artifact.canonical_metadata().manifest;
            modules.push(StartupModuleDescriptor {
                schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                module_id: selected.id.clone(),
                version: selected.version.clone(),
                content_digest: selected.content_digest.clone(),
                entry_path: self
                    .paths
                    .module_artifact_root
                    .join(&selected.content_digest)
                    .join(&manifest.entry),
                capabilities: manifest.capabilities.clone(),
                manifest,
            });
        }
        modules.sort_by(|left, right| left.module_id.cmp(&right.module_id));
        Ok(StartupModuleCatalog {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            registry_revision: snapshot.registry_revision,
            modules,
        })
    }

    pub(crate) fn active_runtime_artifacts(
        &self,
    ) -> Result<Vec<ValidatedRuntimeArtifact>, ControlError> {
        let runtime = self
            .runtime
            .read()
            .map_err(|_| snapshot_error("Runtime module snapshot lock is poisoned"))?
            .clone()
            .ok_or_else(|| snapshot_error("Runtime module snapshot is not available"))?;
        let registry = self.read_snapshot().map_err(registry_error)?;
        let active = runtime
            .modules
            .values()
            .filter(|observation| observation.observed.lifecycle == ModuleLifecycleState::Active)
            .filter_map(|observation| observation.observed.artifact.as_ref())
            .cloned()
            .collect::<Vec<_>>();
        let mut artifacts = registry
            .runtime_artifacts
            .into_iter()
            .filter(|entry| active.iter().any(|identity| *identity == entry.identity()))
            .map(|entry| entry.artifact)
            .collect::<Vec<_>>();
        artifacts.sort_by(|left, right| {
            let left = left.identity();
            let right = right.identity();
            left.id
                .cmp(&right.id)
                .then_with(|| left.version.cmp(&right.version))
                .then_with(|| left.content_digest.cmp(&right.content_digest))
        });
        Ok(artifacts)
    }

    pub(crate) fn capability_catalog(&self) -> Result<CapabilityCatalogSnapshot, ControlError> {
        ModuleRegistry::open_read_only(&self.paths)
            .and_then(|registry| registry.capability_catalog())
            .map_err(registry_error)
    }

    pub fn inspect(&self, module_id: &str) -> Result<ModuleInspection, ControlError> {
        let snapshot = self.read_snapshot().map_err(registry_error)?;
        let desired = snapshot.effective_desired(module_id).ok_or_else(|| {
            let code = if snapshot
                .artifacts
                .iter()
                .any(|artifact| artifact.identity.id == module_id)
            {
                DESIRED_STATE_ABSENT
            } else {
                MODULE_ABSENT
            };
            ControlError::new(
                code,
                format!("Module {module_id} has no desired state in this state root"),
            )
            .with_selector(module_id)
            .for_context(self.instance_id, self.paths.state_root.clone())
        })?;
        let manifest = desired.selected_artifact.clone().ok_or_else(|| {
            ControlError::new(
                DESIRED_STATE_ABSENT,
                format!("Module {module_id} has no selected artifact"),
            )
            .with_selector(module_id)
            .for_context(self.instance_id, self.paths.state_root.clone())
        })?;
        let runtime = self.runtime.read().map_err(|_| {
            ControlError::new(
                SNAPSHOT_INVALID,
                "The host runtime snapshot lock is unavailable",
            )
        })?;
        let live = runtime
            .as_ref()
            .and_then(|runtime| runtime.modules.get(module_id));
        let startup = runtime
            .as_ref()
            .and_then(|runtime| runtime.startup_modules.get(module_id));
        let observed = live
            .map(|module| vec![module.observed.clone()])
            .unwrap_or_default();
        let contributions = live
            .map(|module| module.contributions.clone())
            .unwrap_or_default();
        let diagnostics = self.module_diagnostics(&snapshot, module_id, live, startup);

        Ok(ModuleInspection {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            manifest,
            desired,
            observed,
            grants: Vec::new(),
            contributions,
            leases: Vec::new(),
            diagnostics,
        })
    }

    pub fn diagnose_module(&self, module_id: &str) -> Result<Vec<Diagnostic>, ControlError> {
        Ok(self.inspect(module_id)?.diagnostics)
    }

    pub fn diagnose_instance(&self) -> Vec<Diagnostic> {
        let mut diagnostics = diagnose_registry(&self.paths.module_registry_database);
        let snapshot = self.read_snapshot().ok();
        let runtime = self.runtime.read().ok().and_then(|runtime| runtime.clone());
        match runtime {
            None => diagnostics.push(runtime_diagnostic(
                SNAPSHOT_UNAVAILABLE,
                DiagnosticSeverity::Warning,
                "runtime_snapshot",
                "The frontend host has not published an observed runtime snapshot".to_string(),
                self.instance_id,
                snapshot.as_ref().map(|snapshot| snapshot.registry_revision),
                None,
            )),
            Some(runtime) => {
                diagnostics.push(runtime_diagnostic(
                    SNAPSHOT_AVAILABLE,
                    DiagnosticSeverity::Info,
                    "runtime_snapshot",
                    "The frontend host published an observed runtime snapshot".to_string(),
                    self.instance_id,
                    snapshot.as_ref().map(|snapshot| snapshot.registry_revision),
                    Some(runtime.registry_revision),
                ));
                if let Some(registry_revision) =
                    snapshot.as_ref().map(|snapshot| snapshot.registry_revision)
                {
                    diagnostics.extend(revision_diagnostics(
                        self.instance_id,
                        registry_revision,
                        runtime.registry_revision,
                    ));
                }
            }
        }
        diagnostics
    }

    pub fn inspect_operation(&self, operation_id: Uuid) -> Result<ModuleOperation, ControlError> {
        self.read_snapshot()
            .map_err(registry_error)?
            .operations
            .into_iter()
            .find(|operation| {
                operation.request_id == operation_id && operation.instance_id == self.instance_id
            })
            .ok_or_else(|| {
                ControlError::new(
                    OPERATION_ABSENT,
                    format!("Module operation {operation_id} is absent for this instance"),
                )
                .for_context(self.instance_id, self.paths.state_root.clone())
            })
    }

    pub fn publish_frontend_snapshot(
        &self,
        input: FrontendRuntimeSnapshotInput,
    ) -> Result<RuntimeSnapshotReceipt, ControlError> {
        if input.schema_version != MODULE_CONTROL_SCHEMA_VERSION {
            return Err(snapshot_error(format!(
                "Snapshot schema version {} is unsupported",
                input.schema_version
            )));
        }
        let registry = self.read_snapshot().map_err(registry_error)?;
        let mut frontend_inventory = registry
            .static_inventory
            .iter()
            .filter(|record| record.frontend_shipped)
            .map(|record| (record.identity.id.clone(), record.identity.clone()))
            .collect::<BTreeMap<_, _>>();
        let mut startup_inventory = BTreeMap::new();
        for desired in registry.desired.iter().filter(|desired| desired.enabled) {
            let Some(selected) = desired.selected_artifact.as_ref() else {
                continue;
            };
            if registry
                .runtime_artifacts
                .iter()
                .any(|entry| entry.identity() == *selected)
            {
                frontend_inventory.insert(selected.id.clone(), selected.clone());
                let entry = registry
                    .runtime_artifacts
                    .iter()
                    .find(|entry| entry.identity() == *selected)
                    .expect("selected runtime artifact was checked above");
                let canonical = entry.artifact.canonical_metadata();
                let manifest = &canonical.manifest;
                startup_inventory.insert(
                    selected.id.clone(),
                    (
                        manifest.messages.handles.len()
                            + manifest.messages.publishes.len()
                            + manifest.messages.subscribes.len()
                            + manifest.messages.ports.len(),
                        manifest.capabilities.definitions.len(),
                    ),
                );
            }
        }
        let mut module_ids = BTreeSet::new();
        let mut contribution_ids = BTreeSet::new();
        let mut modules = BTreeMap::new();

        for module in input.modules {
            if !module_ids.insert(module.module_id.clone()) {
                return Err(snapshot_error(format!(
                    "Module {} appears more than once",
                    module.module_id
                )));
            }
            let artifact = frontend_inventory.get(&module.module_id).ok_or_else(|| {
                snapshot_error(format!(
                    "Module {} is not a frontend contribution in this host build",
                    module.module_id
                ))
            })?;
            let module_instance_id = format!("frontend:{}:{}", module.module_id, Uuid::new_v4());
            let mut contributions = Vec::with_capacity(module.contributions.len());
            for contribution in module.contributions {
                if contribution.id.trim().is_empty()
                    || !contribution.id.contains('.')
                    || contribution.kind.trim().is_empty()
                    || !contribution_ids.insert(contribution.id.clone())
                {
                    return Err(snapshot_error(format!(
                        "Contribution {} has an invalid or duplicate identity",
                        contribution.id
                    )));
                }
                contributions.push(ModuleContribution {
                    id: contribution.id,
                    kind: contribution.kind,
                    owner_instance_id: Some(module_instance_id.clone()),
                });
            }
            modules.insert(
                module.module_id.clone(),
                RuntimeModuleObservation {
                    observed: ObservedModuleState {
                        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                        module_id: module.module_id,
                        instance_id: self.instance_id,
                        artifact: Some(artifact.clone()),
                        applied_registry_revision: registry.registry_revision,
                        lifecycle: ModuleLifecycleState::Active,
                        module_instance_id: Some(module_instance_id),
                    },
                    contributions,
                },
            );
        }

        let startup_modules =
            startup_observations(&startup_inventory, &module_ids, input.startup_modules)?;

        let published_at_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| snapshot_error(format!("System clock is before Unix epoch: {error}")))?
            .as_millis()
            .try_into()
            .map_err(|_| snapshot_error("Snapshot timestamp exceeds the supported range"))?;
        let module_count = modules.len();
        let contribution_count = modules
            .values()
            .map(|module| module.contributions.len())
            .sum();
        *self
            .runtime
            .write()
            .map_err(|_| snapshot_error("The host runtime snapshot lock is unavailable"))? =
            Some(RuntimeSnapshot {
                registry_revision: registry.registry_revision,
                published_at_unix_ms,
                modules,
                startup_modules,
            });

        Ok(RuntimeSnapshotReceipt {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            instance_id: self.instance_id,
            registry_revision: registry.registry_revision,
            published_at_unix_ms,
            module_count,
            contribution_count,
        })
    }

    fn read_snapshot(&self) -> Result<RegistrySnapshot, RegistryError> {
        ModuleRegistry::open_read_only(&self.paths)?.snapshot()
    }

    fn module_diagnostics(
        &self,
        registry: &RegistrySnapshot,
        module_id: &str,
        live: Option<&RuntimeModuleObservation>,
        startup: Option<&RuntimeStartupObservation>,
    ) -> Vec<Diagnostic> {
        let mut diagnostics = Vec::new();
        if let Some(provenance) = registry.static_build_provenance.as_ref() {
            diagnostics.push(Diagnostic {
                schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                code: BUILD_PROVENANCE.to_string(),
                severity: DiagnosticSeverity::Info,
                check: "build_provenance".to_string(),
                summary: "The selected artifact belongs to the running host build".to_string(),
                evidence: RedactedEvidence {
                    fields: BTreeMap::from([
                        ("moduleId".to_string(), module_id.to_string()),
                        ("buildProvenance".to_string(), provenance.clone()),
                    ]),
                },
                remedy: None,
            });
        }
        match (live, startup) {
            (Some(live), startup) => {
                diagnostics.push(startup_diagnostic(
                    MODULE_ACTIVE,
                    DiagnosticSeverity::Info,
                    "module_activation",
                    format!("Module {module_id} is active in the frontend host"),
                    self.instance_id,
                    module_id,
                    Some(registry.registry_revision),
                    startup,
                ));
                diagnostics.extend(revision_diagnostics(
                    self.instance_id,
                    registry.registry_revision,
                    live.observed.applied_registry_revision,
                ));
            }
            (None, Some(startup)) if startup.status == StartupModuleStatus::Failed => {
                diagnostics.push(startup_diagnostic(
                    MODULE_STARTUP_FAILED,
                    DiagnosticSeverity::Error,
                    "module_activation",
                    format!("Module {module_id} failed during restart-bound startup"),
                    self.instance_id,
                    module_id,
                    Some(registry.registry_revision),
                    Some(startup),
                ));
            }
            (None, _) => diagnostics.push(runtime_diagnostic(
                MODULE_UNOBSERVED,
                DiagnosticSeverity::Warning,
                "module_observation",
                format!("Module {module_id} is not present in the latest frontend snapshot"),
                self.instance_id,
                Some(registry.registry_revision),
                None,
            )),
        }
        diagnostics
    }
}

fn startup_observations(
    inventory: &BTreeMap<String, (usize, usize)>,
    active_module_ids: &BTreeSet<String>,
    reported: Vec<FrontendStartupModuleInput>,
) -> Result<BTreeMap<String, RuntimeStartupObservation>, ControlError> {
    let mut observations = BTreeMap::new();
    for startup in reported {
        let Some((route_count, capability_count)) = inventory.get(&startup.module_id).copied()
        else {
            return Err(snapshot_error(format!(
                "Module {} is not a selected restart-bound artifact",
                startup.module_id
            )));
        };
        if observations.contains_key(&startup.module_id) {
            return Err(snapshot_error(format!(
                "Module {} has more than one startup result",
                startup.module_id
            )));
        }
        let active = active_module_ids.contains(&startup.module_id);
        let valid = match (startup.status, startup.phase, active) {
            (StartupModuleStatus::Active, StartupModulePhase::Active, true) => true,
            (StartupModuleStatus::Failed, phase, false) if phase != StartupModulePhase::Active => {
                true
            }
            _ => false,
        };
        if !valid {
            return Err(snapshot_error(format!(
                "Module {} startup result disagrees with the active runtime snapshot",
                startup.module_id
            )));
        }
        observations.insert(
            startup.module_id,
            RuntimeStartupObservation {
                status: startup.status,
                phase: startup.phase,
                route_count,
                capability_count,
            },
        );
    }
    for (module_id, (route_count, capability_count)) in inventory {
        if observations.contains_key(module_id) {
            continue;
        }
        if active_module_ids.contains(module_id) {
            return Err(snapshot_error(format!(
                "Active module {module_id} is missing its startup result"
            )));
        }
        observations.insert(
            module_id.clone(),
            RuntimeStartupObservation {
                status: StartupModuleStatus::Failed,
                phase: StartupModulePhase::Descriptor,
                route_count: *route_count,
                capability_count: *capability_count,
            },
        );
    }
    Ok(observations)
}

#[tauri::command]
pub fn publish_module_runtime_snapshot(
    service: tauri::State<'_, ModuleControlService>,
    snapshot: FrontendRuntimeSnapshotInput,
) -> Result<RuntimeSnapshotReceipt, ControlError> {
    service.publish_frontend_snapshot(snapshot)
}

#[tauri::command]
pub fn list_startup_modules(
    service: tauri::State<'_, ModuleControlService>,
) -> Result<StartupModuleCatalog, ControlError> {
    service.startup_modules()
}

fn registry_error(error: RegistryError) -> ControlError {
    ControlError::new(error.code, error.message)
}

fn snapshot_error(message: impl Into<String>) -> ControlError {
    ControlError::new(SNAPSHOT_INVALID, message)
}

fn revision_diagnostics(
    instance_id: Uuid,
    registry_revision: u64,
    observed_revision: u64,
) -> Vec<Diagnostic> {
    if observed_revision < registry_revision {
        vec![runtime_diagnostic(
            REVISION_LAG,
            DiagnosticSeverity::Warning,
            "registry_revision",
            format!(
                "Observed runtime revision {observed_revision} trails registry revision {registry_revision}"
            ),
            instance_id,
            Some(registry_revision),
            Some(observed_revision),
        )]
    } else if observed_revision > registry_revision {
        vec![runtime_diagnostic(
            REVISION_INVALID,
            DiagnosticSeverity::Error,
            "registry_revision",
            format!(
                "Observed runtime revision {observed_revision} is ahead of registry revision {registry_revision}"
            ),
            instance_id,
            Some(registry_revision),
            Some(observed_revision),
        )]
    } else {
        Vec::new()
    }
}

fn runtime_diagnostic(
    code: &str,
    severity: DiagnosticSeverity,
    check: &str,
    summary: String,
    instance_id: Uuid,
    registry_revision: Option<u64>,
    observed_revision: Option<u64>,
) -> Diagnostic {
    let mut fields = BTreeMap::from([("instanceId".to_string(), instance_id.to_string())]);
    if let Some(revision) = registry_revision {
        fields.insert("registryRevision".to_string(), revision.to_string());
    }
    if let Some(revision) = observed_revision {
        fields.insert("observedRegistryRevision".to_string(), revision.to_string());
    }
    Diagnostic {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        code: code.to_string(),
        severity,
        check: check.to_string(),
        summary,
        evidence: RedactedEvidence { fields },
        remedy: None,
    }
}

fn startup_diagnostic(
    code: &str,
    severity: DiagnosticSeverity,
    check: &str,
    summary: String,
    instance_id: Uuid,
    module_id: &str,
    registry_revision: Option<u64>,
    startup: Option<&RuntimeStartupObservation>,
) -> Diagnostic {
    let mut fields = BTreeMap::from([
        ("instanceId".to_string(), instance_id.to_string()),
        ("moduleId".to_string(), module_id.to_string()),
    ]);
    if let Some(revision) = registry_revision {
        fields.insert("registryRevision".to_string(), revision.to_string());
    }
    if let Some(startup) = startup {
        let phase = serde_json::to_value(startup.phase)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| "unknown".to_string());
        fields.insert("phase".to_string(), phase);
        fields.insert("routeCount".to_string(), startup.route_count.to_string());
        fields.insert(
            "capabilityCount".to_string(),
            startup.capability_count.to_string(),
        );
    }
    Diagnostic {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        code: code.to_string(),
        severity,
        check: check.to_string(),
        summary,
        evidence: RedactedEvidence { fields },
        remedy: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::module_control::codes::REGISTRY_HEALTHY;
    use crate::module_control::registry::{
        ArtifactAcquisition, BuildModuleMembership, RegistryMutation, StaticBuildInventory,
    };
    use crate::module_control::{
        DesiredModuleState, ModuleIdentity, ModuleOperationKind, ModuleSource,
    };

    fn service() -> (tempfile::TempDir, ModuleControlService, ModuleIdentity) {
        let root = tempfile::tempdir().unwrap();
        let paths = ShipctlPaths::new(root.path().join("state"), root.path().join("runtime"));
        let inventory = StaticBuildInventory::from_build_composition(
            "test-host",
            "1.0.0",
            vec![BuildModuleMembership {
                module_id: "shipctl.test".to_string(),
                native_compiled: true,
                frontend_shipped: true,
            }],
        )
        .unwrap();
        let artifact = inventory.modules[0].identity.clone();
        ModuleRegistry::open_writable(&paths)
            .unwrap()
            .seed_static_inventory(&inventory)
            .unwrap();
        let service = ModuleControlService::initialize(paths, Uuid::new_v4()).unwrap();
        (root, service, artifact)
    }

    #[test]
    fn initialization_uses_static_defaults_without_mutating_the_registry() {
        let (_root, service, artifact) = service();
        let first = service.inspect("shipctl.test").unwrap();
        assert!(first.desired.enabled);
        assert_eq!(first.desired.configuration_revision, 0);
        assert_eq!(first.manifest, artifact);
        assert!(first.observed.is_empty());
        assert!(first
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == MODULE_UNOBSERVED));

        let revision = service.status().registry_revision.unwrap();
        let reattached =
            ModuleControlService::initialize(service.paths.clone(), Uuid::new_v4()).unwrap();
        assert_eq!(reattached.status().registry_revision, Some(revision));
    }

    #[test]
    fn disabled_desired_state_survives_a_new_process_incarnation() {
        let (_root, first, artifact) = service();
        let mut registry = ModuleRegistry::open_writable(&first.paths).unwrap();
        registry
            .commit(&RegistryMutation {
                request_id: Uuid::new_v4(),
                module_id: artifact.id.clone(),
                instance_id: first.instance_id,
                kind: ModuleOperationKind::Disable,
                artifacts: vec![ArtifactAcquisition {
                    identity: artifact.clone(),
                    source: ModuleSource::Bundled,
                }],
                desired: Some(DesiredModuleState {
                    schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                    module_id: artifact.id.clone(),
                    selected_artifact: Some(artifact),
                    enabled: false,
                    configuration_revision: 1,
                }),
                observations: Vec::new(),
            })
            .unwrap();
        let revision = registry.revision().unwrap();
        drop(registry);

        let restarted =
            ModuleControlService::initialize(first.paths.clone(), Uuid::new_v4()).unwrap();
        let inspection = restarted.inspect("shipctl.test").unwrap();

        assert!(!inspection.desired.enabled);
        assert_eq!(inspection.desired.configuration_revision, 1);
        assert_eq!(restarted.status().registry_revision, Some(revision));
    }

    #[test]
    fn frontend_snapshot_is_host_enriched_and_joined_with_registry_truth() {
        let (_root, service, artifact) = service();
        let receipt = service
            .publish_frontend_snapshot(FrontendRuntimeSnapshotInput {
                schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                modules: vec![FrontendModuleRuntimeInput {
                    module_id: "shipctl.test".to_string(),
                    contributions: vec![FrontendContributionInput {
                        id: "test.panel".to_string(),
                        kind: "panel".to_string(),
                    }],
                }],
                startup_modules: Vec::new(),
            })
            .unwrap();
        let inspection = service.inspect("shipctl.test").unwrap();

        assert_eq!(inspection.observed.len(), 1);
        assert_eq!(inspection.observed[0].artifact.as_ref(), Some(&artifact));
        assert_eq!(
            inspection.observed[0].applied_registry_revision,
            receipt.registry_revision
        );
        assert_eq!(inspection.contributions[0].id, "test.panel");
        assert!(inspection.contributions[0].owner_instance_id.is_some());
        assert!(inspection
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == MODULE_ACTIVE));
        assert_eq!(service.status().revision_lag, Some(0));
    }

    #[test]
    fn snapshot_rejects_unknown_frontend_identity() {
        let (_root, service, _artifact) = service();
        let error = service
            .publish_frontend_snapshot(FrontendRuntimeSnapshotInput {
                schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                modules: vec![FrontendModuleRuntimeInput {
                    module_id: "shipctl.unknown".to_string(),
                    contributions: Vec::new(),
                }],
                startup_modules: Vec::new(),
            })
            .unwrap_err();
        assert_eq!(error.code.as_str(), SNAPSHOT_INVALID);
        assert!(!service.status().runtime_snapshot_available);
        assert!(service
            .diagnose_instance()
            .iter()
            .any(|diagnostic| diagnostic.code == REGISTRY_HEALTHY));
    }

    #[test]
    fn missing_restart_bound_result_becomes_a_descriptor_failure() {
        let observations = startup_observations(
            &BTreeMap::from([("shipctl.demo".to_string(), (3, 1))]),
            &BTreeSet::new(),
            Vec::new(),
        )
        .unwrap();
        let observation = observations.get("shipctl.demo").unwrap();

        assert_eq!(observation.status, StartupModuleStatus::Failed);
        assert_eq!(observation.phase, StartupModulePhase::Descriptor);
        assert_eq!(observation.route_count, 3);
        assert_eq!(observation.capability_count, 1);
    }
}
