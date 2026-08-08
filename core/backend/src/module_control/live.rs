use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::codes::{
    BUILD_PROVENANCE, CONTROL_CAPABILITY_UNAVAILABLE, DESIRED_STATE_ABSENT, MODULE_ABSENT,
    MODULE_ACTIVE, MODULE_UNOBSERVED, OPERATION_ABSENT, REVISION_INVALID, REVISION_LAG,
    SNAPSHOT_AVAILABLE, SNAPSHOT_INVALID, SNAPSHOT_UNAVAILABLE,
};
use super::registry::{diagnose_registry, ModuleRegistry, RegistryError, RegistrySnapshot};
use super::{
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendRuntimeSnapshotInput {
    pub schema_version: u32,
    pub modules: Vec<FrontendModuleRuntimeInput>,
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

#[derive(Clone, Debug)]
struct RuntimeModuleObservation {
    observed: ObservedModuleState,
    contributions: Vec<ModuleContribution>,
}

#[derive(Clone, Debug)]
struct RuntimeSnapshot {
    registry_revision: u64,
    published_at_unix_ms: u64,
    modules: BTreeMap<String, RuntimeModuleObservation>,
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
        let observed = live
            .map(|module| vec![module.observed.clone()])
            .unwrap_or_default();
        let contributions = live
            .map(|module| module.contributions.clone())
            .unwrap_or_default();
        let diagnostics = self.module_diagnostics(&snapshot, module_id, live);

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
        let frontend_inventory = registry
            .static_inventory
            .iter()
            .filter(|record| record.frontend_shipped)
            .map(|record| (record.identity.id.as_str(), &record.identity))
            .collect::<BTreeMap<_, _>>();
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
            let artifact = frontend_inventory
                .get(module.module_id.as_str())
                .ok_or_else(|| {
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
                        artifact: Some((*artifact).clone()),
                        applied_registry_revision: registry.registry_revision,
                        lifecycle: ModuleLifecycleState::Active,
                        module_instance_id: Some(module_instance_id),
                    },
                    contributions,
                },
            );
        }

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
        match live {
            Some(live) => {
                diagnostics.push(runtime_diagnostic(
                    MODULE_ACTIVE,
                    DiagnosticSeverity::Info,
                    "module_observation",
                    format!("Module {module_id} is active in the frontend host"),
                    self.instance_id,
                    Some(registry.registry_revision),
                    Some(live.observed.applied_registry_revision),
                ));
                diagnostics.extend(revision_diagnostics(
                    self.instance_id,
                    registry.registry_revision,
                    live.observed.applied_registry_revision,
                ));
            }
            None => diagnostics.push(runtime_diagnostic(
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

#[tauri::command]
pub fn publish_module_runtime_snapshot(
    service: tauri::State<'_, Option<ModuleControlService>>,
    snapshot: FrontendRuntimeSnapshotInput,
) -> Result<RuntimeSnapshotReceipt, ControlError> {
    service
        .as_ref()
        .ok_or_else(|| {
            ControlError::new(
                CONTROL_CAPABILITY_UNAVAILABLE,
                "Module control is unavailable in this host mode",
            )
        })?
        .publish_frontend_snapshot(snapshot)
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
            })
            .unwrap_err();
        assert_eq!(error.code.as_str(), SNAPSHOT_INVALID);
        assert!(!service.status().runtime_snapshot_available);
        assert!(service
            .diagnose_instance()
            .iter()
            .any(|diagnostic| diagnostic.code == REGISTRY_HEALTHY));
    }
}
