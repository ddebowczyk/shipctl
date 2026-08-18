use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use uuid::Uuid;

use super::context::InstanceBuildIdentity;
use crate::message_bus::{MessageDiagnosticReport, MessageRuntimeInspection};
use crate::module_control::{
    agent::{ActiveCapabilityCatalog, ActiveCapabilityInspection, CapabilityInvocation},
    Diagnostic, ModuleInspection, ModuleOperation, ModuleOperationKind,
};
use crate::scheduler::{
    ScheduleDiagnosticReport, ScheduleInspection, ScheduleRefreshReport, ScheduleTriggerReport,
    ScheduleVerification,
};
use crate::state::archive::StateArchiveInspection;
use crate::terminal_host::{
    TerminalAgentActivity, TerminalAgentReportKind, TerminalAgentReportSource,
    TerminalAttachmentId, TerminalDescriptor, TerminalExit, TerminalId, TerminalRevision,
    TerminalShellSpawnRequest,
};

/// The JSON-line envelope version for the authenticated local endpoint.
///
/// Version eleven replaces core-owned semantic terminal commands with an
/// opaque selected-driver request. The build control-protocol version remains
/// the compatibility check between executable roles; this version only
/// describes the wire envelope.
pub const CONTROL_FRAME_SCHEMA_VERSION: u32 = 11;

