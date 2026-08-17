use std::collections::{BTreeMap, BTreeSet};

use jsonschema::{Registry, Resource, Validator};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

use crate::module_control::ModuleGrant;

use super::diagnostics::{
    BOUND_REQUIRED, INCOMPATIBLE_MESSAGE_VERSION, INVALID_IDENTIFIER, INVALID_JSON,
    INVALID_PAYLOAD, INVALID_SCHEMA, PAYLOAD_TOO_LARGE, SCHEMA_REFERENCE_FORBIDDEN,
    SCHEMA_VERSION_UNSUPPORTED, SECRET_LEAKAGE, UNAUTHORIZED_SENDER, UNKNOWN_FIELD,
    UNKNOWN_MESSAGE_CONTRACT,
};

pub const MESSAGE_CONTRACT_SCHEMA_VERSION: u32 = 1;
pub const JSON_SCHEMA_DRAFT_2020_12: &str = "https://json-schema.org/draft/2020-12/schema";
const ARTIFACT_SCHEMA_BASE: &str = "shipctl-artifact:///";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageContractError {
    pub code: String,
    pub message: String,
}

impl MessageContractError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for MessageContractError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for MessageContractError {}

pub trait MessageWire: DeserializeOwned {
    fn schema_version(&self) -> u32;
    fn validate(&self) -> Result<(), MessageContractError>;
}

pub fn parse_message_wire_json<T: MessageWire>(source: &str) -> Result<T, MessageContractError> {
    let value: Value = serde_json::from_str(source).map_err(|error| {
        MessageContractError::new(INVALID_JSON, format!("Message JSON is invalid: {error}"))
    })?;
    let schema_version = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            MessageContractError::new(
                SCHEMA_VERSION_UNSUPPORTED,
                "Message schemaVersion is required",
            )
        })?;
    if schema_version != MESSAGE_CONTRACT_SCHEMA_VERSION as u64 {
        return Err(MessageContractError::new(
            SCHEMA_VERSION_UNSUPPORTED,
            format!(
                "Message schemaVersion {schema_version} is unsupported; expected {MESSAGE_CONTRACT_SCHEMA_VERSION}"
            ),
        ));
    }
    let wire: T = serde_json::from_value(value).map_err(|error| {
        let code = if error.to_string().contains("unknown field") {
            UNKNOWN_FIELD
        } else {
            INVALID_JSON
        };
        MessageContractError::new(code, format!("Message shape is invalid: {error}"))
    })?;
    wire.validate()?;
    Ok(wire)
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageTypeId {
    pub id: String,
    pub version: u32,
}

