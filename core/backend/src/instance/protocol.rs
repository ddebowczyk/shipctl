use std::path::PathBuf;

use serde::{Deserialize, Serialize};
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
use crate::terminal::effects::TerminalEffect;
use crate::terminal::input::TerminalInput;
use crate::terminal::projection::{
    ProjectedPoint, ProjectedSpace, TerminalAnchor, TerminalAnchorId, TerminalHistoryWindow,
    TerminalProjection,
};
use crate::terminal::{
    TerminalAgentActivity, TerminalAgentReportKind, TerminalAgentReportSource,
    TerminalAttachmentId, TerminalDescriptor, TerminalExit, TerminalId, TerminalRevision,
    TerminalTransport,
};

/// The JSON-line envelope version for the authenticated local endpoint.
///
/// Version nine adds terminal anchors: a handle for one line that the host
/// moves with its cell through scrolling, eviction and reflow. History row
/// numbers are positions, so eviction renumbers them; an anchor is what lets a
/// client keep naming one line across reads. Version eight added
/// history-window reads: the rows that scrolled out of the viewport, answered
/// by the host's own retention rather than reconstructed by a client that kept
/// the child's output. The build control-protocol version remains the
/// compatibility check between executable roles; this version only describes
/// the wire envelope.
pub const CONTROL_FRAME_SCHEMA_VERSION: u32 = 9;

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
    Get {
        terminal_id: TerminalId,
    },
    Attach {
        terminal_id: TerminalId,
        /// Which encoding of the terminal to receive. A request that names none
        /// gets the byte encoding, because a client built before this field
        /// existed asked for the only encoding there was. Area 05 deletes the
        /// field, the default and the encoding it names together.
        #[serde(default = "attach_encoding_default")]
        encoding: TerminalTransport,
    },
    /// Read the host's semantic state. This is an inspection path: it publishes
    /// nothing and moves no sequence.
    Inspect {
        terminal_id: TerminalId,
    },
    /// Read a window of retained history: the rows behind the viewport.
    ///
    /// The viewport is what a screen frame carries, so this is the only way a
    /// client sees what scrolled away. It reads the host's retention rather
    /// than a client's copy of the child's output, which is why scrollback
    /// survives the byte path's deletion. Like `Inspect`, it publishes nothing
    /// and moves no sequence.
    History {
        terminal_id: TerminalId,
        /// Oldest retained row is zero. Eviction renumbers, so this names a
        /// position in history, never a line.
        start_row: u32,
        /// How many rows to read. A request past what history holds answers
        /// with the rows that exist.
        rows: u32,
    },
    /// Pin a cell, so a client can keep naming one line while row numbers move
    /// under it.
    ///
    /// The host holds the pin until the client releases it, which is why this
    /// is the one terminal read that leaves something behind.
    Anchor {
        terminal_id: TerminalId,
        /// Which space the point is named in. The same cell has a different
        /// number in each, so the space is never inferred from the number.
        space: ProjectedSpace,
        at: ProjectedPoint,
    },
    /// Where an anchor is now. An anchor the host does not hold answers with
    /// nothing, rather than with another line.
    ResolveAnchor {
        terminal_id: TerminalId,
        anchor: TerminalAnchorId,
    },
    /// Drop an anchor. Answers whether the host was holding it, so a client
    /// that lost track of its own handles learns which ones were live.
    ReleaseAnchor {
        terminal_id: TerminalId,
        anchor: TerminalAnchorId,
    },
    Write {
        terminal_id: TerminalId,
        data_base64: String,
    },
    /// Report what a person did and let the host encode it. The client sends
    /// meaning; which bytes that becomes depends on the modes the child
    /// selected, and those live in the host's parser.
    Input {
        terminal_id: TerminalId,
        input: TerminalInput,
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

/// The encoding an attach request gets when it names none. Legacy, and deleted
/// with the byte path.
fn attach_encoding_default() -> TerminalTransport {
    TerminalTransport::Legacy
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalListResult {
    pub count: usize,
    pub terminals: Vec<TerminalDescriptor>,
}

/// The host's terminal state, unchanged from the projection the runtime built.
///
/// Nothing here is base64: this carries semantic facts, never child output or
/// replay ANSI.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalInspectResult {
    pub terminal_id: TerminalId,
    pub descriptor: TerminalDescriptor,
    pub projection: TerminalProjection,
}

/// Rows read out of the host's retention, with what history looked like when
/// they were read.
///
/// The window is the runtime's own, unchanged: this frame adds the terminal it
/// belongs to and nothing else.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalHistoryResult {
    pub terminal_id: TerminalId,
    pub window: TerminalHistoryWindow,
}

/// One anchor the host minted, and where its line is now.
///
/// The anchor is the runtime's own, unchanged: this frame adds the terminal it
/// belongs to and nothing else.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalAnchorResult {
    pub terminal_id: TerminalId,
    pub anchor: TerminalAnchor,
}

/// Where an anchor is now, or that the host holds no such handle.
///
/// `anchor` is `None` for a handle the host never minted or already released.
/// That is an answer, not a failure: a client that outlived its own anchor
/// learns so rather than reading a cell that now holds another line.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalAnchorResolution {
    pub terminal_id: TerminalId,
    pub anchor: Option<TerminalAnchor>,
}

/// Whether the host was holding the anchor a client dropped.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalAnchorReleaseResult {
    pub terminal_id: TerminalId,
    pub anchor: TerminalAnchorId,
    pub released: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalWriteResult {
    pub terminal_id: TerminalId,
    pub accepted_bytes: usize,
}

