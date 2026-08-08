use std::collections::BTreeMap;
use std::process::Command;
use std::sync::Arc;

use serde_json::Value;
use shipctl_core::instance::{
    ActiveWorkBlocker, ControlError, ControlEventPayload, ControlHandler, ControlResponseResult,
    ControlServer, ControlStream, InstanceContext, InstanceLaunchOptions, InstanceLeases,
    LaunchProvenance, ModuleCommand,
};
use shipctl_core::module_control::{
    Diagnostic, DiagnosticSeverity, ModuleOperation, ModuleOperationPhase, ModuleOperationResult,
    ModuleTransition, RedactedEvidence,
};
use uuid::Uuid;

struct FixtureHandler;

impl ControlHandler for FixtureHandler {
    fn active_work(&self) -> Vec<ActiveWorkBlocker> {
        Vec::new()
    }

    fn module_control(&self, command: ModuleCommand) -> Result<ControlStream, ControlError> {
        let ModuleCommand::Lifecycle {
            module_id,
            kind,
            target_registry_revision,
        } = command
        else {
            return Err(ControlError::new(
                "module.control.fixture_command_invalid",
                "The CLI fixture accepts lifecycle commands only",
            ));
        };
        let operation = ModuleOperation {
            schema_version: 1,
            request_id: Uuid::parse_str("00000000-0000-0000-0000-000000000002").unwrap(),
            module_id,
            instance_id: Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap(),
            kind,
            target_registry_revision,
            transitions: vec![ModuleTransition {
                phase: ModuleOperationPhase::Failed,
                registry_revision: Some(target_registry_revision),
                diagnostics: vec![Diagnostic {
                    schema_version: 1,
                    code: "module.runtime.restart_required_native".to_string(),
                    severity: DiagnosticSeverity::Error,
                    check: "native_registration".to_string(),
                    summary: "New Rust/Tauri registration is release-bound and requires restart."
                        .to_string(),
                    evidence: RedactedEvidence {
                        fields: BTreeMap::from([("token".to_string(), "[redacted]".to_string())]),
                    },
                    remedy: Some(
                        "Restart with a host release that contains the registration.".to_string(),
                    ),
                }],
            }],
            result: ModuleOperationResult::Failed,
        };
        Ok(ControlStream {
            result: ControlResponseResult::ModuleOperation(operation.clone()),
            events: vec![ControlEventPayload::ModuleOperation(operation)],
        })
    }

    fn shutdown(&self, _force: bool) -> Result<(), ControlError> {
        Ok(())
    }
}

#[test]
fn cli_renders_complete_native_restart_fixture_stream_as_json_and_toon() {
    let root = std::env::temp_dir().join(format!(
        "shipctl-module-control-cli-{}-{}",
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
        "cli-fixture",
    )
    .unwrap();
    let server = ControlServer::start(
        context.clone(),
        Arc::new(InstanceLeases::acquire(&context).unwrap()),
        Arc::new(FixtureHandler),
    )
    .unwrap();

    let json = run_cli(&context, "json");
    let toon = run_cli(&context, "toon");
    let json_value: Value = serde_json::from_slice(&json.stdout).unwrap();
    let toon_value: Value =
        toon_format::decode_default(std::str::from_utf8(&toon.stdout).unwrap()).unwrap();
    assert_eq!(toon_value, json_value);
    assert_eq!(json_value["operation"], "modules.enable");
    assert_eq!(
        json_value["data"]["transitions"][0]["diagnostics"][0]["code"],
        "module.runtime.restart_required_native"
    );
    assert_eq!(json_value["data"]["kind"], "enable");
    assert_eq!(json_value["data"]["targetRegistryRevision"], 14);

    drop(server);
    let _ = std::fs::remove_dir_all(root);
}

fn run_cli(context: &InstanceContext, output: &str) -> std::process::Output {
    let output = Command::new(env!("CARGO_BIN_EXE_shipctl"))
        .args([
            "modules",
            "enable",
            "shipctl.native",
            "--target-revision",
            "14",
            "--instance",
            "fixture",
            "--runtime-root",
        ])
        .arg(&context.runtime_root)
        .args(["--output", output])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "shipctl failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}
