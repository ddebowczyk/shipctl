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
pub use control::{ControlHandler, ControlServer, InstanceDirectory};
pub use leases::InstanceLeases;
pub use protocol::{
    ActiveWorkBlocker, ControlCaller, ControlCompletion, ControlCompletionStatus, ControlError,
    ControlEvent, ControlEventPayload, ControlHello, ControlOperation, ControlRequest,
    ControlResponse, ControlResponseResult, ControlStream, DiscoveryProblem, DiscoveryReport,
    InstanceDiagnosticReport, InstanceRecord, MessageCommand, ModuleCommand, ModuleControlStatus,
    OperationCommand, StopOutcome, CONTROL_FRAME_SCHEMA_VERSION,
};
