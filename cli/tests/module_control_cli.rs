use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;

use serde_json::Value;
use shipctl_core::instance::{
    ActiveWorkBlocker, ControlError, ControlEventPayload, ControlHandler, ControlResponseResult,
    ControlServer, ControlStream, InstanceContext, InstanceLaunchOptions, InstanceLeases,
    LaunchProvenance, MessageCommand, ModuleCommand,
};
use shipctl_core::message_bus::{
    diagnose_message_runtime, MessageBridgeInspection, MessageBridgeRegistrationObservation,
    MessageModuleInspection, MessageRouteSnapshot, MessageRuntimeInspection,
    MESSAGE_CONTRACT_SCHEMA_VERSION,
};
use shipctl_core::module_control::registry::{
    ArtifactAcquisition, ModuleRegistry, RegistryMutation,
};
use shipctl_core::module_control::{
    DesiredModuleState, Diagnostic, DiagnosticSeverity, ModuleIdentity, ModuleOperation,
    ModuleOperationKind, ModuleOperationPhase, ModuleOperationResult, ModuleRuntimeKind,
    ModuleSource, ModuleTransition, RedactedEvidence, MODULE_CONTROL_SCHEMA_VERSION,
};
use shipctl_core::state::paths::ShipctlPaths;
use uuid::Uuid;

struct FixtureHandler;

fn message_inspection() -> MessageRuntimeInspection {
    let registration = MessageBridgeRegistrationObservation {
        module_id: "shipctl.fixture".to_string(),
        activation_id: "shipctl.fixture@digest#activation".to_string(),
        effective_grants: vec!["message.send.fixture.directed".to_string()],
        contracts: Vec::new(),
        handled_channels: vec!["fixture.directed".to_string()],
        published_topics: Vec::new(),
        subscribed_topics: Vec::new(),
        capability_ports: Vec::new(),
    };
    MessageRuntimeInspection::new(
        MessageBridgeInspection {
            schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
            bridge_count: 1,
            snapshot: MessageRouteSnapshot {
                schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
                instance_id: "fixture".to_string(),
                incarnation: "cli-fixture".to_string(),
                route_generation: 7,
                channels: Vec::new(),
                topics: Vec::new(),
                ports: Vec::new(),
            },
            endpoints: Vec::new(),
            activations: Vec::new(),
            registrations: vec![registration.clone()],
        },
        vec![MessageModuleInspection {
            registration,
            module: None,
        }],
    )
}

impl ControlHandler for FixtureHandler {
    fn active_work(&self) -> Vec<ActiveWorkBlocker> {
        Vec::new()
    }

