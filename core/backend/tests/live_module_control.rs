use std::{collections::BTreeMap, sync::Arc};

use serde_json::json;
use sha2::{Digest, Sha256};
use shipctl_core::instance::{
    ActiveWorkBlocker, ControlError, ControlHandler, ControlResponseResult, ControlServer,
    ControlStream, InstanceContext, InstanceDirectory, InstanceLaunchOptions, InstanceLeases,
    LaunchProvenance, ModuleCommand, OperationCommand,
};
use shipctl_core::module_control::artifact::{
    canonical_content_digest, ArtifactIntegrityFile, ArtifactIntegrityIndex,
    RuntimeArtifactArchive, RuntimeArtifactManifest, ARTIFACT_CONTRACT_SCHEMA_VERSION,
};
use shipctl_core::module_control::codes::{
    RECONCILIATION_FAILED, REGISTRY_HEALTHY, SNAPSHOT_UNAVAILABLE,
};
use shipctl_core::module_control::live::{
    FrontendModuleRuntimeInput, FrontendRuntimeActivationInput, FrontendRuntimeSnapshotInput,
    ModuleControlService, ReconciliationFailureInput, ReconciliationFailurePhase,
    RuntimeActivationPhase, RuntimeActivationStatus,
};
use shipctl_core::module_control::registry::{
    ArtifactAcquisition, BuildModuleMembership, ModuleRegistry, RegistryMutation,
    RuntimeArtifactRegistration, StaticBuildInventory,
};
use shipctl_core::module_control::{
    DesiredModuleState, ModuleOperationKind, ModuleOperationResult, ModuleRuntimeKind,
    ModuleSource, MODULE_CONTROL_SCHEMA_VERSION,
};
use uuid::Uuid;

struct RegistryControlHandler {
    service: ModuleControlService,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn runtime_artifact(
    version: &str,
    source: &str,
) -> shipctl_core::module_control::artifact::ValidatedRuntimeArtifact {
    let manifest_value = json!({
        "schemaVersion": ARTIFACT_CONTRACT_SCHEMA_VERSION,
        "id": "shipctl.live-replace",
        "name": "Live replacement fixture",
        "version": version,
        "apiRange": "^1.0.0",
        "runtimeKind": ModuleRuntimeKind::FrontendEsm,
        "entry": "dist/index.js",
        "messages": {
            "schemaVersion": 1,
            "provides": [],
            "handles": [],
            "publishes": [],
            "subscribes": [],
            "ports": []
        },
        "capabilities": {
            "schemaVersion": 1,
            "definitions": [],
            "providers": [],
            "consumers": []
        },
        "application": {
            "schemaVersion": 1,
            "role": "headless",
            "requiredServices": [],
            "providedServices": [],
            "backgroundEffects": [],
            "contributions": []
        },
        "lifecycle": "live"
    });
    let manifest: RuntimeArtifactManifest = serde_json::from_value(manifest_value.clone()).unwrap();
    let mut files = BTreeMap::from([
        (
            "dist/index.js".to_string(),
            format!("export const source = {source:?};").into_bytes(),
        ),
        (
            "module.yaml".to_string(),
            serde_yaml::to_string(&manifest_value).unwrap().into_bytes(),
        ),
    ]);
    let integrity_files = files
        .iter()
        .map(|(path, contents)| ArtifactIntegrityFile {
            path: path.clone(),
            digest_sha256: sha256_hex(contents),
        })
        .collect::<Vec<_>>();
    let content_digest = canonical_content_digest(&manifest, &integrity_files).unwrap();
    files.insert(
        "integrity.json".to_string(),
        serde_json::to_vec(&ArtifactIntegrityIndex {
            schema_version: ARTIFACT_CONTRACT_SCHEMA_VERSION,
            files: integrity_files,
            content_digest_sha256: content_digest,
        })
        .unwrap(),
    );
    RuntimeArtifactArchive::new(files)
        .unwrap()
        .inspect()
        .unwrap()
}

impl ControlHandler for RegistryControlHandler {
    fn active_work(&self) -> Vec<ActiveWorkBlocker> {
        Vec::new()
    }

    fn module_control_status(&self) -> shipctl_core::instance::ModuleControlStatus {
        self.service.status()
    }

    fn instance_diagnostics(&self) -> Vec<shipctl_core::module_control::Diagnostic> {
        self.service.diagnose_instance()
    }

