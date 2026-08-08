use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use shipctl_core::instance::{
    ActiveWorkBlocker, ControlError, ControlEventPayload, ControlHandler, ControlResponseResult,
    ControlServer, ControlStream, InstanceContext, InstanceDirectory, InstanceLaunchOptions,
    InstanceLeases, LaunchProvenance, ModuleCommand, OperationCommand,
};
use shipctl_core::module_control::{
    parse_contract_json, Diagnostic, DiagnosticSeverity, ModuleInspection, ModuleOperation,
    ModuleOperationKind, ModuleOperationPhase, ModuleOperationResult, ModuleTransition,
    RedactedEvidence,
};
use uuid::Uuid;

struct FixtureHandler {
    inspection: ModuleInspection,
    operation: ModuleOperation,
    stopped: AtomicBool,
}

impl FixtureHandler {
    fn diagnostic(code: &str, summary: &str) -> Diagnostic {
        Diagnostic {
            schema_version: 1,
            code: code.to_string(),
            severity: DiagnosticSeverity::Error,
            check: "fixture_transport".to_string(),
            summary: summary.to_string(),
            evidence: RedactedEvidence {
                fields: BTreeMap::from([("token".to_string(), "[redacted]".to_string())]),
            },
            remedy: Some(
                "Choose a supported frontend ESM artifact or restart with a released native host."
                    .to_string(),
            ),
        }
    }

    fn operation(
        &self,
        module_id: String,
        kind: ModuleOperationKind,
        revision: u64,
    ) -> ModuleOperation {
        let mut operation = self.operation.clone();
        operation.module_id = module_id.clone();
        operation.kind = kind;
        operation.target_registry_revision = revision;
        let diagnostic = match module_id.as_str() {
            "shipctl.native" => Some(Self::diagnostic(
                "module.runtime.restart_required_native",
                "A new Rust/Tauri registration is release-bound and requires restart.",
            )),
            "shipctl.worker" => Some(Self::diagnostic(
                "module.runtime.unsupported_kind",
                "Worker runtime artifacts are not supported by this fixture host.",
            )),
            "shipctl.stale" => Some(Self::diagnostic(
                "module.runtime.revision_stale",
                "The requested revision is older than the observed fixture revision.",
            )),
            "shipctl.failed" => Some(Self::diagnostic(
                "module.runtime.transition_failed",
                "The fixture reports a failed lifecycle transition.",
            )),
            _ => None,
        };
        operation.transitions = vec![ModuleTransition {
            phase: if diagnostic.is_some() {
                ModuleOperationPhase::Failed
            } else {
                ModuleOperationPhase::Completed
            },
            registry_revision: Some(revision),
            diagnostics: diagnostic.into_iter().collect(),
        }];
        operation.result = if operation.transitions[0].diagnostics.is_empty() {
            ModuleOperationResult::Succeeded
        } else {
            ModuleOperationResult::Failed
        };
        operation
    }
}

impl ControlHandler for FixtureHandler {
    fn active_work(&self) -> Vec<ActiveWorkBlocker> {
        Vec::new()
    }

    fn module_control(&self, command: ModuleCommand) -> Result<ControlStream, ControlError> {
        match command {
            ModuleCommand::Inspect { .. } => Ok(ControlStream::result(
                ControlResponseResult::ModuleInspection(self.inspection.clone()),
            )),
            ModuleCommand::Diagnose { module_id } => Ok(ControlStream::result(
                ControlResponseResult::ModuleDiagnostics(match module_id.as_str() {
                    "shipctl.native" => vec![Self::diagnostic(
                        "module.runtime.restart_required_native",
                        "A new Rust/Tauri registration is release-bound and requires restart.",
                    )],
                    "shipctl.worker" => vec![Self::diagnostic(
                        "module.runtime.unsupported_kind",
                        "Worker runtime artifacts are not supported by this fixture host.",
                    )],
                    "shipctl.stale" => vec![Self::diagnostic(
                        "module.runtime.revision_stale",
                        "The requested revision is older than the observed fixture revision.",
                    )],
                    "shipctl.failed" => vec![Self::diagnostic(
                        "module.runtime.transition_failed",
                        "The fixture reports a failed lifecycle transition.",
                    )],
                    _ => self.inspection.diagnostics.clone(),
                }),
            )),
            ModuleCommand::Lifecycle {
                module_id,
                kind,
                target_registry_revision,
            } => {
                let operation = self.operation(module_id, kind, target_registry_revision);
                Ok(ControlStream {
                    result: ControlResponseResult::ModuleOperation(operation.clone()),
                    events: vec![ControlEventPayload::ModuleOperation(operation)],
                })
            }
        }
    }

