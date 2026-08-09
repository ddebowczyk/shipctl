//! Strict message contracts shared by the instance-local runtime and modules.
//!
//! This capability is deliberately split from Tauri. Contract compilation is
//! artifact-local and has no file, network, or persistence access.

pub mod bridge;
pub mod commands;
pub mod contracts;
pub mod diagnostics;
pub mod inspection;
pub mod routes;
pub mod runtime;

pub use bridge::{
    FrontendBridgeRegistration, HostMessageFrame, HostMessageFrameKind, MessageBridgeInspection,
    MessageBridgeOpenReceipt, MessageBridgeRegistrationObservation, MessageBridgeReply,
    MessageBusBridgeService, MessageContractSummary,
};
pub use contracts::{
    parse_message_wire_json, AcceptedMessageDeclarations, BroadcastRoute,
    BroadcastTopicDeclaration, CapabilityPortDeclaration, CapabilityRoute, CompiledMessageContract,
    DeliveryReceipt, DirectedChannelDeclaration, DirectedRoute, MessageContractError,
    MessageDeclarations, MessageEnvelope, MessageObservation, MessageRouteSnapshot,
    MessageSchemaDescriptor, MessageTypeContract, MessageTypeId, MessageWire,
    ModuleMessageAuthority, PublishReceipt, RedactedMessageContext, RouteEndpointRef,
    MESSAGE_CONTRACT_SCHEMA_VERSION,
};
pub use diagnostics::*;
pub use inspection::{
    diagnose_message_runtime, MessageDiagnosticReport, MessageModuleInspection,
    MessageRuntimeInspection,
};
pub use routes::{
    DirectedHandler, PortHandler, PreparedRegistration, RegistrationHandlers, RuntimeHandlerFuture,
    RuntimePortFuture,
};
pub use runtime::{
    ActivationRuntimeObservation, EndpointRuntimeObservation, RuntimeDelivery, RuntimeMessageBus,
    RuntimeSubscription, SchedulerPreflightError, SchedulerPreflightRequest,
    SchedulerPreflightSnapshot, SchedulerPreflightTargetKind,
};
