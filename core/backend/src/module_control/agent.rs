//! Agent-safe access to capabilities provided by the active restart-bound module set.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::instance::ControlError;
use crate::message_bus::{
    MessageEnvelope, MessageTypeId, RuntimeMessageBus, MESSAGE_CONTRACT_SCHEMA_VERSION,
};

use super::artifact::{CapabilityDefinition, CapabilityProviderBinding, ValidatedRuntimeArtifact};
use super::live::ModuleControlService;
use super::{ModuleIdentity, MODULE_CONTROL_SCHEMA_VERSION};

pub const CAPABILITY_RUNTIME_LISTED: &str = "capability.runtime.listed";
pub const CAPABILITY_RUNTIME_INSPECTED: &str = "capability.runtime.inspected";
pub const CAPABILITY_RUNTIME_INVOKED: &str = "capability.runtime.invoked";
pub const CAPABILITY_RUNTIME_ABSENT: &str = "capability.runtime.absent";
pub const CAPABILITY_RUNTIME_AMBIGUOUS: &str = "capability.runtime.ambiguous";
pub const CAPABILITY_PORT_NOT_AGENT_CALLABLE: &str = "capability.port.not_agent_callable";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActiveCapabilityProvider {
    pub module: ModuleIdentity,
    pub binding: CapabilityProviderBinding,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActiveCapabilityInspection {
    pub schema_version: u32,
    pub definition: CapabilityDefinition,
    pub providers: Vec<ActiveCapabilityProvider>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActiveCapabilityCatalog {
    pub schema_version: u32,
    pub route_generation: u64,
    pub capabilities: Vec<ActiveCapabilityInspection>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityInvocation {
    pub schema_version: u32,
    pub capability_id: String,
    pub capability_version: String,
    pub provider_module_id: String,
    pub port_id: String,
    pub response_message: MessageTypeId,
    pub response: Value,
    pub route_generation: u64,
}

#[derive(Clone)]
pub struct AgentCapabilityService {
    modules: ModuleControlService,
    bus: RuntimeMessageBus,
}

impl AgentCapabilityService {
    pub fn new(modules: ModuleControlService, bus: RuntimeMessageBus) -> Self {
        Self { modules, bus }
    }

    pub fn list(&self) -> Result<ActiveCapabilityCatalog, ControlError> {
        let artifacts = self.modules.active_runtime_artifacts()?;
        let definitions = self.modules.capability_catalog()?.definitions;
        let mut capabilities = definitions
            .into_iter()
            .filter(|definition| definition.agent_access.inspect)
            .filter_map(|definition| {
                let providers = providers_for(&artifacts, &definition);
                (!providers.is_empty()).then_some(ActiveCapabilityInspection {
                    schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                    definition,
                    providers,
                })
            })
            .collect::<Vec<_>>();
        capabilities.sort_by(|left, right| {
            left.definition
                .id
                .cmp(&right.definition.id)
                .then_with(|| left.definition.version.cmp(&right.definition.version))
        });
        Ok(ActiveCapabilityCatalog {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            route_generation: self.bus.snapshot().route_generation,
            capabilities,
        })
    }

    pub fn inspect(&self, capability_id: &str) -> Result<ActiveCapabilityInspection, ControlError> {
        let matches = self
            .list()?
            .capabilities
            .into_iter()
            .filter(|capability| capability.definition.id == capability_id)
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [capability] => Ok(capability.clone()),
            [] => Err(ControlError::new(
                CAPABILITY_RUNTIME_ABSENT,
                format!("Active agent-visible capability {capability_id:?} is absent"),
            )),
            _ => Err(ControlError::new(
                CAPABILITY_RUNTIME_AMBIGUOUS,
                format!("Capability {capability_id:?} has multiple active versions"),
            )),
        }
    }

    pub async fn call(
        &self,
        capability_id: &str,
        port_id: &str,
        payload: Value,
    ) -> Result<CapabilityInvocation, ControlError> {
        let capability = self.inspect(capability_id)?;
        if !capability
            .definition
            .agent_access
            .invoke
            .iter()
            .any(|allowed| allowed == port_id)
        {
            return Err(ControlError::new(
                CAPABILITY_PORT_NOT_AGENT_CALLABLE,
                format!("Port {port_id:?} is not exposed to agents"),
            ));
        }
        let providers = capability
            .providers
            .iter()
            .filter(|provider| {
                provider
                    .binding
                    .surfaces
                    .ports
                    .iter()
                    .any(|id| id == port_id)
            })
            .collect::<Vec<_>>();
        let [provider] = providers.as_slice() else {
            return Err(ControlError::new(
                if providers.is_empty() {
                    CAPABILITY_RUNTIME_ABSENT
                } else {
                    CAPABILITY_RUNTIME_AMBIGUOUS
                },
                format!("Port {port_id:?} does not resolve to exactly one active provider"),
            ));
        };
        let port = capability
            .definition
            .ports
            .iter()
            .find(|port| port.id == port_id)
            .ok_or_else(|| {
                ControlError::new(
                    CAPABILITY_PORT_NOT_AGENT_CALLABLE,
                    format!("Port {port_id:?} is absent from the capability definition"),
                )
            })?;
        let response = self
            .bus
            .request_from_agent(MessageEnvelope {
                schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
                endpoint: port.id.clone(),
                message: port.request.clone(),
                payload,
                correlation_id: None,
            })
            .await
            .map_err(|error| ControlError::new(error.code, error.message))?;
        Ok(CapabilityInvocation {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            capability_id: capability.definition.id,
            capability_version: capability.definition.version,
            provider_module_id: provider.module.id.clone(),
            port_id: port.id.clone(),
            response_message: response.message,
            response: response.payload,
            route_generation: self.bus.snapshot().route_generation,
        })
    }
}

fn providers_for(
    artifacts: &[ValidatedRuntimeArtifact],
    definition: &CapabilityDefinition,
) -> Vec<ActiveCapabilityProvider> {
    let reference = definition.reference();
    let mut providers = artifacts
        .iter()
        .flat_map(|artifact| {
            let module = artifact.identity();
            let reference = reference.clone();
            artifact
                .canonical_metadata()
                .manifest
                .capabilities
                .providers
                .into_iter()
                .filter(move |binding| binding.capability == reference)
                .map(move |binding| ActiveCapabilityProvider {
                    module: module.clone(),
                    binding,
                })
        })
        .collect::<Vec<_>>();
    providers.sort_by(|left, right| left.module.id.cmp(&right.module.id));
    providers
}
