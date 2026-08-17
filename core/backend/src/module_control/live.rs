use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use uuid::Uuid;

use super::codes::{
    BUILD_PROVENANCE, DESIRED_STATE_ABSENT, MODULE_ABSENT, MODULE_ACTIVE, MODULE_STARTUP_FAILED,
    MODULE_UNOBSERVED, MUTATION_UNAVAILABLE, OPERATION_ABSENT, RECONCILIATION_FAILED,
    REVISION_INVALID, REVISION_LAG, REVISION_OBSERVER_UNAVAILABLE, SNAPSHOT_AVAILABLE,
    SNAPSHOT_INVALID, SNAPSHOT_UNAVAILABLE,
};
use super::registry::{
    diagnose_registry, CapabilityCatalogSnapshot, ModuleRegistry, ReconciliationFailureRecord,
    RegistryError, RegistryMutation, RegistrySnapshot, RuntimeAcceptanceRecord,
};
use super::{
    artifact::{CapabilityManifest, RuntimeArtifactManifest, ValidatedRuntimeArtifact},
    DesiredModuleState, Diagnostic, DiagnosticSeverity, ModuleContribution, ModuleIdentity,
    ModuleInspection, ModuleLifecycleState, ModuleOperation, ModuleOperationKind,
    ModuleOperationPhase, ModuleOperationResult, ModuleTransition, ObservedModuleState,
    RedactedEvidence, MODULE_CONTROL_SCHEMA_VERSION,
};
use crate::instance::{ControlError, ModuleControlStatus};
use crate::state::paths::ShipctlPaths;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendContributionInput {
    pub id: String,
    pub kind: String,
}