    fn module_control(&self, command: ModuleCommand) -> Result<ControlStream, ControlError> {
        let ModuleCommand::Lifecycle {
            module_id,
            kind,
            target_registry_revision,
            artifact_content_digest: _,
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

    fn message_control(&self, command: MessageCommand) -> Result<ControlStream, ControlError> {
        let inspection = message_inspection();
        Ok(ControlStream::result(match command {
            MessageCommand::Inspect {} => ControlResponseResult::MessageInspection(inspection),
            MessageCommand::Diagnose {} => {
                ControlResponseResult::MessageDiagnostics(diagnose_message_runtime(inspection))
            }
        }))
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
    let paths = ShipctlPaths::new(context.state_root.clone(), context.runtime_root.clone());
    ModuleRegistry::open_writable(&paths).unwrap();

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

    let replacement = run_replace_cli(&context, "json");
    assert!(replacement.status.success());
    let replacement: Value = serde_json::from_slice(&replacement.stdout).unwrap();
    assert_eq!(replacement["operation"], "modules.replace");
    assert_eq!(replacement["data"]["kind"], "update");
    assert_eq!(replacement["data"]["targetRegistryRevision"], 15);

    let removal = run_remove_cli(&context, "json");
    assert!(removal.status.success());
    let removal: Value = serde_json::from_slice(&removal.stdout).unwrap();
    assert_eq!(removal["operation"], "modules.remove");
    assert_eq!(removal["data"]["kind"], "remove");
    assert_eq!(removal["data"]["targetRegistryRevision"], 16);

    let mut watch = Command::new(env!("CARGO_BIN_EXE_shipctl"))
        .args([
            "modules",
            "watch",
            "--instance",
            "fixture",
            "--runtime-root",
        ])
        .arg(&context.runtime_root)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut reader = BufReader::new(watch.stdout.take().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let event: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(event["schemaVersion"], 1);
    assert_eq!(event["instanceId"], context.instance_id.to_string());
    assert_eq!(event["instanceName"], "fixture");
    assert_eq!(event["registryRevision"], 0);
    assert!(event["desired"].as_array().unwrap().is_empty());

    let artifact = ModuleIdentity {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        id: "shipctl.watch-fixture".to_string(),
        version: "1.0.0".to_string(),
        content_digest: "a".repeat(64),
        runtime_kind: ModuleRuntimeKind::StaticBuiltin,
    };
    ModuleRegistry::open_writable(&paths)
        .unwrap()
        .commit(&RegistryMutation {
            request_id: Uuid::new_v4(),
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
    let event = loop {
        line.clear();
        reader.read_line(&mut line).unwrap();
        let event: Value = serde_json::from_str(&line).unwrap();
        if event["registryRevision"] == 1 {
            break event;
        }
    };
    assert_eq!(event["registryRevision"], 1);
    assert_eq!(event["desired"][0]["moduleId"], "shipctl.watch-fixture");
    watch.kill().unwrap();
    watch.wait().unwrap();

    let invalid_watch_output = Command::new(env!("CARGO_BIN_EXE_shipctl"))
        .args([
            "modules",
            "watch",
            "--instance",
            "fixture",
            "--runtime-root",
        ])
        .arg(&context.runtime_root)
        .args(["--output", "json"])
        .output()
        .unwrap();
    assert!(!invalid_watch_output.status.success());
    let invalid_watch_output: Value = serde_json::from_slice(&invalid_watch_output.stdout).unwrap();
    assert_eq!(invalid_watch_output["operation"], "modules.watch");

    let message_json = run_message_cli(&context, "inspect", "json");
    let message_toon = run_message_cli(&context, "inspect", "toon");
    assert!(message_json.status.success());
    assert!(message_toon.status.success());
    let message_json_value: Value = serde_json::from_slice(&message_json.stdout).unwrap();
    let message_toon_value: Value =
        toon_format::decode_default(std::str::from_utf8(&message_toon.stdout).unwrap()).unwrap();
    assert_eq!(message_toon_value, message_json_value);
    assert_eq!(message_json_value["operation"], "messages.inspect");
    assert_eq!(message_json_value["code"], "message.runtime.inspected");
    assert_eq!(
        message_json_value["data"]["runtime"]["snapshot"]["routeGeneration"],
        7
    );
    assert_eq!(
        message_json_value["data"]["runtime"]["registrations"][0]["effectiveGrants"][0],
        "message.send.fixture.directed"
    );
    let encoded = String::from_utf8(message_json.stdout).unwrap();
    assert!(!encoded.contains("payload"));
    assert!(!encoded.contains("resources"));

    let diagnosis = run_message_cli(&context, "diagnose", "json");
    assert!(!diagnosis.status.success());
    let diagnosis: Value = serde_json::from_slice(&diagnosis.stdout).unwrap();
    assert_eq!(diagnosis["operation"], "messages.diagnose");
    assert_eq!(diagnosis["code"], "message.runtime.diagnostics_failed");
    assert_eq!(
        diagnosis["data"]["diagnostics"][0]["code"],
        "message.runtime.module_join_unavailable"
    );

    drop(server);
    let unavailable = run_message_cli(&context, "inspect", "json");
    assert!(!unavailable.status.success());
    assert!(unavailable.stderr.is_empty());
    let unavailable: Value = serde_json::from_slice(&unavailable.stdout).unwrap();
    assert_eq!(unavailable["code"], "message.runtime.unavailable");
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

fn run_replace_cli(context: &InstanceContext, output: &str) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_shipctl"))
        .args([
            "modules",
            "replace",
            "shipctl.native",
            "--artifact",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "--target-revision",
            "15",
            "--instance",
            "fixture",
            "--runtime-root",
        ])
        .arg(&context.runtime_root)
        .args(["--output", output])
        .output()
        .unwrap()
}

fn run_remove_cli(context: &InstanceContext, output: &str) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_shipctl"))
        .args([
            "modules",
            "remove",
            "shipctl.native",
            "--target-revision",
            "16",
            "--instance",
            "fixture",
            "--runtime-root",
        ])
        .arg(&context.runtime_root)
        .args(["--output", output])
        .output()
        .unwrap()
}

fn run_message_cli(context: &InstanceContext, command: &str, output: &str) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_shipctl"))
        .args([
            "messages",
            command,
            "--instance",
            "fixture",
            "--runtime-root",
        ])
        .arg(&context.runtime_root)
        .args(["--output", output])
        .output()
        .unwrap()
}
