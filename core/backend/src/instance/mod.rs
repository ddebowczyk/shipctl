//! Immutable identity and root selection for one running Shipctl instance.

pub mod context;
pub mod control;
pub mod leases;
pub mod protocol;

pub use context::{
    default_state_root_name, resolve_runtime_root, resolve_state_root, resolve_state_root_for,
    resolve_state_root_read_only, InstanceBuildIdentity, InstanceContext, InstanceInspection,
    InstanceLaunchOptions, LaunchProvenance, RootSource, DEFAULT_INSTANCE_NAME,
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
    TerminalCommand, TerminalControlEvent, TerminalDriverResult, TerminalListResult,
    TerminalWriteResult, CONTROL_FRAME_SCHEMA_VERSION, TERMINAL_CONTROL_WRITE_MAX_BYTES,
};
/// Caller-owned identity for retryable running-instance mutations.
pub use uuid::Uuid as ControlRequestId;