/// Maximum raw bytes accepted by one terminal control write. This preserves
/// the replaced terminal ACK path's established 100,000-byte flow-control
/// budget; it is not a new guessed transport quota.
pub const TERMINAL_CONTROL_WRITE_MAX_BYTES: usize = 100_000;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlCaller {
    pub process_id: u32,
    pub executable_role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub injected_instance_id: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleControlStatus {
    pub registry_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry_revision: Option<u64>,
    pub runtime_snapshot_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_snapshot_published_at_unix_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_registry_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_lag: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWorkBlocker {
    pub kind: String,
    pub count: usize,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceRecord {
    pub instance_id: Uuid,
    pub name: String,
    pub build: InstanceBuildIdentity,
    pub process_id: u32,
    pub process_started_at: u64,
    pub state_root: PathBuf,
    pub runtime_root: PathBuf,
    pub endpoint_protocol: String,
    pub lifecycle: InstanceLifecycle,
    pub active_work: Vec<ActiveWorkBlocker>,
    pub state_fingerprint: Option<String>,
    #[serde(default)]
    pub workspace_identities: Vec<String>,
    #[serde(default)]
    pub module_control: ModuleControlStatus,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlHello {
    pub negotiated_control_protocol_version: u32,
    pub frame_schema_version: u32,
    pub instance: InstanceRecord,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstanceDiagnosticReport {
    pub instance: InstanceRecord,
    pub healthy: bool,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstanceLifecycle {
    Ready,
    Stopping,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlError {
    pub code: Box<String>,
    pub message: Box<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_selector: Option<Box<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_instance_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_root: Option<Box<PathBuf>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<Box<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed: Option<Box<String>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blockers: Vec<ActiveWorkBlocker>,
}

impl ControlError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: Box::new(code.into()),
            message: Box::new(message.into()),
            requested_selector: None,
            resolved_instance_id: None,
            state_root: None,
            expected: None,
            observed: None,
            blockers: Vec::new(),
        }
    }

    pub fn for_context(mut self, instance_id: Uuid, state_root: PathBuf) -> Self {
        self.resolved_instance_id = Some(instance_id);
        self.state_root = Some(Box::new(state_root));
        self
    }

    pub fn with_selector(mut self, selector: impl Into<String>) -> Self {
        self.requested_selector = Some(Box::new(selector.into()));
        self
    }

    pub fn with_expected_observed(
        mut self,
        expected: impl Into<String>,
        observed: impl Into<String>,
    ) -> Self {
        self.expected = Some(Box::new(expected.into()));
        self.observed = Some(Box::new(observed.into()));
        self
    }

    pub fn with_blockers(mut self, blockers: Vec<ActiveWorkBlocker>) -> Self {
        self.blockers = blockers;
        self
    }
}

impl std::fmt::Display for ControlError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ControlError {}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryProblem {
    pub descriptor_path: PathBuf,
    pub category: DiscoveryProblemCategory,
    pub error: ControlError,
    pub reclaimed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryProblemCategory {
    Stale,
    Unauthorized,
    Incompatible,
    HandshakeFailed,
    InvalidDescriptor,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryReport {
    pub instances: Vec<InstanceRecord>,
    pub problems: Vec<DiscoveryProblem>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopOutcome {
    pub instance: InstanceRecord,
    pub accepted: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredDescriptor {
    pub descriptor_schema_version: u32,
    pub instance: InstanceRecord,
    pub endpoint: String,
    pub auth_token: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlRequest {
    #[serde(rename = "frameType")]
    pub frame_type: String,
    pub frame_schema_version: u32,
    pub control_protocol_version: u32,
    pub request_id: Uuid,
    pub auth_token: String,
    pub caller: ControlCaller,
    pub operation: ControlOperation,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "type",
    deny_unknown_fields
)]
pub enum ControlOperation {
    Hello,
    Inspect,
    Diagnose,
    SaveState { destination: PathBuf },
    Shutdown { force: bool },
    Modules { command: ModuleCommand },
    Messages { command: MessageCommand },
    Capabilities { command: CapabilityCommand },
    Terminals { command: TerminalCommand },
    Schedules { command: ScheduleCommand },
    Operations { command: OperationCommand },
}

/// Commands against the host-owned terminal registry. `Attach` is the only
/// long-lived operation; every other command produces a finite response.
///
/// Not `Eq`: a pointer position is a pixel measurement, and two of them are
/// comparable but not equatable.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "type",
    deny_unknown_fields
)]
pub enum TerminalCommand {
    List {},
    /// Start an interactive shell in a registered workspace. The request is
    /// intentionally narrower than a private process launch: callers cannot
    /// choose executable, argv, environment, ownership, or theme.
    Spawn {
        request: TerminalShellSpawnRequest,
    },
    Get {
        terminal_id: TerminalId,
    },
    Attach {
        terminal_id: TerminalId,
    },
    /// Forward one module-owned request to the selected driver. Core stores
    /// and orders the JSON value but never names its semantic schema.
    DriverRequest {
        terminal_id: TerminalId,
        request: JsonValue,
    },
    Write {
        terminal_id: TerminalId,
        data_base64: String,
    },
    Report {
        terminal_id: TerminalId,
        kind: TerminalAgentReportKind,
        source: TerminalAgentReportSource,
        message: Option<String>,
    },
    Close {
        terminal_id: TerminalId,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalListResult {
    pub count: usize,
    pub terminals: Vec<TerminalDescriptor>,
}

/// Opaque response from the selected terminal driver. Its schema belongs to
/// the module that accepted the matching `DriverRequest`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalDriverResult {
    pub terminal_id: TerminalId,
    pub response: JsonValue,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalWriteResult {
    pub terminal_id: TerminalId,
    pub accepted_bytes: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalAgentReportResult {
    pub terminal_id: TerminalId,
    pub activity: TerminalAgentActivity,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalCloseControlResult {
    pub terminal_id: TerminalId,
    pub existed: bool,
    pub exit: Option<TerminalExit>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalAttachmentState {
    pub terminal_id: TerminalId,
    pub attachment_id: TerminalAttachmentId,
    pub live: bool,
    pub descriptor: TerminalDescriptor,
    pub sequence_boundary: u64,
}

/// One event from a detachable terminal subscription. The terminal sequence
/// is independent from the outer control-stream sequence.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "type",
    deny_unknown_fields
)]
pub enum TerminalControlEvent {
    Output {
        terminal_id: TerminalId,
        attachment_id: TerminalAttachmentId,
        sequence: u64,
        revision: TerminalRevision,
        data_base64: String,
    },
    MetadataChanged {
        terminal_id: TerminalId,
        attachment_id: TerminalAttachmentId,
        sequence: u64,
        descriptor: TerminalDescriptor,
    },
    AgentActivityChanged {
        terminal_id: TerminalId,
        attachment_id: TerminalAttachmentId,
        sequence: u64,
        descriptor: TerminalDescriptor,
    },
    Exited {
        terminal_id: TerminalId,
        attachment_id: TerminalAttachmentId,
        sequence: u64,
        descriptor: TerminalDescriptor,
    },
    ResyncRequired {
        terminal_id: TerminalId,
        attachment_id: TerminalAttachmentId,
        sequence: u64,
        reason: String,
    },
    Detached {
        terminal_id: TerminalId,
        attachment_id: TerminalAttachmentId,
        sequence: u64,
        reason: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type", deny_unknown_fields)]
pub enum MessageCommand {
    Inspect {},
    Diagnose {},
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "type",
    deny_unknown_fields
)]
pub enum CapabilityCommand {
    List {},
    Inspect {
        capability_id: String,
    },
    Call {
        capability_id: String,
        port_id: String,
        payload: serde_json::Value,
    },
}

/// Scheduler commands carried by the authenticated running-instance endpoint.
///
/// The enclosing [`ControlRequest::request_id`] is the mutation identity for
/// `refresh` and `trigger`; callers must retain it when retrying a response
/// that may have been lost. The named instance is selected before this command
/// reaches the endpoint, so no command can silently select another instance.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "type",
    deny_unknown_fields
)]
pub enum ScheduleCommand {
    List {},
    Inspect { schedule_id: String },
    Diagnose {},
    Verify {},
    Refresh {},
    Trigger { schedule_id: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum ModuleCommand {
    Inspect {
        module_id: String,
    },
    Diagnose {
        module_id: String,
    },
    Lifecycle {
        module_id: String,
        kind: ModuleOperationKind,
        target_registry_revision: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        artifact_content_digest: Option<String>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum OperationCommand {
    Inspect { operation_id: Uuid },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlResponse {
    #[serde(rename = "frameType")]
    pub frame_type: String,
    pub frame_schema_version: u32,
    pub request_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<ControlResponseResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ControlError>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    rename_all = "snake_case",
    tag = "type",
    content = "value",
    deny_unknown_fields
)]
pub enum ControlResponseResult {
    Hello(ControlHello),
    Instance(InstanceRecord),
    InstanceDiagnostics(InstanceDiagnosticReport),
    StateArchive(StateArchiveInspection),
    Stop(StopOutcome),
    ModuleInspection(ModuleInspection),
    ModuleDiagnostics(Vec<Diagnostic>),
    ModuleOperation(ModuleOperation),
    MessageInspection(MessageRuntimeInspection),
    MessageDiagnostics(MessageDiagnosticReport),
    CapabilityCatalog(ActiveCapabilityCatalog),
    CapabilityInspection(ActiveCapabilityInspection),
    CapabilityInvocation(CapabilityInvocation),
    TerminalList(TerminalListResult),
    TerminalDescriptor(TerminalDescriptor),
    TerminalDriver(TerminalDriverResult),
    TerminalWrite(TerminalWriteResult),
    TerminalAgentReport(TerminalAgentReportResult),
    TerminalClose(TerminalCloseControlResult),
    TerminalAttachment(TerminalAttachmentState),
    ScheduleInspection(ScheduleInspection),
    ScheduleDiagnostics(ScheduleDiagnosticReport),
    ScheduleVerification(ScheduleVerification),
    ScheduleRefresh(ScheduleRefreshReport),
    ScheduleTrigger(ScheduleTriggerReport),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlEvent {
    #[serde(rename = "frameType")]
    pub frame_type: String,
    pub frame_schema_version: u32,
    pub request_id: Uuid,
    pub sequence: u64,
    pub event: ControlEventPayload,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type", content = "value")]
pub enum ControlEventPayload {
    ModuleOperation(ModuleOperation),
    Terminal(TerminalControlEvent),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlCompletionStatus {
    Succeeded,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlCompletion {
    #[serde(rename = "frameType")]
    pub frame_type: String,
    pub frame_schema_version: u32,
    pub request_id: Uuid,
    pub status: ControlCompletionStatus,
    pub event_count: u64,
}

/// One complete response stream from the existing authenticated endpoint.
///
/// The handler supplies data only. It cannot reconcile a registry, load Rust,
/// or mutate Cargo/Tauri composition through this transport layer.
#[derive(Clone, Debug)]
pub struct ControlStream {
    pub result: ControlResponseResult,
    pub events: Vec<ControlEventPayload>,
}

impl ControlResponse {
    pub fn success(request_id: Uuid, result: ControlResponseResult) -> Self {
        Self {
            frame_type: "response".to_string(),
            frame_schema_version: CONTROL_FRAME_SCHEMA_VERSION,
            request_id,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(request_id: Uuid, error: ControlError) -> Self {
        Self {
            frame_type: "response".to_string(),
            frame_schema_version: CONTROL_FRAME_SCHEMA_VERSION,
            request_id,
            result: None,
            error: Some(error),
        }
    }
}

impl ControlStream {
    pub fn result(result: ControlResponseResult) -> Self {
        Self {
            result,
            events: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ControlOperation, ControlResponseResult, MessageCommand, ScheduleCommand, TerminalCommand,
    };
    use crate::scheduler::{ScheduleInspection, SCHEDULE_INSPECTION_SCHEMA_VERSION};
    use crate::terminal_host::{
        TerminalAgentReportKind, TerminalAgentReportSource, TerminalId, TerminalShellSpawnRequest,
    };
    use std::path::PathBuf;
    use std::str::FromStr;

    fn schedule_inspection() -> ScheduleInspection {
        ScheduleInspection {
            schema_version: SCHEDULE_INSPECTION_SCHEMA_VERSION,
            instance_id: "test-instance".to_string(),
            incarnation: "test-incarnation".to_string(),
            schedule_generation: 1,
            snapshot_digest_sha256: "accepted".to_string(),
            bus_route_generation: 2,
            schedules: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    #[test]
    fn message_commands_are_strict_and_round_trip() {
        for command in [MessageCommand::Inspect {}, MessageCommand::Diagnose {}] {
            let encoded = serde_json::to_value(&command).unwrap();
            let decoded: MessageCommand = serde_json::from_value(encoded).unwrap();
            assert!(matches!(
                (command, decoded),
                (MessageCommand::Inspect {}, MessageCommand::Inspect {})
                    | (MessageCommand::Diagnose {}, MessageCommand::Diagnose {})
            ));
        }

        assert!(serde_json::from_value::<MessageCommand>(serde_json::json!({
            "type": "inspect",
            "unexpected": true
        }))
        .is_err());
    }

    #[test]
    fn terminal_commands_are_typed_strict_and_round_trip() {
        let terminal_id = TerminalId::from_str("01234567-89ab-4def-8123-456789abcdef").unwrap();
        for command in [
            TerminalCommand::List {},
            TerminalCommand::Spawn {
                request: TerminalShellSpawnRequest {
                    driver_id: crate::terminal_host::default_terminal_driver_id(),
                    project_path: PathBuf::from("/workspace"),
                    cwd: Some(PathBuf::from("/workspace/nested")),
                    columns: 80,
                    rows: 24,
                },
            },
            TerminalCommand::Get { terminal_id },
            TerminalCommand::Attach { terminal_id },
            TerminalCommand::Write {
                terminal_id,
                data_base64: "AAEC/w==".to_string(),
            },
            TerminalCommand::Report {
                terminal_id,
                kind: TerminalAgentReportKind::Blocked,
                source: TerminalAgentReportSource {
                    identifier: "test-agent".to_string(),
                    version: "1.0.0".to_string(),
                },
                message: Some("waiting for review".to_string()),
            },
            TerminalCommand::DriverRequest {
                terminal_id,
                request: serde_json::json!({
                    "operation": "snapshot",
                    "baseline": true,
                }),
            },
            TerminalCommand::Close { terminal_id },
        ] {
            let encoded = serde_json::to_value(&command).unwrap();
            let decoded: TerminalCommand = serde_json::from_value(encoded).unwrap();
            assert_eq!(decoded, command);
        }

        assert!(
            serde_json::from_value::<TerminalCommand>(serde_json::json!({
                "type": "get",
                "terminalId": terminal_id,
                "unexpected": true
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<TerminalCommand>(serde_json::json!({
                "type": "write",
                "terminalId": "not-a-uuid",
                "dataBase64": "AA=="
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<TerminalCommand>(serde_json::json!({
                "type": "spawn",
                "request": {
                    "driverId": "semantic-terminal",
                    "projectPath": "/workspace",
                    "columns": 80,
                    "rows": 24,
                    "environment": { "TOKEN": "must-not-be-accepted" }
                }
            }))
            .is_err(),
            "public shell spawn never grows private launch authority"
        );
    }

    /// The control attachment is always the host's exact raw-byte stream.
    #[test]
    fn attach_has_no_presentation_selector() {
        let terminal_id = TerminalId::from_str("01234567-89ab-4def-8123-456789abcdef").unwrap();

        let attached: TerminalCommand = serde_json::from_value(serde_json::json!({
            "type": "attach",
            "terminalId": terminal_id,
        }))
        .unwrap();
        assert_eq!(attached, TerminalCommand::Attach { terminal_id });

        assert!(
            serde_json::from_value::<TerminalCommand>(serde_json::json!({
                "type": "attach",
                "terminalId": terminal_id,
                "presentation": "semantic",
            }))
            .is_err(),
            "an encoding the host does not implement is refused, not guessed"
        );
    }

    /// Driver requests preserve their module-owned payload. Core validates the
    /// terminal identity and selected driver, but does not define semantic
    /// operations on the control wire.
    #[test]
    fn driver_request_is_opaque_to_the_host_protocol() {
        let terminal_id = TerminalId::from_str("01234567-89ab-4def-8123-456789abcdef").unwrap();

        let encoded = serde_json::to_value(TerminalCommand::DriverRequest {
            terminal_id,
            request: serde_json::json!({ "operation": "snapshot", "baseline": true }),
        })
        .unwrap();
        assert_eq!(encoded["type"], "driver_request");
        assert_eq!(encoded["request"]["operation"], "snapshot");

        assert!(
            serde_json::from_value::<TerminalCommand>(serde_json::json!({
                "type": "driver_request",
                "terminalId": terminal_id,
                "request": { "operation": "snapshot" },
                "unexpected": true,
            }))
            .is_err()
        );
    }

    #[test]
    fn schedule_commands_are_strict_and_round_trip() {
        let commands = [
            ScheduleCommand::List {},
            ScheduleCommand::Inspect {
                schedule_id: "agents.refresh".to_string(),
            },
            ScheduleCommand::Diagnose {},
            ScheduleCommand::Verify {},
            ScheduleCommand::Refresh {},
            ScheduleCommand::Trigger {
                schedule_id: "agents.refresh".to_string(),
            },
        ];

        for command in commands {
            let encoded = serde_json::to_value(&command).unwrap();
            let decoded: ScheduleCommand = serde_json::from_value(encoded).unwrap();
            assert_eq!(decoded, command);
        }

        assert!(
            serde_json::from_value::<ScheduleCommand>(serde_json::json!({
                "type": "trigger",
                "scheduleId": "agents.refresh",
                "unexpected": true
            }))
            .is_err()
        );
    }

    #[test]
    fn schedule_operation_outer_fields_are_strict() {
        let operation = ControlOperation::Schedules {
            command: ScheduleCommand::Trigger {
                schedule_id: "agents.refresh".to_string(),
            },
        };
        let mut valid = serde_json::to_value(operation).unwrap();

        assert!(serde_json::from_value::<ControlOperation>(valid.clone()).is_ok());
        valid
            .as_object_mut()
            .unwrap()
            .insert("unexpected".to_string(), serde_json::json!(true));
        assert!(serde_json::from_value::<ControlOperation>(valid).is_err());
    }

    #[test]
    fn schedule_result_outer_fields_are_strict() {
        let result = ControlResponseResult::ScheduleInspection(schedule_inspection());
        let mut valid = serde_json::to_value(result).unwrap();

        assert!(serde_json::from_value::<ControlResponseResult>(valid.clone()).is_ok());
        valid
            .as_object_mut()
            .unwrap()
            .insert("unexpected".to_string(), serde_json::json!(true));
        assert!(serde_json::from_value::<ControlResponseResult>(valid).is_err());
    }
}