    fn operation_control(&self, command: OperationCommand) -> Result<ControlStream, ControlError> {
        let OperationCommand::Inspect { operation_id } = command;
        let mut operation = self.operation.clone();
        operation.request_id = operation_id;
        Ok(ControlStream {
            result: ControlResponseResult::ModuleOperation(operation.clone()),
            events: vec![ControlEventPayload::ModuleOperation(operation)],
        })
    }

    fn shutdown(&self, _force: bool) -> Result<(), ControlError> {
        self.stopped.store(true, Ordering::SeqCst);
        Ok(())
    }
}

#[test]
fn named_endpoint_transports_fixture_module_frames_without_runtime_mutation() {
    let root = std::env::temp_dir().join(format!(
        "shipctl-module-control-protocol-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    let context = InstanceContext::resolve(
        InstanceLaunchOptions {
            name: Some("fixture".to_string()),
            state_root: Some(root.join("state")),
            runtime_root: Some(root.join("runtime")),
            load_state: None,
            provenance: Some(LaunchProvenance::Cli),
        },
        "protocol-fixture",
    )
    .unwrap();
    let inspection = parse_contract_json::<ModuleInspection>(include_str!(
        "../../../ops/module-control/fixtures/contracts/inspection.valid.json"
    ))
    .unwrap();
    let operation = parse_contract_json::<ModuleOperation>(include_str!(
        "../../../ops/module-control/fixtures/contracts/operation.valid.json"
    ))
    .unwrap();
    let handler = Arc::new(FixtureHandler {
        inspection,
        operation,
        stopped: AtomicBool::new(false),
    });
    let server = ControlServer::start(
        context.clone(),
        Arc::new(InstanceLeases::acquire(&context).unwrap()),
        handler.clone(),
    )
    .unwrap();
    let directory = InstanceDirectory::new(context.runtime_root.clone(), context.build.clone());

    let inspection = directory
        .inspect_module(Some("fixture"), "shipctl.fixture".to_string())
        .unwrap();
    assert_eq!(inspection.manifest.id, "shipctl.fixture");

    let enabled = directory
        .transition_module_stream(
            Some("fixture"),
            "shipctl.fixture".to_string(),
            ModuleOperationKind::Enable,
            12,
        )
        .unwrap();
    assert!(matches!(
        enabled.result,
        ControlResponseResult::ModuleOperation(_)
    ));
    assert_eq!(enabled.events.len(), 1);
    assert!(matches!(
        enabled.events.as_slice(),
        [ControlEventPayload::ModuleOperation(operation)] if operation.kind == ModuleOperationKind::Enable
            && operation.target_registry_revision == 12
    ));

    let disabled = directory
        .transition_module(
            Some("fixture"),
            "shipctl.fixture".to_string(),
            ModuleOperationKind::Disable,
            13,
        )
        .unwrap();
    assert_eq!(disabled.kind, ModuleOperationKind::Disable);
    assert_eq!(disabled.target_registry_revision, 13);
    assert_eq!(disabled.result, ModuleOperationResult::Succeeded);

    let native = directory
        .transition_module(
            Some("fixture"),
            "shipctl.native".to_string(),
            ModuleOperationKind::Enable,
            14,
        )
        .unwrap();
    assert_eq!(native.result, ModuleOperationResult::Failed);
    assert_eq!(
        native.transitions[0].diagnostics[0].code,
        "module.runtime.restart_required_native"
    );
    for module_id in ["shipctl.worker", "shipctl.stale", "shipctl.failed"] {
        let diagnostics = directory
            .diagnose_module(Some("fixture"), module_id.to_string())
            .unwrap();
        assert!(diagnostics[0].code.starts_with("module.runtime."));
    }

    let operation_id = Uuid::new_v4();
    let status = directory
        .inspect_operation(Some("fixture"), operation_id)
        .unwrap();
    assert_eq!(status.request_id, operation_id);
    assert!(!context.paths().module_registry_database.exists());

    drop(server);
    assert!(!handler.stopped.load(Ordering::SeqCst));
    let _ = std::fs::remove_dir_all(root);
}
