use std::sync::Arc;

use shipctl_core::instance::{
    ActiveWorkBlocker, ControlError, ControlHandler, ControlResponseResult, ControlServer,
    ControlStream, InstanceContext, InstanceDirectory, InstanceLaunchOptions, InstanceLeases,
    LaunchProvenance, ModuleCommand, OperationCommand,
};
use shipctl_core::module_control::codes::{
    MUTATION_UNAVAILABLE, REGISTRY_HEALTHY, SNAPSHOT_UNAVAILABLE,
};
use shipctl_core::module_control::live::ModuleControlService;
use shipctl_core::module_control::registry::{
    ArtifactAcquisition, BuildModuleMembership, ModuleRegistry, RegistryMutation,
    StaticBuildInventory,
};
use shipctl_core::module_control::{
    DesiredModuleState, ModuleOperationKind, ModuleSource, MODULE_CONTROL_SCHEMA_VERSION,
};
use uuid::Uuid;

struct RegistryControlHandler {
    service: ModuleControlService,
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
            ModuleCommand::Lifecycle { .. } => Err(ControlError::new(
                MUTATION_UNAVAILABLE,
                "Runtime mutation is not available in Phase 2",
            )),
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
fn named_socket_serves_registry_truth_and_rejects_runtime_mutation() {
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
    let server = ControlServer::start(
        context.clone(),
        Arc::new(InstanceLeases::acquire(&context).unwrap()),
        Arc::new(RegistryControlHandler { service }),
    )
    .unwrap();
    let directory = InstanceDirectory::new(context.runtime_root.clone(), context.build.clone());

    let instance = directory.inspect(Some("registry-live")).unwrap();
    assert!(instance.module_control.registry_available);
    assert!(instance.module_control.registry_revision.is_some());
    assert!(!instance.module_control.runtime_snapshot_available);

    let inspection = directory
        .inspect_module(Some("registry-live"), "shipctl.test".to_string())
        .unwrap();
    assert!(inspection.desired.enabled);
    assert_eq!(inspection.desired.configuration_revision, 1);
    assert!(inspection.observed.is_empty());

    let report = directory.diagnose(Some("registry-live")).unwrap();
    assert!(report.healthy);
    assert!(report
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == REGISTRY_HEALTHY));
    assert!(report
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == SNAPSHOT_UNAVAILABLE));

    let error = directory
        .transition_module(
            Some("registry-live"),
            "shipctl.test".to_string(),
            ModuleOperationKind::Disable,
            instance.module_control.registry_revision.unwrap(),
        )
        .unwrap_err();
    assert_eq!(error.code.as_str(), MUTATION_UNAVAILABLE);

    let operation = directory
        .inspect_operation(Some("registry-live"), operation_id)
        .unwrap();
    assert_eq!(operation.request_id, operation_id);
    assert_eq!(operation.instance_id, context.instance_id);

    drop(server);
}
