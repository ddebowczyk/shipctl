//! Immutable identity and root selection for one running Shipctl instance.

pub mod context;
pub mod control;
pub mod leases;
pub mod protocol;

pub use context::{
    inspect_instance, resolve_runtime_root, resolve_state_root, resolve_state_root_read_only,
    InstanceBuildIdentity, InstanceContext, InstanceInspection, InstanceLaunchOptions,
    LaunchProvenance, RootSource,
};
pub use control::{ControlHandler, ControlServer, InstanceDirectory, TerminalAttachmentClient};
pub use leases::InstanceLeases;
pub use protocol::{
    ActiveWorkBlocker, CapabilityCommand, ControlCaller, ControlCompletion,
    ControlCompletionStatus, ControlError, ControlEvent, ControlEventPayload, ControlHello,
    ControlOperation, ControlRequest, ControlResponse, ControlResponseResult, ControlStream,
    DiscoveryProblem, DiscoveryReport, InstanceDiagnosticReport, InstanceRecord, MessageCommand,
    ModuleCommand, ModuleControlStatus, OperationCommand, ScheduleCommand, StopOutcome,
    TerminalAgentReportResult, TerminalAttachmentState, TerminalCloseControlResult,
    TerminalCommand, TerminalControlEvent, TerminalListResult, TerminalReplayFrame,
    TerminalWriteResult, CONTROL_FRAME_SCHEMA_VERSION, TERMINAL_CONTROL_WRITE_MAX_BYTES,
};
/// Caller-owned identity for retryable running-instance mutations.
pub use uuid::Uuid as ControlRequestId;
