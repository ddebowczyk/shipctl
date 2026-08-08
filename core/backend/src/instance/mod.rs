//! Immutable identity and root selection for one running Shipctl instance.

pub mod context;
pub mod control;
pub mod leases;
pub mod protocol;

pub use context::{
    inspect_instance, resolve_runtime_root, resolve_state_root, InstanceBuildIdentity,
    InstanceContext, InstanceInspection, InstanceLaunchOptions, LaunchProvenance, RootSource,
};
pub use control::{ControlHandler, ControlServer, InstanceDirectory};
pub use leases::InstanceLeases;
pub use protocol::{
    ActiveWorkBlocker, ControlCompletion, ControlCompletionStatus, ControlError, ControlEvent,
    ControlEventPayload, ControlOperation, ControlRequest, ControlResponse, ControlResponseResult,
    ControlStream, DiscoveryProblem, DiscoveryReport, InstanceRecord, ModuleCommand,
    OperationCommand, StopOutcome, CONTROL_FRAME_SCHEMA_VERSION,
};