    fn module_control(&self, command: ModuleCommand) -> Result<ControlStream, ControlError> {
        match command {
            ModuleCommand::Inspect { module_id } => Ok(ControlStream::result(
                ControlResponseResult::ModuleInspection(self.service.inspect(&module_id)?),
            )),
            ModuleCommand::Diagnose { module_id } => Ok(ControlStream::result(
                ControlResponseResult::ModuleDiagnostics(self.service.diagnose_module(&module_id)?),
            )),
            ModuleCommand::Lifecycle {
                module_id,
                kind,
                target_registry_revision,
                artifact_content_digest,
            } => {
                let operation = self.service.transition_module(
                    &module_id,
                    kind,
                    target_registry_revision,
                    artifact_content_digest.as_deref(),
                )?;
                Ok(ControlStream {
                    result: ControlResponseResult::ModuleOperation(operation.clone()),
                    events: vec![
                        shipctl_core::instance::ControlEventPayload::ModuleOperation(operation),
                    ],
                })
            }
        }
    }

    fn operation_control(&self, command: OperationCommand) -> Result<ControlStream, ControlError> {
        let OperationCommand::Inspect { operation_id } = command;
        Ok(ControlStream::result(
            ControlResponseResult::ModuleOperation(self.service.inspect_operation(operation_id)?),
        ))
    }

    fn shutdown(&self, _force: bool) -> Result<(), ControlError> {
        Ok(())
    }
}

#[test]
fn named_socket_mutation_exposes_pending_failure_and_applied_operation_states() {
    let root = tempfile::tempdir().unwrap();
    let context = InstanceContext::resolve(
        InstanceLaunchOptions {
            name: Some("registry-live".to_string()),
            state_root: Some(root.path().join("state")),
            runtime_root: Some(root.path().join("runtime")),
            load_state: None,
            provenance: Some(LaunchProvenance::Cli),
        },
        "live-registry-test",
    )
    .unwrap();
    let paths = context.paths();
    let inventory = StaticBuildInventory::from_build_composition(
        "live-registry-test",
        "1.0.0",
        vec![BuildModuleMembership {
            module_id: "shipctl.test".to_string(),
            native_compiled: true,
            frontend_shipped: true,
        }],
    )
    .unwrap();
    let artifact = inventory.modules[0].identity.clone();
    let operation_id = Uuid::new_v4();
    let mut registry = ModuleRegistry::open_writable(&paths).unwrap();
    registry.seed_static_inventory(&inventory).unwrap();
    registry
        .commit(&RegistryMutation {
            request_id: operation_id,
            module_id: artifact.id.clone(),
            instance_id: context.instance_id,
            kind: ModuleOperationKind::Enable,
            artifacts: vec![ArtifactAcquisition {
                identity: artifact.clone(),
                source: ModuleSource::Bundled,
            }],
            desired: Some(DesiredModuleState {
                schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                module_id: artifact.id.clone(),
                selected_artifact: Some(artifact),
                enabled: true,
                configuration_revision: 1,
            }),
            observations: Vec::new(),
        })
        .unwrap();
    let service = ModuleControlService::initialize(paths.clone(), context.instance_id).unwrap();
    let applied_revision = service.status().registry_revision.unwrap();
    service
        .publish_frontend_snapshot(FrontendRuntimeSnapshotInput {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            registry_revision: applied_revision,
            modules: vec![FrontendModuleRuntimeInput {
                module_id: "shipctl.test".to_string(),
                artifact_content_digest: None,
                activation_id: Some("shipctl.test@1.0.0#static".to_string()),
                contributions: Vec::new(),
            }],
            activation_outcomes: Vec::new(),
        })
        .unwrap();
    let server = ControlServer::start(
        context.clone(),
        Arc::new(InstanceLeases::acquire(&context).unwrap()),
        Arc::new(RegistryControlHandler {
            service: service.clone(),
        }),
    )
    .unwrap();
    let directory = InstanceDirectory::new(context.runtime_root.clone(), context.build.clone());

    let instance = directory.inspect(Some("registry-live")).unwrap();
    assert!(instance.module_control.registry_available);
    assert!(instance.module_control.registry_revision.is_some());
    assert!(instance.module_control.runtime_snapshot_available);

    let inspection = directory
        .inspect_module(Some("registry-live"), "shipctl.test".to_string())
        .unwrap();
    assert!(inspection.desired.enabled);
    assert_eq!(inspection.desired.configuration_revision, 1);
    assert_eq!(inspection.observed.len(), 1);

    let report = directory.diagnose(Some("registry-live")).unwrap();
    assert!(report.healthy);
    assert!(report
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == REGISTRY_HEALTHY));
    assert!(!report
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == SNAPSHOT_UNAVAILABLE));

    let disable_revision = instance.module_control.registry_revision.unwrap() + 1;
    let disabled = directory
        .transition_module_stream(
            Some("registry-live"),
            "shipctl.test".to_string(),
            ModuleOperationKind::Disable,
            disable_revision,
            None,
        )
        .unwrap();
    assert_eq!(disabled.events.len(), 1);
    let ControlResponseResult::ModuleOperation(disabled) = disabled.result else {
        panic!("module transition did not return an operation")
    };
    assert_eq!(disabled.result, ModuleOperationResult::Pending);
    assert_eq!(disabled.target_registry_revision, disable_revision);

    service
        .report_reconciliation_failure(ReconciliationFailureInput {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            registry_revision: disable_revision,
            module_id: Some("shipctl.test".to_string()),
            activation_id: Some(format!("shipctl.test@{}#rejected", disable_revision)),
            phase: ReconciliationFailurePhase::Validate,
            code: "module.runtime.fixture_rejected".to_string(),
            message: "Fixture candidate did not validate".to_string(),
        })
        .unwrap();
    let failed = directory
        .inspect_operation(Some("registry-live"), disabled.request_id)
        .unwrap();
    assert_eq!(failed.result, ModuleOperationResult::Failed);
    assert!(failed.transitions.iter().any(|transition| {
        transition
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == RECONCILIATION_FAILED)
    }));
    let retained = directory
        .inspect_module(Some("registry-live"), "shipctl.test".to_string())
        .unwrap();
    assert_eq!(
        retained.observed[0].applied_registry_revision,
        applied_revision
    );

    let operation = directory
        .inspect_operation(Some("registry-live"), operation_id)
        .unwrap();
    assert_eq!(operation.request_id, operation_id);
    assert_eq!(operation.instance_id, context.instance_id);

    let restarted = ModuleControlService::initialize(paths, Uuid::new_v4()).unwrap();
    let recovered_catalog = restarted.runtime_modules().unwrap();
    let last_applied = recovered_catalog.last_applied.unwrap();
    assert_eq!(last_applied.registry_revision, applied_revision);
    assert!(last_applied.modules.is_empty());
    assert!(restarted
        .diagnose_instance()
        .iter()
        .any(|diagnostic| diagnostic.code == RECONCILIATION_FAILED));

    drop(server);
}

