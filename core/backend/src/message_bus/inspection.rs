use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::module_control::ModuleInspection;

use super::bridge_contract::{MessageBridgeInspection, MessageBridgeRegistrationObservation};
use super::contracts::{MessageObservation, RedactedMessageContext};
use super::diagnostics::{DRAIN_BLOCKED, MODULE_JOIN_UNAVAILABLE};
use super::MESSAGE_CONTRACT_SCHEMA_VERSION;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageModuleInspection {
    pub registration: MessageBridgeRegistrationObservation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module: Option<ModuleInspection>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageRuntimeInspection {
    pub schema_version: u32,
    pub runtime: MessageBridgeInspection,
    pub modules: Vec<MessageModuleInspection>,
}

impl MessageRuntimeInspection {
    pub fn new(runtime: MessageBridgeInspection, modules: Vec<MessageModuleInspection>) -> Self {
        Self {
            schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
            runtime,
            modules,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageDiagnosticReport {
    pub schema_version: u32,
    pub healthy: bool,
    pub inspection: MessageRuntimeInspection,
    pub diagnostics: Vec<MessageObservation>,
}

pub fn diagnose_message_runtime(inspection: MessageRuntimeInspection) -> MessageDiagnosticReport {
    let generation = inspection.runtime.snapshot.route_generation;
    let mut diagnostics = inspection
        .runtime
        .endpoints
        .iter()
        .filter_map(|endpoint| endpoint.last_failure.clone())
        .collect::<Vec<_>>();
    diagnostics.extend(
        inspection
            .runtime
            .activations
            .iter()
            .filter(|activation| {
                activation.withdrawn && (activation.in_flight > 0 || activation.reply_handles > 0)
            })
            .map(|activation| MessageObservation {
                schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
                code: DRAIN_BLOCKED.to_string(),
                endpoint: None,
                message: None,
                route_generation: generation,
                context: RedactedMessageContext {
                    fields: BTreeMap::from([
                        ("activationId".to_string(), activation.activation_id.clone()),
                        ("inFlight".to_string(), activation.in_flight.to_string()),
                        (
                            "replyHandles".to_string(),
                            activation.reply_handles.to_string(),
                        ),
                    ]),
                },
            }),
    );
    diagnostics.extend(
        inspection
            .modules
            .iter()
            .filter(|module| module.module.is_none())
            .map(|module| MessageObservation {
                schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
                code: MODULE_JOIN_UNAVAILABLE.to_string(),
                endpoint: None,
                message: None,
                route_generation: generation,
                context: RedactedMessageContext {
                    fields: BTreeMap::from([
                        (
                            "activationId".to_string(),
                            module.registration.activation_id.clone(),
                        ),
                        (
                            "moduleId".to_string(),
                            module.registration.module_id.clone(),
                        ),
                    ]),
                },
            }),
    );
    diagnostics.sort_by(|left, right| {
        (&left.code, &left.endpoint, &left.context.fields).cmp(&(
            &right.code,
            &right.endpoint,
            &right.context.fields,
        ))
    });
    MessageDiagnosticReport {
        schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
        healthy: diagnostics.is_empty(),
        inspection,
        diagnostics,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message_bus::{
        ActivationRuntimeObservation, EndpointRuntimeObservation, MessageBridgeInspection,
        MessageBridgeRegistrationObservation, MessageRouteSnapshot,
        MESSAGE_CONTRACT_SCHEMA_VERSION,
    };

    fn observation(code: &str, endpoint: &str) -> MessageObservation {
        MessageObservation {
            schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
            code: code.to_string(),
            endpoint: Some(endpoint.to_string()),
            message: None,
            route_generation: 9,
            context: RedactedMessageContext::default(),
        }
    }

    fn registration() -> MessageBridgeRegistrationObservation {
        MessageBridgeRegistrationObservation {
            module_id: "fixture.module".to_string(),
            activation_id: "fixture@digest#activation".to_string(),
            effective_grants: vec!["message.send.fixture.directed".to_string()],
            contracts: Vec::new(),
            handled_channels: vec!["fixture.directed".to_string()],
            published_topics: Vec::new(),
            subscribed_topics: Vec::new(),
            capability_ports: Vec::new(),
        }
    }

    fn inspection_with_failures() -> MessageRuntimeInspection {
        let failure_codes = [
            super::super::diagnostics::NO_ACTIVE_CHANNEL_OWNER,
            super::super::diagnostics::UNAUTHORIZED_SENDER,
            super::super::diagnostics::SUBSCRIBER_LAG,
            super::super::diagnostics::HANDLER_FAILED,
        ];
        let runtime = MessageBridgeInspection {
            schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
            bridge_count: 1,
            snapshot: MessageRouteSnapshot {
                schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
                instance_id: "fixture".to_string(),
                incarnation: "fixture-incarnation".to_string(),
                route_generation: 9,
                channels: Vec::new(),
                topics: Vec::new(),
                ports: Vec::new(),
            },
            endpoints: failure_codes
                .into_iter()
                .enumerate()
                .map(|(index, code)| EndpointRuntimeObservation {
                    endpoint: format!("fixture.endpoint{index}"),
                    accepted: 1,
                    delivered: 0,
                    failed: 1,
                    lagged: u64::from(code == super::super::diagnostics::SUBSCRIBER_LAG),
                    queued: 0,
                    capacity: 2,
                    last_failure: Some(observation(code, &format!("fixture.endpoint{index}"))),
                })
                .collect(),
            activations: vec![ActivationRuntimeObservation {
                activation_id: "fixture@digest#activation".to_string(),
                withdrawn: true,
                cancelled: true,
                in_flight: 1,
                reply_handles: 1,
            }],
            registrations: vec![registration()],
        };
        MessageRuntimeInspection::new(
            runtime,
            vec![MessageModuleInspection {
                registration: registration(),
                module: None,
            }],
        )
    }

    #[test]
    fn diagnostics_cover_public_failure_modes_without_payload_history() {
        let report = diagnose_message_runtime(inspection_with_failures());
        let codes = report
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>();

        assert!(!report.healthy);
        for expected in [
            super::super::diagnostics::NO_ACTIVE_CHANNEL_OWNER,
            super::super::diagnostics::UNAUTHORIZED_SENDER,
            super::super::diagnostics::SUBSCRIBER_LAG,
            super::super::diagnostics::HANDLER_FAILED,
            super::super::diagnostics::DRAIN_BLOCKED,
            super::super::diagnostics::MODULE_JOIN_UNAVAILABLE,
        ] {
            assert!(codes.contains(&expected), "missing diagnostic {expected}");
        }

        let encoded = serde_json::to_string(&report).unwrap();
        assert!(!encoded.contains("payload"));
        assert!(!encoded.contains("secret-value"));
        assert!(encoded.contains("effectiveGrants"));
        assert!(encoded.contains("routeGeneration"));
    }

    #[test]
    fn empty_runtime_is_healthy_and_strictly_decoded() {
        let mut inspection = inspection_with_failures();
        inspection.runtime.endpoints.clear();
        inspection.runtime.activations.clear();
        inspection.runtime.registrations.clear();
        inspection.modules.clear();
        let report = diagnose_message_runtime(inspection);

        assert!(report.healthy);
        assert!(report.diagnostics.is_empty());

        let mut value = serde_json::to_value(&report.inspection).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("unexpected".to_string(), serde_json::Value::Bool(true));
        assert!(serde_json::from_value::<MessageRuntimeInspection>(value).is_err());
    }
}
