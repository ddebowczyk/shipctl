//! Serializable contracts shared by the core message diagnostics and its
//! Tauri transport adapter.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::module_control::ModuleGrant;
use crate::scheduler::RegisterScheduleInput;

use super::contracts::{
    MessageContractError, MessageDeclarations, MessageEnvelope, MessageRouteSnapshot, MessageTypeId,
};
use super::runtime::{ActivationRuntimeObservation, EndpointRuntimeObservation};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendBridgeRegistration {
    pub module_id: String,
    pub activation_id: String,
    #[serde(default)]
    pub grants: Vec<ModuleGrant>,
    pub declarations: MessageDeclarations,
    /// Declarative schedules are admitted with this registration family.
    /// They are never an imperative plugin activation side effect.
    #[serde(default)]
    pub scheduled_tasks: Vec<RegisterScheduleInput>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageContractSummary {
    pub message: MessageTypeId,
    pub max_encoded_bytes: u64,
    pub compatible_versions: Vec<u32>,
    pub redacted_fields: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageBridgeRegistrationObservation {
    pub module_id: String,
    pub activation_id: String,
    pub effective_grants: Vec<String>,
    pub contracts: Vec<MessageContractSummary>,
    pub handled_channels: Vec<String>,
    pub published_topics: Vec<String>,
    pub subscribed_topics: Vec<String>,
    pub capability_ports: Vec<String>,
}

impl From<&FrontendBridgeRegistration> for MessageBridgeRegistrationObservation {
    fn from(registration: &FrontendBridgeRegistration) -> Self {
        Self {
            module_id: registration.module_id.clone(),
            activation_id: registration.activation_id.clone(),
            effective_grants: registration
                .grants
                .iter()
                .filter(|grant| grant.effective)
                .map(|grant| grant.id.clone())
                .collect(),
            contracts: registration
                .declarations
                .provides
                .iter()
                .map(|contract| MessageContractSummary {
                    message: contract.message.clone(),
                    max_encoded_bytes: contract.schema.max_encoded_bytes,
                    compatible_versions: contract.schema.compatible_versions.clone(),
                    redacted_fields: contract.schema.redacted_fields.clone(),
                })
                .collect(),
            handled_channels: registration
                .declarations
                .handles
                .iter()
                .map(|declaration| declaration.endpoint.id.clone())
                .collect(),
            published_topics: registration
                .declarations
                .publishes
                .iter()
                .map(|declaration| declaration.endpoint.id.clone())
                .collect(),
            subscribed_topics: registration
                .declarations
                .subscribes
                .iter()
                .map(|declaration| declaration.id.clone())
                .collect(),
            capability_ports: registration
                .declarations
                .ports
                .iter()
                .map(|declaration| declaration.id.clone())
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostMessageFrameKind {
    Directed,
    Broadcast,
    PortRequest,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostMessageFrame {
    pub schema_version: u32,
    pub bridge_id: String,
    pub sequence: u64,
    pub route_generation: u64,
    pub activation_id: String,
    pub kind: HostMessageFrameKind,
    pub endpoint: String,
    pub message: MessageTypeId,
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageBridgeOpenReceipt {
    pub schema_version: u32,
    pub bridge_id: String,
    pub snapshot: MessageRouteSnapshot,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageBridgeReply {
    pub correlation_id: String,
    #[serde(default)]
    pub response: Option<MessageEnvelope>,
    #[serde(default)]
    pub error: Option<MessageContractError>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageBridgeInspection {
    pub schema_version: u32,
    pub bridge_count: u64,
    pub snapshot: MessageRouteSnapshot,
    pub endpoints: Vec<EndpointRuntimeObservation>,
    pub activations: Vec<ActivationRuntimeObservation>,
    pub registrations: Vec<MessageBridgeRegistrationObservation>,
}