#[test]
fn named_socket_replaces_one_admitted_digest_without_restart() {
    let root = tempfile::tempdir().unwrap();
    let context = InstanceContext::resolve(
        InstanceLaunchOptions {
            name: Some("registry-replace".to_string()),
            state_root: Some(root.path().join("state")),
            runtime_root: Some(root.path().join("runtime")),
            load_state: None,
            provenance: Some(LaunchProvenance::Cli),
        },
        "live-replace-test",
    )
    .unwrap();
    let paths = context.paths();
    let first = runtime_artifact("1.0.0", "first");
    let second = runtime_artifact("1.1.0", "second");
    assert_ne!(first.content_digest, second.content_digest);

    let mut registry = ModuleRegistry::open_writable(&paths).unwrap();
    registry
        .register_disabled_artifact(&RuntimeArtifactRegistration {
            request_id: Uuid::new_v4(),
            artifact: first.clone(),
            source: ModuleSource::User,
        })
        .unwrap();
    registry
        .register_disabled_artifact(&RuntimeArtifactRegistration {
            request_id: Uuid::new_v4(),
            artifact: second.clone(),
            source: ModuleSource::User,
        })
        .unwrap();
    let service = ModuleControlService::initialize(paths.clone(), context.instance_id).unwrap();
    let enabled = service
        .transition_module("shipctl.live-replace", ModuleOperationKind::Enable, 3, None)
        .unwrap();
    assert_eq!(enabled.target_registry_revision, 3);
    service
        .publish_frontend_snapshot(FrontendRuntimeSnapshotInput {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            registry_revision: 3,
            modules: vec![FrontendModuleRuntimeInput {
                module_id: "shipctl.live-replace".to_string(),
                artifact_content_digest: Some(first.content_digest.clone()),
                activation_id: Some(format!(
                    "shipctl.live-replace@1.0.0#{}",
                    first.content_digest
                )),
                contributions: Vec::new(),
            }],
            activation_outcomes: vec![FrontendRuntimeActivationInput {
                module_id: "shipctl.live-replace".to_string(),
                status: RuntimeActivationStatus::Active,
                phase: RuntimeActivationPhase::Active,
            }],
        })
        .unwrap();

    let server = ControlServer::start(
        context.clone(),
        Arc::new(InstanceLeases::acquire(&context).unwrap()),
        Arc::new(RegistryControlHandler {
            service: service.clone(),
        }),
    )
    .unwrap();
    let directory = InstanceDirectory::new(context.runtime_root.clone(), context.build.clone());
    let replaced = directory
        .transition_module_stream(
            Some("registry-replace"),
            "shipctl.live-replace".to_string(),
            ModuleOperationKind::Update,
            4,
            Some(second.content_digest.clone()),
        )
        .unwrap();
    let ControlResponseResult::ModuleOperation(replaced) = replaced.result else {
        panic!("module replacement did not return an operation")
    };
    assert_eq!(replaced.result, ModuleOperationResult::Pending);
    assert_eq!(replaced.target_registry_revision, 4);
    let desired = service.runtime_modules().unwrap();
    assert_eq!(desired.registry_revision, 4);
    assert_eq!(desired.modules[0].content_digest, second.content_digest);

    service
        .publish_frontend_snapshot(FrontendRuntimeSnapshotInput {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            registry_revision: 4,
            modules: vec![FrontendModuleRuntimeInput {
                module_id: "shipctl.live-replace".to_string(),
                artifact_content_digest: Some(second.content_digest.clone()),
                activation_id: Some(format!(
                    "shipctl.live-replace@1.1.0#{}",
                    second.content_digest
                )),
                contributions: Vec::new(),
            }],
            activation_outcomes: vec![FrontendRuntimeActivationInput {
                module_id: "shipctl.live-replace".to_string(),
                status: RuntimeActivationStatus::Active,
                phase: RuntimeActivationPhase::Active,
            }],
        })
        .unwrap();
    let completed = directory
        .inspect_operation(Some("registry-replace"), replaced.request_id)
        .unwrap();
    assert_eq!(completed.result, ModuleOperationResult::Succeeded);

    let unknown = "f".repeat(64);
    let error = directory
        .transition_module_stream(
            Some("registry-replace"),
            "shipctl.live-replace".to_string(),
            ModuleOperationKind::Update,
            5,
            Some(unknown),
        )
        .unwrap_err();
    assert_eq!(
        error.code.as_str(),
        shipctl_core::module_control::codes::MODULE_ABSENT
    );
    assert_eq!(service.runtime_modules().unwrap().registry_revision, 4);
    assert_eq!(
        service.runtime_modules().unwrap().modules[0].content_digest,
        second.content_digest
    );

    let error = directory
        .transition_module_stream(
            Some("registry-replace"),
            "shipctl.live-replace".to_string(),
            ModuleOperationKind::Disable,
            5,
            Some(first.content_digest),
        )
        .unwrap_err();
    assert_eq!(
        error.code.as_str(),
        shipctl_core::module_control::codes::MUTATION_UNAVAILABLE
    );
    assert_eq!(service.runtime_modules().unwrap().registry_revision, 4);

    let removed = directory
        .transition_module_stream(
            Some("registry-replace"),
            "shipctl.live-replace".to_string(),
            ModuleOperationKind::Remove,
            5,
            None,
        )
        .unwrap();
    let ControlResponseResult::ModuleOperation(removed) = removed.result else {
        panic!("module removal did not return an operation")
    };
    assert_eq!(removed.result, ModuleOperationResult::Pending);
    assert_eq!(removed.target_registry_revision, 5);
    let desired = service.runtime_modules().unwrap();
    assert_eq!(desired.registry_revision, 5);
    assert!(desired.modules.is_empty());
    let snapshot = ModuleRegistry::open_read_only(&paths)
        .unwrap()
        .snapshot()
        .unwrap();
    let tombstone = snapshot
        .desired
        .iter()
        .find(|desired| desired.module_id == "shipctl.live-replace")
        .expect("live removal must persist a restart-safe tombstone");
    assert!(!tombstone.enabled);
    assert!(tombstone.selected_artifact.is_none());

    service
        .publish_frontend_snapshot(FrontendRuntimeSnapshotInput {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            registry_revision: 5,
            modules: Vec::new(),
            activation_outcomes: Vec::new(),
        })
        .unwrap();
    let completed = directory
        .inspect_operation(Some("registry-replace"), removed.request_id)
        .unwrap();
    assert_eq!(completed.result, ModuleOperationResult::Succeeded);

    // Removal only withdraws the desired selection. Both immutable artifacts
    // remain admitted for later re-selection or repository garbage collection.
    let catalog = ModuleRegistry::open_read_only(&paths)
        .unwrap()
        .runtime_artifact_catalog()
        .unwrap();
    assert_eq!(catalog.len(), 2);

    drop(server);
}