fn valid_frontend_contribution_id(kind: &str, id: &str) -> bool {
    if kind == "terminal_presentation" {
        return crate::terminal_host::TerminalDriverId::new(id).is_ok();
    }
    id.contains('.')
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendModuleRuntimeInput {
    pub module_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_content_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activation_id: Option<String>,
    #[serde(default)]
    pub contributions: Vec<FrontendContributionInput>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeActivationStatus {
    Active,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeActivationPhase {
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
pub struct FrontendRuntimeActivationInput {
    pub module_id: String,
    pub status: RuntimeActivationStatus,
    pub phase: RuntimeActivationPhase,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendRuntimeSnapshotInput {
    pub schema_version: u32,
    pub registry_revision: u64,
    pub modules: Vec<FrontendModuleRuntimeInput>,
    #[serde(default)]
    pub activation_outcomes: Vec<FrontendRuntimeActivationInput>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReconciliationFailurePhase {
    Observe,
    Prepare,
    Validate,
    Publish,
    Dispose,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReconciliationFailureInput {
    pub schema_version: u32,
    pub registry_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activation_id: Option<String>,
    pub phase: ReconciliationFailurePhase,
    pub code: String,
    pub message: String,
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

/// One immutable runtime artifact selected by a desired registry revision.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeModuleDescriptor {
    pub schema_version: u32,
    pub module_id: String,
    pub version: String,
    pub content_digest: String,
    pub entry_path: PathBuf,
    pub style_paths: Vec<PathBuf>,
    pub manifest: RuntimeArtifactManifest,
    pub capabilities: CapabilityManifest,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeModuleCatalog {
    pub schema_version: u32,
    pub registry_revision: u64,
    pub modules: Vec<RuntimeModuleDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_applied: Option<AppliedRuntimeModuleCatalog>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppliedRuntimeModuleCatalog {
    pub registry_revision: u64,
    pub modules: Vec<RuntimeModuleDescriptor>,
}

#[derive(Clone, Debug)]
struct RuntimeModuleObservation {
    observed: ObservedModuleState,
    contributions: Vec<ModuleContribution>,
}

#[derive(Clone, Debug)]
struct RuntimeActivationObservation {
    status: RuntimeActivationStatus,
    phase: RuntimeActivationPhase,
    route_count: usize,
    capability_count: usize,
}

#[derive(Clone, Debug)]
struct RuntimeSnapshot {
    registry_revision: u64,
    published_at_unix_ms: u64,
    modules: BTreeMap<String, RuntimeModuleObservation>,
    activation_outcomes: BTreeMap<String, RuntimeActivationObservation>,
}

#[derive(Clone)]
pub struct ModuleControlService {
    paths: ShipctlPaths,
    instance_id: Uuid,
    runtime: Arc<RwLock<Option<RuntimeSnapshot>>>,
    reconciliation_failures: Arc<RwLock<BTreeMap<u64, ReconciliationFailureInput>>>,
    registry_revisions: watch::Sender<u64>,
    _registry_revision_watcher: Arc<Mutex<RecommendedWatcher>>,
}

impl ModuleControlService {
    /// Attach the current process incarnation to its state-root registry.
    /// Static build membership is resolved as a read-time enabled default and
    /// never creates desired rows, operations, or revisions during boot.
    pub fn initialize(paths: ShipctlPaths, instance_id: Uuid) -> Result<Self, RegistryError> {
        let snapshot = ModuleRegistry::open_writable(&paths)?.snapshot()?;
        let registry_revision = snapshot.registry_revision;
        let (registry_revisions, _) = watch::channel(registry_revision);
        let watcher_paths = paths.clone();
        let watcher_revisions = registry_revisions.clone();
        let mut registry_revision_watcher =
            notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
                let Ok(_) = result else {
                    return;
                };
                publish_current_registry_revision(&watcher_paths, &watcher_revisions);
            })
            .map_err(|error| {
                RegistryError::new(
                    REVISION_OBSERVER_UNAVAILABLE,
                    format!("Cannot create the module registry revision observer: {error}"),
                )
            })?;
        registry_revision_watcher
            .watch(&paths.module_registry_database, RecursiveMode::NonRecursive)
            .map_err(|error| {
                RegistryError::new(
                    REVISION_OBSERVER_UNAVAILABLE,
                    format!(
                        "Cannot observe module registry revisions at {}: {error}",
                        paths.module_registry_database.display()
                    ),
                )
            })?;

        // Close the interval between the initial read and watcher registration.
        // Monotonic publication makes duplicate native events harmless.
        publish_current_registry_revision(&paths, &registry_revisions);
        let reconciliation_failures = snapshot
            .reconciliation_failures
            .into_iter()
            .filter_map(reconciliation_failure_input)
            .map(|failure| (failure.registry_revision, failure))
            .collect();

        Ok(Self {
            paths,
            instance_id,
            runtime: Arc::new(RwLock::new(None)),
            reconciliation_failures: Arc::new(RwLock::new(reconciliation_failures)),
            registry_revisions,
            _registry_revision_watcher: Arc::new(Mutex::new(registry_revision_watcher)),
        })
    }

    pub fn instance_id(&self) -> Uuid {
        self.instance_id
    }

    /// Subscribe to the durable desired revision for this process. A new
    /// receiver starts with the current revision, so registration and delivery
    /// cannot lose a commit between the two steps.
    pub fn observe_registry_revisions(&self) -> watch::Receiver<u64> {
        self.registry_revisions.subscribe()
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

    /// Commit one optimistic desired-state change for this running instance.
    /// The returned operation is pending until the frontend publishes or
    /// rejects the committed registry revision.
    pub fn transition_module(
        &self,
        module_id: &str,
        kind: ModuleOperationKind,
        target_registry_revision: u64,
        artifact_content_digest: Option<&str>,
    ) -> Result<ModuleOperation, ControlError> {
        let mut registry = ModuleRegistry::open_writable(&self.paths).map_err(registry_error)?;
        let snapshot = registry.snapshot().map_err(registry_error)?;
        let current = snapshot.effective_desired(module_id).ok_or_else(|| {
            ControlError::new(
                MODULE_ABSENT,
                format!("Module {module_id} is absent from the selected registry"),
            )
            .with_selector(module_id)
            .for_context(self.instance_id, self.paths.state_root.clone())
        })?;
        let (enabled, selected_artifact) = match kind {
            ModuleOperationKind::Enable | ModuleOperationKind::Disable => {
                if artifact_content_digest.is_some() {
                    return Err(ControlError::new(
                        MUTATION_UNAVAILABLE,
                        "Enable and disable do not accept an artifact digest",
                    ));
                }
                (
                    kind == ModuleOperationKind::Enable,
                    current.selected_artifact.clone(),
                )
            }
            ModuleOperationKind::Remove => {
                if artifact_content_digest.is_some() {
                    return Err(ControlError::new(
                        MUTATION_UNAVAILABLE,
                        "Remove does not accept an artifact digest",
                    ));
                }
                if !snapshot
                    .desired
                    .iter()
                    .any(|desired| desired.module_id == module_id)
                {
                    return Err(ControlError::new(
                        MUTATION_UNAVAILABLE,
                        "Only an explicitly installed runtime module can be removed live",
                    )
                    .with_selector(module_id)
                    .for_context(self.instance_id, self.paths.state_root.clone()));
                }
                // Removal clears the durable selection. Immutable package
                // bytes stay admitted until a separate repository
                // garbage-collection policy removes them.
                (false, None)
            }
            ModuleOperationKind::Update => {
                let digest = artifact_content_digest
                    .filter(|digest| !digest.trim().is_empty())
                    .ok_or_else(|| {
                        ControlError::new(
                            MUTATION_UNAVAILABLE,
                            "A live module replacement requires an artifact content digest",
                        )
                    })?;
                let selected = snapshot
                    .runtime_artifacts
                    .iter()
                    .map(|entry| entry.identity())
                    .find(|identity| {
                        identity.id == module_id && identity.content_digest == digest
                    })
                    .ok_or_else(|| {
                        ControlError::new(
                            MODULE_ABSENT,
                            format!(
                                "Module {module_id} has no installed runtime artifact with digest {digest}"
                            ),
                        )
                        .with_selector(module_id)
                        .for_context(self.instance_id, self.paths.state_root.clone())
                    })?;
                (current.enabled, Some(selected))
            }
            _ => {
                return Err(ControlError::new(
                    MUTATION_UNAVAILABLE,
                    "The live endpoint accepts enable, disable, replace, and remove transitions",
                ))
            }
        };
        if enabled && selected_artifact.is_none() {
            return Err(ControlError::new(
                MODULE_ABSENT,
                format!("Module {module_id} has no selected runtime artifact"),
            )
            .with_selector(module_id)
            .for_context(self.instance_id, self.paths.state_root.clone()));
        }
        if current.enabled == enabled && current.selected_artifact == selected_artifact {
            if target_registry_revision != snapshot.registry_revision {
                return Err(revision_target_error(
                    self,
                    snapshot.registry_revision,
                    target_registry_revision,
                ));
            }
            return Ok(completed_no_op_operation(
                self.instance_id,
                module_id,
                kind,
                snapshot.registry_revision,
            ));
        }
        let expected_revision = snapshot.registry_revision.checked_add(1).ok_or_else(|| {
            ControlError::new(
                REVISION_INVALID,
                "Registry revision cannot advance beyond u64::MAX",
            )
        })?;
        if target_registry_revision != expected_revision {
            return Err(revision_target_error(
                self,
                expected_revision,
                target_registry_revision,
            ));
        }
        let desired = Some(if kind == ModuleOperationKind::Remove {
            // Keep an explicit no-selection tombstone. Deleting the row would
            // let a bundled artifact look new at the next process start and
            // silently undo the user's live removal.
            DesiredModuleState {
                enabled: false,
                selected_artifact: None,
                configuration_revision: current.configuration_revision.checked_add(1).ok_or_else(
                    || {
                        ControlError::new(
                            REVISION_INVALID,
                            "Module configuration revision cannot advance beyond u64::MAX",
                        )
                    },
                )?,
                ..current
            }
        } else {
            DesiredModuleState {
                enabled,
                selected_artifact,
                configuration_revision: current.configuration_revision.checked_add(1).ok_or_else(
                    || {
                        ControlError::new(
                            REVISION_INVALID,
                            "Module configuration revision cannot advance beyond u64::MAX",
                        )
                    },
                )?,
                ..current
            }
        });
        let mut operation = registry
            .commit(&RegistryMutation {
                request_id: Uuid::new_v4(),
                module_id: module_id.to_string(),
                instance_id: self.instance_id,
                kind,
                artifacts: Vec::new(),
                desired,
                observations: Vec::new(),
            })
            .map_err(registry_error)?;
        operation.transitions.push(ModuleTransition {
            phase: ModuleOperationPhase::Reconciling,
            registry_revision: Some(operation.target_registry_revision),
            diagnostics: Vec::new(),
        });
        operation.result = ModuleOperationResult::Pending;
        self.registry_revisions
            .send_replace(operation.target_registry_revision);
        Ok(operation)
    }

    /// Resolve the enabled dynamic artifacts selected by the current durable
    /// desired revision. The frontend supervisor observes revisions and uses
    /// this read-only projection to build a private candidate graph.
    pub fn runtime_modules(&self) -> Result<RuntimeModuleCatalog, ControlError> {
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
            modules.push(self.runtime_descriptor(selected, entry));
        }
        modules.sort_by(|left, right| left.module_id.cmp(&right.module_id));
        let last_applied = snapshot.runtime_acceptance.as_ref().map(|accepted| {
            let mut modules = accepted
                .artifacts
                .iter()
                .filter_map(|identity| {
                    snapshot
                        .runtime_artifacts
                        .iter()
                        .find(|entry| entry.identity() == *identity)
                        .map(|entry| self.runtime_descriptor(identity, entry))
                })
                .collect::<Vec<_>>();
            modules.sort_by(|left, right| left.module_id.cmp(&right.module_id));
            AppliedRuntimeModuleCatalog {
                registry_revision: accepted.registry_revision,
                modules,
            }
        });
        Ok(RuntimeModuleCatalog {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            registry_revision: snapshot.registry_revision,
            modules,
            last_applied,
        })
    }

    fn runtime_descriptor(
        &self,
        identity: &ModuleIdentity,
        entry: &super::registry::RuntimeArtifactCatalogEntry,
    ) -> RuntimeModuleDescriptor {
        let manifest = entry.artifact.canonical_metadata().manifest;
        let artifact_root = self
            .paths
            .module_artifact_root
            .join(&identity.content_digest);
        RuntimeModuleDescriptor {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            module_id: identity.id.clone(),
            version: identity.version.clone(),
            content_digest: identity.content_digest.clone(),
            entry_path: artifact_root.join(&manifest.entry),
            style_paths: manifest
                .styles
                .iter()
                .map(|style| artifact_root.join(style))
                .collect(),
            capabilities: manifest.capabilities.clone(),
            manifest,
        }
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
        let activation = runtime
            .as_ref()
            .and_then(|runtime| runtime.activation_outcomes.get(module_id));
        let observed = live
            .map(|module| vec![module.observed.clone()])
            .unwrap_or_default();
        let contributions = live
            .map(|module| module.contributions.clone())
            .unwrap_or_default();
        let diagnostics = self.module_diagnostics(&snapshot, module_id, live, activation);

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
        match runtime.as_ref() {
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
        let accepted_revision = runtime
            .as_ref()
            .map(|runtime| runtime.registry_revision)
            .or_else(|| {
                snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.runtime_acceptance.as_ref())
                    .map(|accepted| accepted.registry_revision)
            });
        if let Ok(failures) = self.reconciliation_failures.read() {
            diagnostics.extend(
                failures
                    .values()
                    .filter(|failure| {
                        accepted_revision
                            .is_none_or(|revision| failure.registry_revision > revision)
                    })
                    .map(|failure| reconciliation_failure_diagnostic(self.instance_id, failure)),
            );
        }
        diagnostics
    }

    pub fn inspect_operation(&self, operation_id: Uuid) -> Result<ModuleOperation, ControlError> {
        let mut operation = self
            .read_snapshot()
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
            })?;
        let applied_revision = self
            .runtime
            .read()
            .ok()
            .and_then(|runtime| runtime.as_ref().map(|runtime| runtime.registry_revision));
        let failure = self
            .reconciliation_failures
            .read()
            .ok()
            .and_then(|failures| failures.get(&operation.target_registry_revision).cloned());
        if applied_revision.is_some_and(|revision| revision >= operation.target_registry_revision) {
            operation.transitions.extend([
                ModuleTransition {
                    phase: ModuleOperationPhase::Published,
                    registry_revision: Some(operation.target_registry_revision),
                    diagnostics: Vec::new(),
                },
                ModuleTransition {
                    phase: ModuleOperationPhase::Draining,
                    registry_revision: Some(operation.target_registry_revision),
                    diagnostics: Vec::new(),
                },
                ModuleTransition {
                    phase: ModuleOperationPhase::Completed,
                    registry_revision: Some(operation.target_registry_revision),
                    diagnostics: Vec::new(),
                },
            ]);
            operation.result = ModuleOperationResult::Succeeded;
        } else if let Some(failure) = failure {
            operation.transitions.push(ModuleTransition {
                phase: ModuleOperationPhase::Failed,
                registry_revision: Some(operation.target_registry_revision),
                diagnostics: vec![reconciliation_failure_diagnostic(
                    self.instance_id,
                    &failure,
                )],
            });
            operation.result = ModuleOperationResult::Failed;
        } else {
            operation.transitions.push(ModuleTransition {
                phase: ModuleOperationPhase::Reconciling,
                registry_revision: Some(operation.target_registry_revision),
                diagnostics: Vec::new(),
            });
            operation.result = ModuleOperationResult::Pending;
        }
        Ok(operation)
    }

    pub fn report_reconciliation_failure(
        &self,
        failure: ReconciliationFailureInput,
    ) -> Result<(), ControlError> {
        if failure.schema_version != MODULE_CONTROL_SCHEMA_VERSION
            || failure.code.trim().is_empty()
            || failure.message.trim().is_empty()
        {
            return Err(snapshot_error("Reconciliation failure input is invalid"));
        }
        let current_revision = self
            .read_snapshot()
            .map_err(registry_error)?
            .registry_revision;
        if failure.registry_revision > current_revision {
            return Err(ControlError::new(
                REVISION_INVALID,
                "Rejected runtime revision is ahead of durable registry truth",
            )
            .with_expected_observed(
                current_revision.to_string(),
                failure.registry_revision.to_string(),
            ));
        }
        ModuleRegistry::open_writable(&self.paths)
            .and_then(|mut registry| {
                registry.record_reconciliation_failure(&ReconciliationFailureRecord {
                    schema_version: failure.schema_version,
                    registry_revision: failure.registry_revision,
                    module_id: failure.module_id.clone(),
                    activation_id: failure.activation_id.clone(),
                    phase: reconciliation_failure_phase_name(failure.phase).to_string(),
                    code: failure.code.clone(),
                    message: failure.message.clone(),
                })
            })
            .map_err(registry_error)?;
        self.reconciliation_failures
            .write()
            .map_err(|_| snapshot_error("Reconciliation failure lock is unavailable"))?
            .insert(failure.registry_revision, failure);
        Ok(())
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
        if input.registry_revision > registry.registry_revision {
            return Err(ControlError::new(
                REVISION_INVALID,
                "Frontend runtime revision is ahead of durable registry truth",
            )
            .with_expected_observed(
                registry.registry_revision.to_string(),
                input.registry_revision.to_string(),
            ));
        }
        if self
            .runtime
            .read()
            .map_err(|_| snapshot_error("The host runtime snapshot lock is unavailable"))?
            .as_ref()
            .is_some_and(|runtime| runtime.registry_revision > input.registry_revision)
        {
            return Err(ControlError::new(
                REVISION_INVALID,
                "Frontend runtime revision cannot move backwards",
            ));
        }
        let static_inventory = registry
            .static_inventory
            .iter()
            .filter(|record| record.frontend_shipped)
            .map(|record| (record.identity.id.clone(), record.identity.clone()))
            .collect::<BTreeMap<_, _>>();
        let mut activation_inventory = BTreeMap::new();
        let mut module_ids = BTreeSet::new();
        let mut contribution_identities = BTreeSet::new();
        let mut modules = BTreeMap::new();
        let mut dynamic_artifacts = Vec::new();

        for module in input.modules {
            if !module_ids.insert(module.module_id.clone()) {
                return Err(snapshot_error(format!(
                    "Module {} appears more than once",
                    module.module_id
                )));
            }
            let artifact = if let Some(content_digest) = module.artifact_content_digest.as_ref() {
                let entry = registry
                    .runtime_artifacts
                    .iter()
                    .find(|entry| {
                        let identity = entry.identity();
                        identity.id == module.module_id
                            && identity.content_digest == *content_digest
                    })
                    .ok_or_else(|| {
                        snapshot_error(format!(
                            "Module {} does not identify an admitted runtime artifact",
                            module.module_id
                        ))
                    })?;
                let canonical = entry.artifact.canonical_metadata();
                let manifest = &canonical.manifest;
                activation_inventory.insert(
                    module.module_id.clone(),
                    (
                        manifest.messages.handles.len()
                            + manifest.messages.publishes.len()
                            + manifest.messages.subscribes.len()
                            + manifest.messages.ports.len(),
                        manifest.capabilities.definitions.len(),
                    ),
                );
                let identity = entry.identity();
                dynamic_artifacts.push(identity.clone());
                identity
            } else {
                static_inventory
                    .get(&module.module_id)
                    .cloned()
                    .ok_or_else(|| {
                        snapshot_error(format!(
                            "Module {} is not a frontend contribution in this host build",
                            module.module_id
                        ))
                    })?
            };
            let module_instance_id = module
                .activation_id
                .unwrap_or_else(|| format!("frontend:{}:{}", module.module_id, Uuid::new_v4()));
            let mut contributions = Vec::with_capacity(module.contributions.len());
            for contribution in module.contributions {
                if contribution.id.trim().is_empty()
                    || !valid_frontend_contribution_id(&contribution.kind, &contribution.id)
                    || contribution.kind.trim().is_empty()
                    || !contribution_identities
                        .insert((contribution.kind.clone(), contribution.id.clone()))
                {
                    return Err(snapshot_error(format!(
                        "Contribution {}:{} has an invalid or duplicate identity",
                        contribution.kind, contribution.id
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
                        artifact: Some(artifact),
                        applied_registry_revision: input.registry_revision,
                        lifecycle: ModuleLifecycleState::Active,
                        module_instance_id: Some(module_instance_id),
                    },
                    contributions,
                },
            );
        }

        let activation_outcomes = activation_observations(
            &activation_inventory,
            &module_ids,
            input.activation_outcomes,
        )?;

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
        ModuleRegistry::open_writable(&self.paths)
            .and_then(|mut registry| {
                registry.record_runtime_acceptance(&RuntimeAcceptanceRecord {
                    schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                    registry_revision: input.registry_revision,
                    artifacts: dynamic_artifacts,
                })
            })
            .map_err(registry_error)?;
        *self
            .runtime
            .write()
            .map_err(|_| snapshot_error("The host runtime snapshot lock is unavailable"))? =
            Some(RuntimeSnapshot {
                registry_revision: input.registry_revision,
                published_at_unix_ms,
                modules,
                activation_outcomes,
            });

        Ok(RuntimeSnapshotReceipt {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            instance_id: self.instance_id,
            registry_revision: input.registry_revision,
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
        activation: Option<&RuntimeActivationObservation>,
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
        match (live, activation) {
            (Some(live), activation) => {
                diagnostics.push(activation_diagnostic(
                    MODULE_ACTIVE,
                    DiagnosticSeverity::Info,
                    "module_activation",
                    format!("Module {module_id} is active in the frontend host"),
                    self.instance_id,
                    module_id,
                    Some(registry.registry_revision),
                    activation,
                ));
                diagnostics.extend(revision_diagnostics(
                    self.instance_id,
                    registry.registry_revision,
                    live.observed.applied_registry_revision,
                ));
            }
            (None, Some(activation)) if activation.status == RuntimeActivationStatus::Failed => {
                diagnostics.push(activation_diagnostic(
                    MODULE_STARTUP_FAILED,
                    DiagnosticSeverity::Error,
                    "module_activation",
                    format!("Module {module_id} failed during runtime activation"),
                    self.instance_id,
                    module_id,
                    Some(registry.registry_revision),
                    Some(activation),
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
        let accepted_revision = live
            .map(|live| live.observed.applied_registry_revision)
            .or_else(|| {
                registry
                    .runtime_acceptance
                    .as_ref()
                    .map(|accepted| accepted.registry_revision)
            });
        if let Ok(failures) = self.reconciliation_failures.read() {
            diagnostics.extend(
                failures
                    .values()
                    .filter(|failure| {
                        accepted_revision
                            .is_none_or(|revision| failure.registry_revision > revision)
                            && failure
                                .module_id
                                .as_deref()
                                .is_none_or(|failed_module| failed_module == module_id)
                    })
                    .map(|failure| reconciliation_failure_diagnostic(self.instance_id, failure)),
            );
        }
        diagnostics
    }
}

fn publish_current_registry_revision(paths: &ShipctlPaths, revisions: &watch::Sender<u64>) {
    let Ok(registry) = ModuleRegistry::open_read_only(paths) else {
        return;
    };
    let Ok(revision) = registry.revision() else {
        return;
    };
    revisions.send_if_modified(|current| {
        if revision <= *current {
            return false;
        }
        *current = revision;
        true
    });
}

fn revision_target_error(
    service: &ModuleControlService,
    expected: u64,
    observed: u64,
) -> ControlError {
    ControlError::new(
        REVISION_INVALID,
        "Requested target revision does not match the next durable registry revision",
    )
    .with_expected_observed(expected.to_string(), observed.to_string())
    .for_context(service.instance_id, service.paths.state_root.clone())
}

fn completed_no_op_operation(
    instance_id: Uuid,
    module_id: &str,
    kind: ModuleOperationKind,
    revision: u64,
) -> ModuleOperation {
    ModuleOperation {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        request_id: Uuid::nil(),
        module_id: module_id.to_string(),
        instance_id,
        kind,
        target_registry_revision: revision,
        transitions: vec![ModuleTransition {
            phase: ModuleOperationPhase::Completed,
            registry_revision: Some(revision),
            diagnostics: Vec::new(),
        }],
        result: ModuleOperationResult::Succeeded,
    }
}

fn reconciliation_failure_diagnostic(
    instance_id: Uuid,
    failure: &ReconciliationFailureInput,
) -> Diagnostic {
    let phase = serde_json::to_value(failure.phase)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string());
    let mut fields = BTreeMap::from([
        ("instanceId".to_string(), instance_id.to_string()),
        (
            "registryRevision".to_string(),
            failure.registry_revision.to_string(),
        ),
        ("phase".to_string(), phase),
        ("frontendCode".to_string(), failure.code.clone()),
    ]);
    if let Some(module_id) = failure.module_id.as_ref() {
        fields.insert("moduleId".to_string(), module_id.clone());
    }
    if let Some(activation_id) = failure.activation_id.as_ref() {
        fields.insert("activationId".to_string(), activation_id.clone());
    }
    Diagnostic {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        code: RECONCILIATION_FAILED.to_string(),
        severity: DiagnosticSeverity::Error,
        check: "runtime_reconciliation".to_string(),
        summary: failure.message.clone(),
        evidence: RedactedEvidence { fields },
        remedy: Some(
            "Inspect the rejected artifact and retry with a new registry revision".to_string(),
        ),
    }
}

fn reconciliation_failure_phase_name(phase: ReconciliationFailurePhase) -> &'static str {
    match phase {
        ReconciliationFailurePhase::Observe => "observe",
        ReconciliationFailurePhase::Prepare => "prepare",
        ReconciliationFailurePhase::Validate => "validate",
        ReconciliationFailurePhase::Publish => "publish",
        ReconciliationFailurePhase::Dispose => "dispose",
    }
}

fn reconciliation_failure_input(
    record: ReconciliationFailureRecord,
) -> Option<ReconciliationFailureInput> {
    let phase = match record.phase.as_str() {
        "observe" => ReconciliationFailurePhase::Observe,
        "prepare" => ReconciliationFailurePhase::Prepare,
        "validate" => ReconciliationFailurePhase::Validate,
        "publish" => ReconciliationFailurePhase::Publish,
        "dispose" => ReconciliationFailurePhase::Dispose,
        _ => return None,
    };
    Some(ReconciliationFailureInput {
        schema_version: record.schema_version,
        registry_revision: record.registry_revision,
        module_id: record.module_id,
        activation_id: record.activation_id,
        phase,
        code: record.code,
        message: record.message,
    })
}

fn activation_observations(
    inventory: &BTreeMap<String, (usize, usize)>,
    active_module_ids: &BTreeSet<String>,
    reported: Vec<FrontendRuntimeActivationInput>,
) -> Result<BTreeMap<String, RuntimeActivationObservation>, ControlError> {
    let mut observations = BTreeMap::new();
    for activation in reported {
        let Some((route_count, capability_count)) = inventory.get(&activation.module_id).copied()
        else {
            return Err(snapshot_error(format!(
                "Module {} is not a selected runtime artifact",
                activation.module_id
            )));
        };
        if observations.contains_key(&activation.module_id) {
            return Err(snapshot_error(format!(
                "Module {} has more than one activation outcome",
                activation.module_id
            )));
        }
        let active = active_module_ids.contains(&activation.module_id);
        let valid = match (activation.status, activation.phase, active) {
            (RuntimeActivationStatus::Active, RuntimeActivationPhase::Active, true) => true,
            (RuntimeActivationStatus::Failed, phase, false)
                if phase != RuntimeActivationPhase::Active =>
            {
                true
            }
            _ => false,
        };
        if !valid {
            return Err(snapshot_error(format!(
                "Module {} activation outcome disagrees with the active runtime snapshot",
                activation.module_id
            )));
        }
        observations.insert(
            activation.module_id,
            RuntimeActivationObservation {
                status: activation.status,
                phase: activation.phase,
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
                "Active module {module_id} is missing its activation outcome"
            )));
        }
        observations.insert(
            module_id.clone(),
            RuntimeActivationObservation {
                status: RuntimeActivationStatus::Failed,
                phase: RuntimeActivationPhase::Descriptor,
                route_count: *route_count,
                capability_count: *capability_count,
            },
        );
    }
    Ok(observations)
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

fn activation_diagnostic(
    code: &str,
    severity: DiagnosticSeverity,
    check: &str,
    summary: String,
    instance_id: Uuid,
    module_id: &str,
    registry_revision: Option<u64>,
    activation: Option<&RuntimeActivationObservation>,
) -> Diagnostic {
    let mut fields = BTreeMap::from([
        ("instanceId".to_string(), instance_id.to_string()),
        ("moduleId".to_string(), module_id.to_string()),
    ]);
    if let Some(revision) = registry_revision {
        fields.insert("registryRevision".to_string(), revision.to_string());
    }
    if let Some(activation) = activation {
        let phase = serde_json::to_value(activation.phase)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| "unknown".to_string());
        fields.insert("phase".to_string(), phase);
        fields.insert("routeCount".to_string(), activation.route_count.to_string());
        fields.insert(
            "capabilityCount".to_string(),
            activation.capability_count.to_string(),
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

    #[tokio::test]
    async fn external_registry_commit_notifies_the_running_service() {
        let (_root, running, artifact) = service();
        let mut revisions = running.observe_registry_revisions();
        let initial_revision = *revisions.borrow();
        let mut external = ModuleRegistry::open_writable(&running.paths).unwrap();
        let operation = external
            .commit(&RegistryMutation {
                request_id: Uuid::new_v4(),
                module_id: artifact.id.clone(),
                instance_id: Uuid::new_v4(),
                kind: ModuleOperationKind::Disable,
                artifacts: Vec::new(),
                desired: Some(DesiredModuleState {
                    schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                    module_id: artifact.id,
                    selected_artifact: None,
                    enabled: false,
                    configuration_revision: 1,
                }),
                observations: Vec::new(),
            })
            .unwrap();
        drop(external);

        revisions.changed().await.unwrap();

        assert_eq!(operation.target_registry_revision, initial_revision + 1);
        assert_eq!(*revisions.borrow_and_update(), initial_revision + 1);
    }

    #[tokio::test]
    async fn live_remove_notifies_and_survives_a_new_process_incarnation() {
        let (_root, initial, artifact) = service();
        let mut registry = ModuleRegistry::open_writable(&initial.paths).unwrap();
        registry
            .commit(&RegistryMutation {
                request_id: Uuid::new_v4(),
                module_id: artifact.id.clone(),
                instance_id: initial.instance_id,
                kind: ModuleOperationKind::Enable,
                artifacts: vec![ArtifactAcquisition {
                    identity: artifact.clone(),
                    source: ModuleSource::Bundled,
                }],
                desired: Some(DesiredModuleState {
                    schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                    module_id: artifact.id.clone(),
                    selected_artifact: Some(artifact.clone()),
                    enabled: true,
                    configuration_revision: 1,
                }),
                observations: Vec::new(),
            })
            .unwrap();
        let enabled_revision = registry.revision().unwrap();
        drop(registry);

        let running =
            ModuleControlService::initialize(initial.paths.clone(), Uuid::new_v4()).unwrap();
        let mut revisions = running.observe_registry_revisions();
        assert_eq!(*revisions.borrow(), enabled_revision);
        let removed_revision = enabled_revision + 1;
        let operation = running
            .transition_module(
                &artifact.id,
                ModuleOperationKind::Remove,
                removed_revision,
                None,
            )
            .unwrap();
        revisions.changed().await.unwrap();

        assert_eq!(*revisions.borrow_and_update(), removed_revision);
        assert_eq!(operation.target_registry_revision, removed_revision);
        let snapshot = ModuleRegistry::open_read_only(&running.paths)
            .unwrap()
            .snapshot()
            .unwrap();
        let removed = snapshot
            .desired
            .iter()
            .find(|state| state.module_id == artifact.id)
            .unwrap();
        assert!(!removed.enabled);
        assert!(removed.selected_artifact.is_none());

        let restarted =
            ModuleControlService::initialize(running.paths.clone(), Uuid::new_v4()).unwrap();
        assert_eq!(restarted.status().registry_revision, Some(removed_revision));
        assert!(restarted.runtime_modules().unwrap().modules.is_empty());
    }

    #[test]
    fn frontend_snapshot_is_host_enriched_and_joined_with_registry_truth() {
        let (_root, service, artifact) = service();
        let registry_revision = service.status().registry_revision.unwrap();
        let receipt = service
            .publish_frontend_snapshot(FrontendRuntimeSnapshotInput {
                schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                registry_revision,
                modules: vec![FrontendModuleRuntimeInput {
                    module_id: "shipctl.test".to_string(),
                    artifact_content_digest: None,
                    activation_id: Some("shipctl.test@1.0.0#static".to_string()),
                    contributions: vec![FrontendContributionInput {
                        id: "test.panel".to_string(),
                        kind: "panel".to_string(),
                    }],
                }],
                activation_outcomes: Vec::new(),
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
        assert_eq!(
            inspection.contributions[0].owner_instance_id.as_deref(),
            Some("shipctl.test@1.0.0#static")
        );
        assert!(inspection
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == MODULE_ACTIVE));
        assert_eq!(service.status().revision_lag, Some(0));
    }

    #[test]
    fn contribution_identity_includes_kind_and_id() {
        let (_root, first_service, _artifact) = service();
        let first_revision = first_service.status().registry_revision.unwrap();
        let receipt = first_service
            .publish_frontend_snapshot(FrontendRuntimeSnapshotInput {
                schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                registry_revision: first_revision,
                modules: vec![FrontendModuleRuntimeInput {
                    module_id: "shipctl.test".to_string(),
                    artifact_content_digest: None,
                    activation_id: None,
                    contributions: vec![
                        FrontendContributionInput {
                            id: "test.message".to_string(),
                            kind: "message_contract".to_string(),
                        },
                        FrontendContributionInput {
                            id: "test.message".to_string(),
                            kind: "message_handler".to_string(),
                        },
                    ],
                }],
                activation_outcomes: Vec::new(),
            })
            .unwrap();
        assert_eq!(receipt.contribution_count, 2);

        let (_root, second_service, _artifact) = service();
        let second_revision = second_service.status().registry_revision.unwrap();
        let error = second_service
            .publish_frontend_snapshot(FrontendRuntimeSnapshotInput {
                schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                registry_revision: second_revision,
                modules: vec![FrontendModuleRuntimeInput {
                    module_id: "shipctl.test".to_string(),
                    artifact_content_digest: None,
                    activation_id: None,
                    contributions: vec![
                        FrontendContributionInput {
                            id: "test.message".to_string(),
                            kind: "message_contract".to_string(),
                        },
                        FrontendContributionInput {
                            id: "test.message".to_string(),
                            kind: "message_contract".to_string(),
                        },
                    ],
                }],
                activation_outcomes: Vec::new(),
            })
            .unwrap_err();
        assert_eq!(error.code.as_str(), SNAPSHOT_INVALID);
    }

    #[test]
    fn frontend_snapshot_accepts_terminal_driver_contribution_identity() {
        let (_root, service, _artifact) = service();
        let registry_revision = service.status().registry_revision.unwrap();
        let receipt = service
            .publish_frontend_snapshot(FrontendRuntimeSnapshotInput {
                schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                registry_revision,
                modules: vec![FrontendModuleRuntimeInput {
                    module_id: "shipctl.test".to_string(),
                    artifact_content_digest: None,
                    activation_id: None,
                    contributions: vec![FrontendContributionInput {
                        id: "thin-terminal".to_string(),
                        kind: "terminal_presentation".to_string(),
                    }],
                }],
                activation_outcomes: Vec::new(),
            })
            .unwrap();

        assert_eq!(receipt.contribution_count, 1);
        assert_eq!(
            service.inspect("shipctl.test").unwrap().contributions[0].id,
            "thin-terminal"
        );
    }

    #[test]
    fn frontend_snapshot_rejects_unscoped_nonterminal_contribution_identity() {
        let (_root, service, _artifact) = service();
        let registry_revision = service.status().registry_revision.unwrap();
        let error = service
            .publish_frontend_snapshot(FrontendRuntimeSnapshotInput {
                schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                registry_revision,
                modules: vec![FrontendModuleRuntimeInput {
                    module_id: "shipctl.test".to_string(),
                    artifact_content_digest: None,
                    activation_id: None,
                    contributions: vec![FrontendContributionInput {
                        id: "unscoped".to_string(),
                        kind: "panel".to_string(),
                    }],
                }],
                activation_outcomes: Vec::new(),
            })
            .unwrap_err();

        assert_eq!(error.code.as_str(), SNAPSHOT_INVALID);
    }

    #[test]
    fn snapshot_rejects_unknown_frontend_identity() {
        let (_root, service, _artifact) = service();
        let registry_revision = service.status().registry_revision.unwrap();
        let error = service
            .publish_frontend_snapshot(FrontendRuntimeSnapshotInput {
                schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                registry_revision,
                modules: vec![FrontendModuleRuntimeInput {
                    module_id: "shipctl.unknown".to_string(),
                    artifact_content_digest: None,
                    activation_id: None,
                    contributions: Vec::new(),
                }],
                activation_outcomes: Vec::new(),
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
    fn missing_runtime_activation_outcome_becomes_a_descriptor_failure() {
        let observations = activation_observations(
            &BTreeMap::from([("shipctl.demo".to_string(), (3, 1))]),
            &BTreeSet::new(),
            Vec::new(),
        )
        .unwrap();
        let observation = observations.get("shipctl.demo").unwrap();

        assert_eq!(observation.status, RuntimeActivationStatus::Failed);
        assert_eq!(observation.phase, RuntimeActivationPhase::Descriptor);
        assert_eq!(observation.route_count, 3);
        assert_eq!(observation.capability_count, 1);
    }
}