impl MessageTypeId {
    pub fn validate(&self) -> Result<(), MessageContractError> {
        if !valid_scoped_id(&self.id) || self.version == 0 {
            return Err(MessageContractError::new(
                INVALID_IDENTIFIER,
                "Message identifiers require dotted lowercase segments and a non-zero version",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageSchemaDescriptor {
    pub draft: String,
    pub root: String,
    pub resources: BTreeMap<String, Value>,
    pub max_encoded_bytes: u64,
    pub redacted_fields: Vec<String>,
    pub compatible_versions: Vec<u32>,
}

impl MessageSchemaDescriptor {
    fn validate_shape(&self, message: &MessageTypeId) -> Result<(), MessageContractError> {
        if self.draft != JSON_SCHEMA_DRAFT_2020_12 {
            return Err(MessageContractError::new(
                INVALID_SCHEMA,
                "Message schemas must declare JSON Schema Draft 2020-12",
            ));
        }
        if self.max_encoded_bytes == 0 || self.compatible_versions.is_empty() {
            return Err(MessageContractError::new(
                BOUND_REQUIRED,
                "Message schemas require a non-zero encoded-size bound and compatible versions",
            ));
        }
        let versions = self
            .compatible_versions
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        if versions.len() != self.compatible_versions.len()
            || versions.contains(&0)
            || !versions.contains(&message.version)
        {
            return Err(MessageContractError::new(
                INCOMPATIBLE_MESSAGE_VERSION,
                "Compatible versions must be unique, non-zero, and include the contract version",
            ));
        }
        if !valid_artifact_path(&self.root) || !self.resources.contains_key(&self.root) {
            return Err(MessageContractError::new(
                INVALID_SCHEMA,
                "Schema root must name a declared artifact-local resource",
            ));
        }
        let redactions = self.redacted_fields.iter().collect::<BTreeSet<_>>();
        if redactions.len() != self.redacted_fields.len()
            || self
                .redacted_fields
                .iter()
                .any(|pointer| !valid_json_pointer(pointer))
        {
            return Err(MessageContractError::new(
                INVALID_SCHEMA,
                "Redacted fields must be unique JSON pointers",
            ));
        }
        for (path, schema) in &self.resources {
            if !valid_artifact_path(path)
                || schema.get("$schema").and_then(Value::as_str) != Some(&self.draft)
            {
                return Err(MessageContractError::new(
                    INVALID_SCHEMA,
                    "Every schema resource requires a normalized artifact path and the accepted draft",
                ));
            }
            let expected_id = artifact_schema_uri(path);
            if schema.get("$id").and_then(Value::as_str) != Some(expected_id.as_str()) {
                return Err(MessageContractError::new(
                    INVALID_SCHEMA,
                    format!("Schema resource {path:?} must use $id {expected_id:?}"),
                ));
            }
            validate_schema_references(path, schema, &self.resources)?;
            jsonschema::draft202012::meta::validate(schema).map_err(|error| {
                MessageContractError::new(
                    INVALID_SCHEMA,
                    format!("Schema resource {path:?} is invalid: {error}"),
                )
            })?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageTypeContract {
    pub message: MessageTypeId,
    pub schema: MessageSchemaDescriptor,
}

impl MessageTypeContract {
    pub fn compile(&self) -> Result<CompiledMessageContract, MessageContractError> {
        self.message.validate()?;
        self.schema.validate_shape(&self.message)?;

        let pairs = self.schema.resources.iter().map(|(path, schema)| {
            (
                artifact_schema_uri(path),
                Resource::from_contents(schema.clone()),
            )
        });
        let registry = Registry::new()
            .extend(pairs)
            .map_err(|error| {
                MessageContractError::new(
                    INVALID_SCHEMA,
                    format!("Schema registry is invalid: {error}"),
                )
            })?
            .prepare()
            .map_err(|error| {
                MessageContractError::new(
                    INVALID_SCHEMA,
                    format!("Schema registry is invalid: {error}"),
                )
            })?;
        let root = self
            .schema
            .resources
            .get(&self.schema.root)
            .expect("validated schema root");
        let validator = jsonschema::draft202012::options()
            .with_registry(&registry)
            .build(root)
            .map_err(|error| {
                MessageContractError::new(INVALID_SCHEMA, format!("Schema cannot compile: {error}"))
            })?;

        Ok(CompiledMessageContract {
            contract: self.clone(),
            validator,
        })
    }
}

pub struct CompiledMessageContract {
    contract: MessageTypeContract,
    validator: Validator,
}

impl std::fmt::Debug for CompiledMessageContract {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CompiledMessageContract")
            .field("message", &self.contract.message)
            .finish_non_exhaustive()
    }
}

impl CompiledMessageContract {
    pub fn contract(&self) -> &MessageTypeContract {
        &self.contract
    }

    pub fn validate_envelope(
        &self,
        envelope: &MessageEnvelope,
    ) -> Result<(), MessageContractError> {
        envelope.validate()?;
        if envelope.message.id != self.contract.message.id {
            return Err(MessageContractError::new(
                UNKNOWN_MESSAGE_CONTRACT,
                format!(
                    "Message contract {:?} is not installed",
                    envelope.message.id
                ),
            ));
        }
        if !self
            .contract
            .schema
            .compatible_versions
            .contains(&envelope.message.version)
        {
            return Err(MessageContractError::new(
                INCOMPATIBLE_MESSAGE_VERSION,
                format!(
                    "Message version {} is not accepted",
                    envelope.message.version
                ),
            ));
        }
        let encoded = serde_json::to_vec(&envelope.payload).map_err(|error| {
            MessageContractError::new(INVALID_PAYLOAD, format!("Payload cannot encode: {error}"))
        })?;
        if encoded.len() as u64 > self.contract.schema.max_encoded_bytes {
            return Err(MessageContractError::new(
                PAYLOAD_TOO_LARGE,
                format!(
                    "Encoded payload is {} bytes; maximum is {}",
                    encoded.len(),
                    self.contract.schema.max_encoded_bytes
                ),
            ));
        }
        self.validator.validate(&envelope.payload).map_err(|error| {
            MessageContractError::new(INVALID_PAYLOAD, format!("Payload is invalid: {error}"))
        })
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteEndpointRef {
    pub id: String,
    pub message: MessageTypeId,
}

impl RouteEndpointRef {
    fn validate(&self) -> Result<(), MessageContractError> {
        if !valid_scoped_id(&self.id) {
            return Err(MessageContractError::new(
                INVALID_IDENTIFIER,
                "Route endpoint identifiers require dotted lowercase segments",
            ));
        }
        self.message.validate()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectedChannelDeclaration {
    pub endpoint: RouteEndpointRef,
    pub capacity: u32,
    pub required_grant: String,
    pub scheduler_allowed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BroadcastTopicDeclaration {
    pub endpoint: RouteEndpointRef,
    pub capacity: u32,
    pub required_grant: String,
    pub scheduler_allowed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityPortDeclaration {
    pub id: String,
    pub request: MessageTypeId,
    pub response: MessageTypeId,
    pub capacity: u32,
    pub required_grant: String,
    pub scheduler_allowed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageDeclarations {
    pub schema_version: u32,
    #[serde(default)]
    pub provides: Vec<MessageTypeContract>,
    #[serde(default)]
    pub handles: Vec<DirectedChannelDeclaration>,
    #[serde(default)]
    pub publishes: Vec<BroadcastTopicDeclaration>,
    #[serde(default)]
    pub subscribes: Vec<RouteEndpointRef>,
    #[serde(default)]
    pub ports: Vec<CapabilityPortDeclaration>,
}

impl MessageDeclarations {
    /// Accept one artifact's declarations and retain exactly one compiled
    /// validator per provided message contract for the artifact lifetime.
    pub fn prepare(self) -> Result<AcceptedMessageDeclarations, MessageContractError> {
        self.validate()?;
        let mut contracts = BTreeMap::new();
        for contract in &self.provides {
            contracts.insert(contract.message.clone(), contract.compile()?);
        }
        Ok(AcceptedMessageDeclarations {
            declarations: self,
            contracts,
        })
    }
}

#[derive(Debug)]
pub struct AcceptedMessageDeclarations {
    declarations: MessageDeclarations,
    contracts: BTreeMap<MessageTypeId, CompiledMessageContract>,
}

impl AcceptedMessageDeclarations {
    pub fn declarations(&self) -> &MessageDeclarations {
        &self.declarations
    }

    pub fn contract(&self, message: &MessageTypeId) -> Option<&CompiledMessageContract> {
        self.contracts.get(message)
    }
}

impl MessageWire for MessageDeclarations {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn validate(&self) -> Result<(), MessageContractError> {
        validate_schema_version(self.schema_version)?;
        let contracts = self
            .provides
            .iter()
            .map(|contract| contract.message.clone())
            .collect::<BTreeSet<_>>();
        if contracts.len() != self.provides.len() {
            return Err(MessageContractError::new(
                INVALID_IDENTIFIER,
                "Message contracts must have unique identifiers and versions",
            ));
        }
        for contract in &self.provides {
            contract.message.validate()?;
            contract.schema.validate_shape(&contract.message)?;
        }
        let mut endpoints = BTreeSet::new();
        for channel in &self.handles {
            channel.endpoint.validate()?;
            validate_bound_and_grant(channel.capacity, &channel.required_grant)?;
            if !contracts.contains(&channel.endpoint.message)
                || !endpoints.insert(channel.endpoint.id.clone())
            {
                return Err(MessageContractError::new(
                    UNKNOWN_MESSAGE_CONTRACT,
                    "Handled channels must uniquely reference provided message contracts",
                ));
            }
        }
        for topic in &self.publishes {
            topic.endpoint.validate()?;
            validate_bound_and_grant(topic.capacity, &topic.required_grant)?;
            if !contracts.contains(&topic.endpoint.message)
                || !endpoints.insert(topic.endpoint.id.clone())
            {
                return Err(MessageContractError::new(
                    UNKNOWN_MESSAGE_CONTRACT,
                    "Published topics must uniquely reference provided message contracts",
                ));
            }
        }
        for subscription in &self.subscribes {
            subscription.validate()?;
        }
        for port in &self.ports {
            if !valid_scoped_id(&port.id) {
                return Err(MessageContractError::new(
                    INVALID_IDENTIFIER,
                    "Capability port identifiers require dotted lowercase segments",
                ));
            }
            port.request.validate()?;
            port.response.validate()?;
            validate_bound_and_grant(port.capacity, &port.required_grant)?;
            if !contracts.contains(&port.request)
                || !contracts.contains(&port.response)
                || !endpoints.insert(port.id.clone())
            {
                return Err(MessageContractError::new(
                    UNKNOWN_MESSAGE_CONTRACT,
                    "Capability ports must uniquely reference provided request and response contracts",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModuleMessageAuthority {
    activation_id: String,
    effective_grants: BTreeSet<String>,
}

impl ModuleMessageAuthority {
    pub fn from_host(activation_id: impl Into<String>, grants: &[ModuleGrant]) -> Self {
        Self {
            activation_id: activation_id.into(),
            effective_grants: grants
                .iter()
                .filter(|grant| grant.effective)
                .map(|grant| grant.id.clone())
                .collect(),
        }
    }

    pub fn activation_id(&self) -> &str {
        &self.activation_id
    }

    pub fn authorize(&self, required_grant: &str) -> Result<(), MessageContractError> {
        if self.effective_grants.contains(required_grant) {
            Ok(())
        } else {
            Err(MessageContractError::new(
                UNAUTHORIZED_SENDER,
                format!("Activation lacks required grant {required_grant:?}"),
            ))
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageEnvelope {
    pub schema_version: u32,
    pub endpoint: String,
    pub message: MessageTypeId,
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
}

impl MessageWire for MessageEnvelope {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn validate(&self) -> Result<(), MessageContractError> {
        validate_schema_version(self.schema_version)?;
        if !valid_scoped_id(&self.endpoint) {
            return Err(MessageContractError::new(
                INVALID_IDENTIFIER,
                "Envelope endpoint is invalid",
            ));
        }
        self.message.validate()?;
        if self
            .correlation_id
            .as_ref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err(MessageContractError::new(
                INVALID_IDENTIFIER,
                "Correlation identifiers cannot be empty",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryReceipt {
    pub schema_version: u32,
    pub endpoint: String,
    pub message: MessageTypeId,
    pub route_generation: u64,
}

impl MessageWire for DeliveryReceipt {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn validate(&self) -> Result<(), MessageContractError> {
        validate_schema_version(self.schema_version)?;
        if !valid_scoped_id(&self.endpoint) {
            return Err(MessageContractError::new(
                INVALID_IDENTIFIER,
                "Receipt endpoint is invalid",
            ));
        }
        self.message.validate()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishReceipt {
    pub schema_version: u32,
    pub endpoint: String,
    pub message: MessageTypeId,
    pub route_generation: u64,
    pub subscriber_count: u32,
}

impl MessageWire for PublishReceipt {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn validate(&self) -> Result<(), MessageContractError> {
        validate_schema_version(self.schema_version)?;
        if !valid_scoped_id(&self.endpoint) {
            return Err(MessageContractError::new(
                INVALID_IDENTIFIER,
                "Receipt endpoint is invalid",
            ));
        }
        self.message.validate()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectedRoute {
    pub endpoint: RouteEndpointRef,
    pub owner_activation_id: String,
    pub capacity: u32,
    pub scheduler_allowed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BroadcastRoute {
    pub endpoint: RouteEndpointRef,
    pub subscriber_count: u32,
    pub capacity: u32,
    pub scheduler_allowed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityRoute {
    pub id: String,
    pub request: MessageTypeId,
    pub response: MessageTypeId,
    pub owner_activation_id: String,
    pub capacity: u32,
    pub scheduler_allowed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageRouteSnapshot {
    pub schema_version: u32,
    pub instance_id: String,
    pub incarnation: String,
    pub route_generation: u64,
    #[serde(default)]
    pub channels: Vec<DirectedRoute>,
    #[serde(default)]
    pub topics: Vec<BroadcastRoute>,
    #[serde(default)]
    pub ports: Vec<CapabilityRoute>,
}

impl MessageWire for MessageRouteSnapshot {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn validate(&self) -> Result<(), MessageContractError> {
        validate_schema_version(self.schema_version)?;
        if self.instance_id.trim().is_empty() || self.incarnation.trim().is_empty() {
            return Err(MessageContractError::new(
                INVALID_IDENTIFIER,
                "Route snapshots require instance and incarnation identities",
            ));
        }
        let mut endpoints = BTreeSet::new();
        for channel in &self.channels {
            channel.endpoint.validate()?;
            if channel.owner_activation_id.trim().is_empty()
                || channel.capacity == 0
                || !endpoints.insert(channel.endpoint.id.clone())
            {
                return Err(MessageContractError::new(
                    BOUND_REQUIRED,
                    "Directed routes require one owner, a non-zero capacity, and a unique endpoint",
                ));
            }
        }
        for topic in &self.topics {
            topic.endpoint.validate()?;
            if topic.capacity == 0 || !endpoints.insert(topic.endpoint.id.clone()) {
                return Err(MessageContractError::new(
                    BOUND_REQUIRED,
                    "Broadcast routes require a non-zero capacity and a unique endpoint",
                ));
            }
        }
        for port in &self.ports {
            port.request.validate()?;
            port.response.validate()?;
            if !valid_scoped_id(&port.id)
                || port.owner_activation_id.trim().is_empty()
                || port.capacity == 0
                || !endpoints.insert(port.id.clone())
            {
                return Err(MessageContractError::new(
                    BOUND_REQUIRED,
                    "Capability routes require one owner, a non-zero capacity, and a unique endpoint",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RedactedMessageContext {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, String>,
}

impl RedactedMessageContext {
    fn validate(&self) -> Result<(), MessageContractError> {
        for (key, value) in &self.fields {
            let sensitive_key = [
                "secret",
                "token",
                "password",
                "credential",
                "authorization",
                "api_key",
            ]
            .iter()
            .any(|needle| key.to_ascii_lowercase().contains(needle));
            let secret_value = ["bearer ", "ghp_", "sk-", "xoxb-"]
                .iter()
                .any(|needle| value.to_ascii_lowercase().contains(needle));
            if (sensitive_key && value != "[redacted]") || secret_value {
                return Err(MessageContractError::new(
                    SECRET_LEAKAGE,
                    format!("Message diagnostic field {key:?} contains secret material"),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageObservation {
    pub schema_version: u32,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<MessageTypeId>,
    pub route_generation: u64,
    #[serde(default)]
    pub context: RedactedMessageContext,
}

impl MessageWire for MessageObservation {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn validate(&self) -> Result<(), MessageContractError> {
        validate_schema_version(self.schema_version)?;
        if !super::diagnostics::PUBLIC_CODES.contains(&self.code.as_str())
            || self
                .endpoint
                .as_ref()
                .is_some_and(|id| !valid_scoped_id(id))
        {
            return Err(MessageContractError::new(
                INVALID_IDENTIFIER,
                "Observation code or endpoint is invalid",
            ));
        }
        if let Some(message) = &self.message {
            message.validate()?;
        }
        self.context.validate()
    }
}

fn validate_schema_version(version: u32) -> Result<(), MessageContractError> {
    if version == MESSAGE_CONTRACT_SCHEMA_VERSION {
        Ok(())
    } else {
        Err(MessageContractError::new(
            SCHEMA_VERSION_UNSUPPORTED,
            format!("Message schemaVersion {version} is unsupported"),
        ))
    }
}

fn validate_bound_and_grant(capacity: u32, grant: &str) -> Result<(), MessageContractError> {
    if capacity == 0 {
        return Err(MessageContractError::new(
            BOUND_REQUIRED,
            "Route capacity must be non-zero",
        ));
    }
    if !valid_grant_id(grant) {
        return Err(MessageContractError::new(
            INVALID_IDENTIFIER,
            "Required grant must use the message.<action>.<endpoint> vocabulary",
        ));
    }
    Ok(())
}

fn valid_grant_id(value: &str) -> bool {
    let mut segments = value.split('.');
    if !matches!(segments.next(), Some("message"))
        || !matches!(
            segments.next(),
            Some("send" | "publish" | "request" | "handle" | "subscribe")
        )
    {
        return false;
    }
    let endpoint = segments.collect::<Vec<_>>();
    !endpoint.is_empty() && endpoint.into_iter().all(valid_id_segment)
}

fn valid_scoped_id(value: &str) -> bool {
    let segments = value.split('.').collect::<Vec<_>>();
    segments.len() >= 2 && segments.iter().copied().all(valid_id_segment)
}

fn valid_id_segment(segment: &str) -> bool {
    let mut characters = segment.chars();
    matches!(characters.next(), Some(character) if character.is_ascii_lowercase())
        && characters.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}

fn valid_artifact_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && path
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn artifact_schema_uri(path: &str) -> String {
    format!("{ARTIFACT_SCHEMA_BASE}{path}")
}

fn valid_json_pointer(pointer: &str) -> bool {
    pointer.starts_with('/') && pointer.split('/').skip(1).all(valid_pointer_escapes)
}

fn valid_pointer_escapes(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'~' {
            index += 1;
            if index == bytes.len() || !matches!(bytes[index], b'0' | b'1') {
                return false;
            }
        }
        index += 1;
    }
    true
}

fn validate_schema_references(
    source_path: &str,
    value: &Value,
    resources: &BTreeMap<String, Value>,
) -> Result<(), MessageContractError> {
    match value {
        Value::Object(object) => {
            if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
                validate_schema_reference(source_path, reference, resources)?;
            }
            for child in object.values() {
                validate_schema_references(source_path, child, resources)?;
            }
        }
        Value::Array(array) => {
            for child in array {
                validate_schema_references(source_path, child, resources)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_schema_reference(
    source_path: &str,
    reference: &str,
    resources: &BTreeMap<String, Value>,
) -> Result<(), MessageContractError> {
    if reference.starts_with('#') {
        return Ok(());
    }
    let path = reference.split('#').next().unwrap_or_default();
    if path.is_empty()
        || path.contains(':')
        || path.starts_with('/')
        || path.contains('\\')
        || path
            .split('/')
            .any(|segment| segment == ".." || segment == ".")
    {
        return Err(MessageContractError::new(
            SCHEMA_REFERENCE_FORBIDDEN,
            format!("Schema reference {reference:?} is not artifact-local"),
        ));
    }
    let parent = source_path
        .rsplit_once('/')
        .map_or("", |(parent, _)| parent);
    let resolved = if parent.is_empty() {
        path.to_string()
    } else {
        format!("{parent}/{path}")
    };
    if !resources.contains_key(&resolved) {
        return Err(MessageContractError::new(
            INVALID_SCHEMA,
            format!("Schema reference {reference:?} does not name a declared resource"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    use super::*;

    const GOLDENS: &str = include_str!("../../../../module-api/fixtures/protocol/messages.json");

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Goldens {
        schema_version: u32,
        valid: GoldenValid,
        invalid: Vec<GoldenInvalid>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct GoldenValid {
        declarations: Value,
        envelope: Value,
        delivery_receipt: Value,
        publish_receipt: Value,
        route_snapshot: Value,
        observation: Value,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct GoldenInvalid {
        name: String,
        target: String,
        value: Value,
        expected_code: String,
    }

    fn parse<T: MessageWire>(value: &Value) -> Result<T, MessageContractError> {
        parse_message_wire_json(&serde_json::to_string(value).unwrap())
    }

    #[test]
    fn message_bus_valid_goldens_round_trip_and_compile_once() {
        let fixtures: Goldens = serde_json::from_str(GOLDENS).unwrap();
        assert_eq!(fixtures.schema_version, MESSAGE_CONTRACT_SCHEMA_VERSION);
        let declarations = parse::<MessageDeclarations>(&fixtures.valid.declarations).unwrap();
        let accepted = declarations.clone().prepare().unwrap();
        let envelope = parse::<MessageEnvelope>(&fixtures.valid.envelope).unwrap();
        accepted
            .contract(&envelope.message)
            .unwrap()
            .validate_envelope(&envelope)
            .unwrap();

        let values = [
            serde_json::to_value(&declarations).unwrap(),
            serde_json::to_value(parse::<MessageEnvelope>(&fixtures.valid.envelope).unwrap())
                .unwrap(),
            serde_json::to_value(
                parse::<DeliveryReceipt>(&fixtures.valid.delivery_receipt).unwrap(),
            )
            .unwrap(),
            serde_json::to_value(parse::<PublishReceipt>(&fixtures.valid.publish_receipt).unwrap())
                .unwrap(),
            serde_json::to_value(
                parse::<MessageRouteSnapshot>(&fixtures.valid.route_snapshot).unwrap(),
            )
            .unwrap(),
            serde_json::to_value(parse::<MessageObservation>(&fixtures.valid.observation).unwrap())
                .unwrap(),
        ];
        let expected = [
            fixtures.valid.declarations,
            fixtures.valid.envelope,
            fixtures.valid.delivery_receipt,
            fixtures.valid.publish_receipt,
            fixtures.valid.route_snapshot,
            fixtures.valid.observation,
        ];
        assert_eq!(values, expected);
    }

    #[test]
    fn message_bus_invalid_goldens_have_exact_stable_codes() {
        let fixtures: Goldens = serde_json::from_str(GOLDENS).unwrap();
        for fixture in fixtures.invalid {
            let result = match fixture.target.as_str() {
                "declarations" => parse::<MessageDeclarations>(&fixture.value).map(|_| ()),
                "envelope" => parse::<MessageEnvelope>(&fixture.value).map(|_| ()),
                "observation" => parse::<MessageObservation>(&fixture.value).map(|_| ()),
                "payload" => {
                    let declarations =
                        parse::<MessageDeclarations>(&fixtures.valid.declarations).unwrap();
                    let compiled = declarations.provides[0].compile().unwrap();
                    parse::<MessageEnvelope>(&fixture.value)
                        .and_then(|envelope| compiled.validate_envelope(&envelope))
                }
                "authorization" => {
                    let authority = ModuleMessageAuthority::from_host(
                        "fixture-activation",
                        &[ModuleGrant {
                            id: "message.publish.fixture.agent-status".into(),
                            effective: true,
                        }],
                    );
                    authority.authorize(fixture.value.as_str().unwrap())
                }
                target => panic!("unknown invalid fixture target {target:?}"),
            };
            assert_eq!(
                result.unwrap_err().code,
                fixture.expected_code,
                "fixture {}",
                fixture.name
            );
        }
    }

    #[test]
    fn message_bus_authority_is_host_bound_and_does_not_accept_module_identity() {
        let authority = ModuleMessageAuthority::from_host(
            "fixture-activation",
            &[ModuleGrant {
                id: "message.send.fixture.agent-wakeup".into(),
                effective: true,
            }],
        );
        assert_eq!(authority.activation_id(), "fixture-activation");
        authority
            .authorize("message.send.fixture.agent-wakeup")
            .unwrap();
        assert_eq!(
            authority
                .authorize("message.publish.fixture.agent-status")
                .unwrap_err()
                .code,
            UNAUTHORIZED_SENDER
        );
    }

    #[test]
    fn message_bus_payload_size_is_measured_after_json_encoding() {
        let mut declarations = parse::<MessageDeclarations>(
            &serde_json::from_str::<Goldens>(GOLDENS)
                .unwrap()
                .valid
                .declarations,
        )
        .unwrap();
        declarations.provides[0].schema.max_encoded_bytes = 2;
        let compiled = declarations.provides[0].compile().unwrap();
        let envelope = MessageEnvelope {
            schema_version: 1,
            endpoint: "fixture.agent-wakeup".into(),
            message: MessageTypeId {
                id: "fixture.agent-wakeup".into(),
                version: 1,
            },
            payload: json!({"agentId": "agent-1", "apiToken": "secret"}),
            correlation_id: None,
        };
        assert_eq!(
            compiled.validate_envelope(&envelope).unwrap_err().code,
            PAYLOAD_TOO_LARGE
        );
    }
}