/// What the host made of one semantic input.
///
/// `encoded_bytes` is zero when the child's current modes do not report the
/// input — a mouse move with no tracking on, a focus change with no focus
/// reporting. That is an answer, not a failure.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalInputResult {
    pub terminal_id: TerminalId,
    pub encoded_bytes: usize,
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

/// Transport representation of canonical VT replay. Bytes are base64 because
/// control frames are JSONL and must preserve arbitrary terminal bytes.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalReplayFrame {
    pub format: String,
    pub revision: TerminalRevision,
    pub columns: u16,
    pub rows: u16,
    pub data_base64: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalAttachmentState {
    pub terminal_id: TerminalId,
    pub attachment_id: TerminalAttachmentId,
    pub live: bool,
    pub descriptor: TerminalDescriptor,
    pub sequence_boundary: u64,
    pub replay: TerminalReplayFrame,
    /// The semantic baseline, present exactly when the attachment asked for the
    /// semantic encoding. Nothing here is base64; it carries no child bytes.
    pub state: Option<Box<TerminalProjection>>,
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
    Replay {
        terminal_id: TerminalId,
        attachment_id: TerminalAttachmentId,
        sequence: u64,
        replay: TerminalReplayFrame,
    },
    /// Host state as meaning. The semantic path's answer to `Output` and
    /// `Replay`, carrying no child bytes and no ANSI.
    Screen {
        terminal_id: TerminalId,
        attachment_id: TerminalAttachmentId,
        sequence: u64,
        revision: TerminalRevision,
        state: Box<TerminalProjection>,
        effects: Vec<TerminalEffect>,
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
    TerminalInspect(TerminalInspectResult),
    TerminalHistory(TerminalHistoryResult),
    TerminalAnchor(TerminalAnchorResult),
    TerminalAnchorResolution(TerminalAnchorResolution),
    TerminalAnchorRelease(TerminalAnchorReleaseResult),
    TerminalWrite(TerminalWriteResult),
    TerminalInput(TerminalInputResult),
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
    use crate::terminal::input::{
        TerminalInput, TerminalKeyAction, TerminalKeyEvent, TerminalModifiers,
    };
    use crate::terminal::{
        TerminalAgentReportKind, TerminalAgentReportSource, TerminalId, TerminalTransport,
    };
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
            TerminalCommand::Get { terminal_id },
            TerminalCommand::Attach {
                terminal_id,
                encoding: TerminalTransport::Legacy,
            },
            TerminalCommand::Attach {
                terminal_id,
                encoding: TerminalTransport::Semantic,
            },
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
            TerminalCommand::Input {
                terminal_id,
                input: TerminalInput::Key(TerminalKeyEvent {
                    action: TerminalKeyAction::Press,
                    code: "ArrowUp".to_string(),
                    text: None,
                    mods: TerminalModifiers {
                        ctrl: true,
                        ..TerminalModifiers::default()
                    },
                    composing: false,
                }),
            },
            TerminalCommand::Input {
                terminal_id,
                input: TerminalInput::Paste {
                    text: "pasted".to_string(),
                },
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
    }

    /// The encoding is named on the wire, and a request written before the
    /// field existed still asks for the encoding it was built to read.
    #[test]
    fn attach_names_its_encoding_and_an_older_client_still_gets_bytes() {
        let terminal_id = TerminalId::from_str("01234567-89ab-4def-8123-456789abcdef").unwrap();

        let semantic = serde_json::to_value(TerminalCommand::Attach {
            terminal_id,
            encoding: TerminalTransport::Semantic,
        })
        .unwrap();
        assert_eq!(semantic["encoding"], "semantic");

        let older: TerminalCommand = serde_json::from_value(serde_json::json!({
            "type": "attach",
            "terminalId": terminal_id,
        }))
        .unwrap();
        assert_eq!(
            older,
            TerminalCommand::Attach {
                terminal_id,
                encoding: TerminalTransport::Legacy,
            }
        );

        assert!(
            serde_json::from_value::<TerminalCommand>(serde_json::json!({
                "type": "attach",
                "terminalId": terminal_id,
                "encoding": "guess",
            }))
            .is_err(),
            "an encoding the host does not implement is refused, not guessed"
        );
    }

    /// Input crosses the boundary as what a person did. A client that names
    /// bytes instead of meaning, or a key this host cannot read, is refused
    /// rather than guessed at.
    #[test]
    fn input_names_meaning_on_the_wire_and_never_bytes() {
        let terminal_id = TerminalId::from_str("01234567-89ab-4def-8123-456789abcdef").unwrap();

        let encoded = serde_json::to_value(TerminalCommand::Input {
            terminal_id,
            input: TerminalInput::Key(TerminalKeyEvent {
                action: TerminalKeyAction::Press,
                code: "ArrowUp".to_string(),
                text: None,
                mods: TerminalModifiers::default(),
                composing: false,
            }),
        })
        .unwrap();
        assert_eq!(encoded["type"], "input");
        assert_eq!(encoded["input"]["kind"], "key");
        assert_eq!(encoded["input"]["code"], "ArrowUp");
        assert!(
            encoded["input"].get("dataBase64").is_none(),
            "a semantic input carries no bytes for the host to trust"
        );

        assert!(
            serde_json::from_value::<TerminalCommand>(serde_json::json!({
                "type": "input",
                "terminalId": terminal_id,
                "input": { "kind": "key", "action": "press", "code": "ArrowUp" },
                "unexpected": true,
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<TerminalCommand>(serde_json::json!({
                "type": "input",
                "terminalId": terminal_id,
                "input": { "kind": "telepathy" },
            }))
            .is_err(),
            "an input kind the host does not implement is refused, not guessed"
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
