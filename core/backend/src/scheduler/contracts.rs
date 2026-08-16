use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::message_bus::{
    CompiledMessageContract, MessageEnvelope, MessageRouteSnapshot, MessageTypeId, MessageWire,
    MESSAGE_CONTRACT_SCHEMA_VERSION,
};

use super::diagnostics::{
    CRON_INVALID, CRON_TIMEZONE_REQUIRED, DUPLICATE_ID, IDENTIFIER_INVALID, PAYLOAD_INVALID,
    PAYLOAD_TOO_LARGE, SCHEMA_VERSION_UNSUPPORTED, SECRET_PAYLOAD_FORBIDDEN, SOURCE_INVALID,
    SOURCE_PATH_UNSAFE, SOURCE_UNKNOWN_FIELD, TARGET_MESSAGE_INCOMPATIBLE, TARGET_UNAUTHORIZED,
    TARGET_UNAVAILABLE,
};
use super::{ScheduleDiagnostic, ScheduleDiagnosticSeverity};

pub const SCHEDULE_SCHEMA_VERSION: u32 = 1;
pub const SCHEDULE_INSPECTION_SCHEMA_VERSION: u32 = 1;
/// Schema for scheduler control projections sent through the authenticated
/// running-instance endpoint. This is deliberately separate from the source
/// and inspection schemas: changing a control wrapper must not reinterpret a
/// schedule file or an accepted snapshot.
pub const SCHEDULE_CONTROL_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleContractError {
    pub code: String,
    pub message: String,
}

impl ScheduleContractError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }

    pub fn diagnostic(
        &self,
        source_path: Option<String>,
        schedule_id: Option<String>,
    ) -> ScheduleDiagnostic {
        ScheduleDiagnostic {
            schema_version: SCHEDULE_INSPECTION_SCHEMA_VERSION,
            code: self.code.clone(),
            severity: ScheduleDiagnosticSeverity::Error,
            source_path,
            schedule_id,
            context: Default::default(),
        }
    }
}

impl std::fmt::Display for ScheduleContractError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ScheduleContractError {}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleTargetKind {
    Channel,
    Topic,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScheduleTarget {
    pub kind: ScheduleTargetKind,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScheduleMessage {
    #[serde(rename = "type")]
    pub type_id: String,
    pub version: u32,
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScheduleDocument {
    schema_version: u32,
    id: String,
    enabled: bool,
    cron: String,
    target: ScheduleTarget,
    message: ScheduleMessage,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleDefinition {
    pub source_path: String,
    pub schema_version: u32,
    pub id: String,
    pub enabled: bool,
    pub cron: String,
    pub timezone: String,
    pub target: ScheduleTarget,
    pub message: ScheduleMessage,
    pub definition_digest_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleTargetAvailability {
    Unknown,
    Available,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleDeliveryOutcome {
    Delivered,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleDeliverySummary {
    pub occurrence_utc: String,
    pub outcome: ScheduleDeliveryOutcome,
    pub route_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<ScheduleDiagnostic>,
}

/// One committed delivery result. It contains no feature payload.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleDeliveryObservation {
    pub schedule_id: String,
    pub delivery: ScheduleDeliverySummary,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleDefinitionInspection {
    pub id: String,
    pub enabled: bool,
    pub schema_version: u32,
    pub definition_digest_sha256: String,
    pub source_path: String,
    pub cron: String,
    pub timezone: String,
    pub target: ScheduleTarget,
    pub message: MessageTypeId,
    pub schedule_generation: u64,
    pub bus_route_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_occurrence_utc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_attempt: Option<ScheduleDeliverySummary>,
    pub target_availability: ScheduleTargetAvailability,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<ScheduleDiagnostic>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleInspection {
    pub schema_version: u32,
    pub instance_id: String,
    pub incarnation: String,
    pub schedule_generation: u64,
    pub snapshot_digest_sha256: String,
    pub bus_route_generation: u64,
    pub schedules: Vec<ScheduleDefinitionInspection>,
    #[serde(default)]
    pub diagnostics: Vec<ScheduleDiagnostic>,
}

/// A redacted, read-only comparison between the accepted snapshot and the
/// complete directory currently on disk.
///
/// A missing candidate digest means parsing failed; callers must use
/// `diagnostics` rather than attempting to infer a partial candidate. The
/// candidate is never preflighted, published, or used to alter a timer.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleVerification {
    pub schema_version: u32,
    pub code: String,
    pub matches_accepted: bool,
    pub accepted: ScheduleInspection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_digest_sha256: Option<String>,
    #[serde(default)]
    pub diagnostics: Vec<ScheduleDiagnostic>,
}

/// Scheduler health combines accepted source/runtime observations with a
/// read-only source verification. It intentionally carries only inspection
/// facts and redacted diagnostics; message payloads never cross this boundary.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleDiagnosticReport {
    pub schema_version: u32,
    pub code: String,
    pub healthy: bool,
    pub inspection: ScheduleInspection,
    #[serde(default)]
    pub diagnostics: Vec<ScheduleDiagnostic>,
}

/// The outcome of one complete refresh attempt. `inspection` is always the
/// currently accepted state, including after a rejected candidate.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleRefreshReport {
    pub schema_version: u32,
    pub code: String,
    pub applied: bool,
    pub inspection: ScheduleInspection,
    #[serde(default)]
    pub diagnostics: Vec<ScheduleDiagnostic>,
}

/// The redacted result of a manual trigger. The included inspection is taken
/// after the shared delivery path completes, but triggering itself never moves
/// the schedule generation or next occurrence.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleTriggerReport {
    pub schema_version: u32,
    pub code: String,
    pub inspection: ScheduleInspection,
    pub schedule_id: String,
    pub delivery: ScheduleDeliverySummary,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleSnapshot {
    pub generation: u64,
    pub digest_sha256: String,
    pub definitions: Vec<ScheduleDefinition>,
}

impl ScheduleSnapshot {
    pub fn inspection(
        &self,
        instance_id: impl Into<String>,
        incarnation: impl Into<String>,
        bus_route_generation: u64,
    ) -> ScheduleInspection {
        let mut schedules = self
            .definitions
            .iter()
            .map(|definition| ScheduleDefinitionInspection {
                id: definition.id.clone(),
                enabled: definition.enabled,
                schema_version: definition.schema_version,
                definition_digest_sha256: definition.definition_digest_sha256.clone(),
                source_path: definition.source_path.clone(),
                cron: definition.cron.clone(),
                timezone: definition.timezone.clone(),
                target: definition.target.clone(),
                message: MessageTypeId {
                    id: definition.message.type_id.clone(),
                    version: definition.message.version,
                },
                schedule_generation: self.generation,
                bus_route_generation,
                next_occurrence_utc: None,
                last_attempt: None,
                target_availability: ScheduleTargetAvailability::Unknown,
                diagnostic: None,
            })
            .collect::<Vec<_>>();
        schedules.sort_by(|left, right| left.id.cmp(&right.id));
        ScheduleInspection {
            schema_version: SCHEDULE_INSPECTION_SCHEMA_VERSION,
            instance_id: instance_id.into(),
            incarnation: incarnation.into(),
            schedule_generation: self.generation,
            snapshot_digest_sha256: self.digest_sha256.clone(),
            bus_route_generation,
            schedules,
            diagnostics: Vec::new(),
        }
    }
}

pub fn parse_schedule_source(
    source_path: &Path,
    source: &str,
) -> Result<ScheduleDefinition, ScheduleContractError> {
    let source_path = normalized_schedule_path(source_path)?;
    let document: ScheduleDocument = serde_yaml::from_str(source).map_err(|error| {
        let code = if error.to_string().contains("unknown field") {
            SOURCE_UNKNOWN_FIELD
        } else {
            SOURCE_INVALID
        };
        ScheduleContractError::new(
            code,
            "Schedule source is not a supported strict YAML document",
        )
    })?;
    if document.schema_version != SCHEDULE_SCHEMA_VERSION {
        return Err(ScheduleContractError::new(
            SCHEMA_VERSION_UNSUPPORTED,
            format!(
                "Schedule schema version {} is unsupported",
                document.schema_version
            ),
        ));
    }
    let schedule_id = MessageTypeId {
        id: document.id.clone(),
        version: 1,
    };
    schedule_id
        .validate()
        .map_err(|_| ScheduleContractError::new(IDENTIFIER_INVALID, "Schedule id is invalid"))?;
    let target_id = MessageTypeId {
        id: document.target.id.clone(),
        version: 1,
    };
    target_id.validate().map_err(|_| {
        ScheduleContractError::new(IDENTIFIER_INVALID, "Schedule target id is invalid")
    })?;
    let message = MessageTypeId {
        id: document.message.type_id.clone(),
        version: document.message.version,
    };
    message.validate().map_err(|_| {
        ScheduleContractError::new(IDENTIFIER_INVALID, "Schedule message id is invalid")
    })?;
    let timezone = validate_cron(&document.cron)?;
    let definition_digest_sha256 = digest(&canonical_json(&document)?);

    Ok(ScheduleDefinition {
        source_path,
        schema_version: document.schema_version,
        id: document.id,
        enabled: document.enabled,
        cron: document.cron,
        timezone,
        target: document.target,
        message: document.message,
        definition_digest_sha256,
    })
}

pub fn schedule_snapshot(
    generation: u64,
    mut definitions: Vec<ScheduleDefinition>,
) -> Result<ScheduleSnapshot, ScheduleContractError> {
    definitions.sort_by(|left, right| left.source_path.cmp(&right.source_path));
    let mut ids = BTreeSet::new();
    for definition in &definitions {
        if !ids.insert(definition.id.clone()) {
            return Err(ScheduleContractError::new(
                DUPLICATE_ID,
                "Candidate schedule snapshot contains a duplicate schedule id",
            ));
        }
    }
    let digest_sha256 = digest(&canonical_json(&definitions)?);
    Ok(ScheduleSnapshot {
        generation,
        digest_sha256,
        definitions,
    })
}

pub struct ScheduleContractCatalog {
    routes: MessageRouteSnapshot,
    contracts: BTreeMap<MessageTypeId, CompiledMessageContract>,
}

impl ScheduleContractCatalog {
    pub fn new(
        routes: MessageRouteSnapshot,
        contracts: impl IntoIterator<Item = CompiledMessageContract>,
    ) -> Result<Self, ScheduleContractError> {
        routes.validate().map_err(|_| {
            ScheduleContractError::new(TARGET_UNAVAILABLE, "Message route snapshot is invalid")
        })?;
        let mut accepted = BTreeMap::new();
        for contract in contracts {
            let message = contract.contract().message.clone();
            if accepted.insert(message, contract).is_some() {
                return Err(ScheduleContractError::new(
                    TARGET_MESSAGE_INCOMPATIBLE,
                    "Active message contracts must not contain duplicate message versions",
                ));
            }
        }
        Ok(Self {
            routes,
            contracts: accepted,
        })
    }

    pub fn validate(&self, definition: &ScheduleDefinition) -> Result<(), ScheduleContractError> {
        let message = MessageTypeId {
            id: definition.message.type_id.clone(),
            version: definition.message.version,
        };
        let scheduler_allowed = match definition.target.kind {
            ScheduleTargetKind::Channel => self
                .routes
                .channels
                .iter()
                .find(|route| route.endpoint.id == definition.target.id)
                .map(|route| (route.endpoint.message.clone(), route.scheduler_allowed)),
            ScheduleTargetKind::Topic => self
                .routes
                .topics
                .iter()
                .find(|route| route.endpoint.id == definition.target.id)
                .map(|route| (route.endpoint.message.clone(), route.scheduler_allowed)),
        }
        .ok_or_else(|| {
            ScheduleContractError::new(TARGET_UNAVAILABLE, "Scheduled target is not active")
        })?;
        if scheduler_allowed.0 != message {
            return Err(ScheduleContractError::new(
                TARGET_MESSAGE_INCOMPATIBLE,
                "Scheduled message does not match the target contract",
            ));
        }
        if !scheduler_allowed.1 {
            return Err(ScheduleContractError::new(
                TARGET_UNAUTHORIZED,
                "Scheduled target does not authorize the core scheduler",
            ));
        }
        let contract = self.contracts.get(&message).ok_or_else(|| {
            ScheduleContractError::new(
                TARGET_MESSAGE_INCOMPATIBLE,
                "Scheduled message contract is not active",
            )
        })?;
        if contains_secret_payload(
            &definition.message.payload,
            &contract.contract().schema.redacted_fields,
        ) {
            return Err(ScheduleContractError::new(
                SECRET_PAYLOAD_FORBIDDEN,
                "Schedule payload contains a field marked secret by its message contract",
            ));
        }
        contract
            .validate_envelope(&MessageEnvelope {
                schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
                endpoint: definition.target.id.clone(),
                message,
                payload: definition.message.payload.clone(),
                correlation_id: None,
            })
            .map_err(|error| match error.code.as_str() {
                "message.payload.too_large" => ScheduleContractError::new(
                    PAYLOAD_TOO_LARGE,
                    "Schedule payload exceeds its message bound",
                ),
                _ => ScheduleContractError::new(
                    PAYLOAD_INVALID,
                    "Schedule payload does not satisfy its message contract",
                ),
            })
    }
}

pub fn normalized_schedule_path(path: &Path) -> Result<String, ScheduleContractError> {
    let components = path.components().collect::<Vec<_>>();
    if components.len() != 1 || !matches!(components.as_slice(), [Component::Normal(_)]) {
        return Err(ScheduleContractError::new(
            SOURCE_PATH_UNSAFE,
            "Schedules must be direct files below the schedule root",
        ));
    }
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| {
            !value.contains('\\') && (value.ends_with(".yaml") || value.ends_with(".yml"))
        })
        .ok_or_else(|| {
            ScheduleContractError::new(
                SOURCE_PATH_UNSAFE,
                "Schedule files must use a .yaml or .yml extension",
            )
        })?;
    Ok(filename.to_string())
}

fn validate_cron(cron: &str) -> Result<String, ScheduleContractError> {
    let fields = cron.split_ascii_whitespace().collect::<Vec<_>>();
    let timezone = fields.last().copied().filter(|value| value.contains('/'));
    if fields.len() != 6 || timezone.is_none() {
        return Err(ScheduleContractError::new(
            CRON_TIMEZONE_REQUIRED,
            "Schedule cron expressions require five fields and an explicit IANA timezone",
        ));
    }
    cronexpr::parse_crontab(cron).map_err(|_| {
        ScheduleContractError::new(CRON_INVALID, "Schedule cron expression is invalid")
    })?;
    Ok(timezone.expect("checked above").to_string())
}

fn contains_secret_payload(payload: &Value, redacted_fields: &[String]) -> bool {
    redacted_fields
        .iter()
        .any(|pointer| json_pointer(payload, pointer).is_some())
}

fn json_pointer<'a>(mut value: &'a Value, pointer: &str) -> Option<&'a Value> {
    if pointer.is_empty() {
        return Some(value);
    }
    for raw_segment in pointer.strip_prefix('/')?.split('/') {
        let segment = raw_segment.replace("~1", "/").replace("~0", "~");
        value = match value {
            Value::Object(values) => values.get(&segment)?,
            Value::Array(values) => values.get(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(value)
}

fn canonical_json<T: Serialize>(value: &T) -> Result<Vec<u8>, ScheduleContractError> {
    let value = serde_json::to_value(value).map_err(|_| {
        ScheduleContractError::new(
            SOURCE_INVALID,
            "Schedule definition cannot be canonicalized",
        )
    })?;
    serde_json::to_vec(&canonicalize_json(value)).map_err(|_| {
        ScheduleContractError::new(
            SOURCE_INVALID,
            "Schedule definition cannot be canonicalized",
        )
    })
}

/// `serde_json` may preserve input object order when another workspace
/// dependency enables that feature. Digest identity is semantic, so normalize
/// every nested object explicitly instead of relying on the crate feature set.
fn canonicalize_json(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize_json).collect()),
        Value::Object(values) => {
            let ordered = values
                .into_iter()
                .map(|(key, value)| (key, canonicalize_json(value)))
                .collect::<BTreeMap<_, _>>();
            Value::Object(ordered.into_iter().collect())
        }
        value => value,
    }
}

fn digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::message_bus::contracts::JSON_SCHEMA_DRAFT_2020_12;
    use crate::message_bus::{
        BroadcastRoute, DirectedRoute, MessageSchemaDescriptor, MessageTypeContract,
        RouteEndpointRef,
    };

    use super::*;

    const VALID_CHANNEL: &str = include_str!("../../fixtures/scheduler/sources/valid-channel.yaml");
    const VALID_TOPIC: &str = include_str!("../../fixtures/scheduler/sources/valid-topic.yaml");
    const DISABLED: &str = include_str!("../../fixtures/scheduler/sources/disabled.yaml");
    const DST_AUSTRALIA: &str = include_str!("../../fixtures/scheduler/sources/dst-australia.yaml");
    const UNKNOWN_FIELD: &str =
        include_str!("../../fixtures/scheduler/sources/invalid-unknown-field.yaml");
    const UNSUPPORTED_VERSION: &str =
        include_str!("../../fixtures/scheduler/sources/invalid-version.yaml");
    const INVALID_CRON: &str = include_str!("../../fixtures/scheduler/sources/invalid-cron.yaml");
    const MISSING_TIMEZONE: &str =
        include_str!("../../fixtures/scheduler/sources/invalid-no-timezone.yaml");
    const DUPLICATE_A: &str = include_str!("../../fixtures/scheduler/sources/duplicate-a.yaml");
    const DUPLICATE_B: &str = include_str!("../../fixtures/scheduler/sources/duplicate-b.yaml");
    const INVALID_PAYLOAD: &str =
        include_str!("../../fixtures/scheduler/sources/invalid-payload.yaml");
    const OVERSIZED_PAYLOAD: &str =
        include_str!("../../fixtures/scheduler/sources/oversized-payload.yaml");
    const SECRET_PAYLOAD: &str =
        include_str!("../../fixtures/scheduler/sources/secret-payload.yaml");
    const UNAVAILABLE_TARGET: &str =
        include_str!("../../fixtures/scheduler/sources/unavailable-target.yaml");
    const INCOMPATIBLE_TARGET: &str =
        include_str!("../../fixtures/scheduler/sources/incompatible-target.yaml");
    const UNAUTHORIZED_TARGET: &str =
        include_str!("../../fixtures/scheduler/sources/unauthorized-target.yaml");
    const CANONICAL_ORDER_A: &str =
        include_str!("../../fixtures/scheduler/sources/canonical-order-a.yaml");
    const CANONICAL_ORDER_B: &str =
        include_str!("../../fixtures/scheduler/sources/canonical-order-b.yaml");
    const INSPECTION_GOLDEN: &str = include_str!("../../fixtures/scheduler/inspection.json");

    fn fixture_contract(
        max_encoded_bytes: u64,
        redacted_fields: Vec<String>,
    ) -> CompiledMessageContract {
        MessageTypeContract {
            message: MessageTypeId {
                id: "fixture.agent-wakeup".to_string(),
                version: 1,
            },
            schema: MessageSchemaDescriptor {
                draft: JSON_SCHEMA_DRAFT_2020_12.to_string(),
                root: "schemas/schedule-message.json".to_string(),
                resources: BTreeMap::from([(
                    "schemas/schedule-message.json".to_string(),
                    json!({
                        "$schema": JSON_SCHEMA_DRAFT_2020_12,
                        "$id": "shipctl-artifact:///schemas/schedule-message.json",
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["reason"],
                        "properties": {
                            "reason": { "type": "string" },
                            "apiToken": { "type": "string" }
                        }
                    }),
                )]),
                max_encoded_bytes,
                redacted_fields,
                compatible_versions: vec![1],
            },
        }
        .compile()
        .unwrap()
    }

    fn routes(
        channel: Option<(&str, MessageTypeId, bool)>,
        topic: Option<(&str, MessageTypeId, bool)>,
    ) -> MessageRouteSnapshot {
        MessageRouteSnapshot {
            schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
            instance_id: "fixture-instance".to_string(),
            incarnation: "fixture-incarnation".to_string(),
            route_generation: 7,
            channels: channel
                .map(|(id, message, scheduler_allowed)| {
                    vec![DirectedRoute {
                        endpoint: RouteEndpointRef {
                            id: id.to_string(),
                            message,
                        },
                        owner_activation_id: "fixture-owner".to_string(),
                        capacity: 1,
                        scheduler_allowed,
                    }]
                })
                .unwrap_or_default(),
            topics: topic
                .map(|(id, message, scheduler_allowed)| {
                    vec![BroadcastRoute {
                        endpoint: RouteEndpointRef {
                            id: id.to_string(),
                            message,
                        },
                        subscriber_count: 1,
                        capacity: 1,
                        scheduler_allowed,
                    }]
                })
                .unwrap_or_default(),
            ports: Vec::new(),
        }
    }

    fn fixture_message() -> MessageTypeId {
        MessageTypeId {
            id: "fixture.agent-wakeup".to_string(),
            version: 1,
        }
    }

    #[test]
    fn shared_valid_schedule_fixtures_have_explicit_iana_timezones() {
        let fixtures = [
            ("channel.yaml", VALID_CHANNEL, "Europe/Warsaw"),
            ("topic.yml", VALID_TOPIC, "America/New_York"),
            ("disabled.yaml", DISABLED, "Europe/Warsaw"),
            ("dst.yaml", DST_AUSTRALIA, "Australia/Sydney"),
        ];
        for (path, source, timezone) in fixtures {
            let parsed = parse_schedule_source(Path::new(path), source).unwrap();
            assert_eq!(parsed.timezone, timezone, "{path}");
        }
        assert!(
            !parse_schedule_source(Path::new("disabled.yaml"), DISABLED)
                .unwrap()
                .enabled
        );
    }

    #[test]
    fn strict_schedule_source_has_stable_definition_and_snapshot_digests() {
        let first = parse_schedule_source(Path::new("one.yaml"), VALID_CHANNEL).unwrap();
        let second = parse_schedule_source(Path::new("two.yml"), VALID_CHANNEL).unwrap();
        assert_eq!(
            first.definition_digest_sha256,
            second.definition_digest_sha256
        );

        let ordered = schedule_snapshot(3, vec![first.clone(), second.clone()]);
        assert_eq!(ordered.unwrap_err().code, DUPLICATE_ID);

        let a = ScheduleDefinition {
            id: "agents.one".to_string(),
            source_path: "z.yml".to_string(),
            ..first
        };
        let b = ScheduleDefinition {
            id: "agents.two".to_string(),
            source_path: "a.yml".to_string(),
            ..second
        };
        let left = schedule_snapshot(3, vec![a.clone(), b.clone()]).unwrap();
        let right = schedule_snapshot(3, vec![b, a]).unwrap();
        assert_eq!(left.digest_sha256, right.digest_sha256);
        assert_eq!(left.definitions[0].source_path, "a.yml");
    }

    #[test]
    fn canonical_digests_ignore_nested_payload_object_order() {
        let first =
            parse_schedule_source(Path::new("canonical-a.yaml"), CANONICAL_ORDER_A).unwrap();
        let second =
            parse_schedule_source(Path::new("canonical-b.yaml"), CANONICAL_ORDER_B).unwrap();
        assert_eq!(
            first.definition_digest_sha256,
            second.definition_digest_sha256
        );

        let first = ScheduleDefinition {
            source_path: "canonical.yaml".to_string(),
            ..first
        };
        let second = ScheduleDefinition {
            source_path: "canonical.yaml".to_string(),
            ..second
        };
        assert_eq!(
            schedule_snapshot(4, vec![first]).unwrap().digest_sha256,
            schedule_snapshot(4, vec![second]).unwrap().digest_sha256
        );
    }

    #[test]
    fn rust_produces_the_exact_shared_scheduler_inspection_golden() {
        let definitions = [
            ("valid-channel.yaml", VALID_CHANNEL),
            ("valid-topic.yaml", VALID_TOPIC),
            ("disabled.yaml", DISABLED),
            ("dst-australia.yaml", DST_AUSTRALIA),
        ]
        .into_iter()
        .map(|(path, source)| parse_schedule_source(Path::new(path), source).unwrap())
        .collect();
        let snapshot = schedule_snapshot(7, definitions).unwrap();
        let inspection = snapshot.inspection(
            "fixture-instance",
            "00000000-0000-4000-8000-000000000001",
            11,
        );
        let expected = serde_json::from_str::<Value>(INSPECTION_GOLDEN)
            .unwrap()
            .get("valid")
            .cloned()
            .unwrap();
        assert_eq!(serde_json::to_value(inspection).unwrap(), expected);
    }

    #[test]
    fn shared_invalid_source_fixtures_have_stable_diagnostics() {
        for (path, source, code) in [
            ("unknown.yaml", UNKNOWN_FIELD, SOURCE_UNKNOWN_FIELD),
            (
                "version.yaml",
                UNSUPPORTED_VERSION,
                SCHEMA_VERSION_UNSUPPORTED,
            ),
            ("cron.yaml", INVALID_CRON, CRON_INVALID),
            ("timezone.yaml", MISSING_TIMEZONE, CRON_TIMEZONE_REQUIRED),
        ] {
            assert_eq!(
                parse_schedule_source(Path::new(path), source)
                    .unwrap_err()
                    .code,
                code
            );
        }
    }

    #[test]
    fn strict_schedule_source_rejects_unsafe_paths_and_duplicate_candidate_ids() {
        assert_eq!(
            parse_schedule_source(Path::new("nested/wakeup.yaml"), VALID_CHANNEL)
                .unwrap_err()
                .code,
            SOURCE_PATH_UNSAFE
        );
        assert_eq!(
            parse_schedule_source(Path::new("nested\\wakeup.yaml"), VALID_CHANNEL)
                .unwrap_err()
                .code,
            SOURCE_PATH_UNSAFE
        );
        let first = parse_schedule_source(Path::new("duplicate-a.yaml"), DUPLICATE_A).unwrap();
        let second = parse_schedule_source(Path::new("duplicate-b.yml"), DUPLICATE_B).unwrap();
        assert_eq!(
            schedule_snapshot(1, vec![first, second]).unwrap_err().code,
            DUPLICATE_ID
        );
    }

    #[test]
    fn catalog_enforces_active_target_contracts_authorization_and_payload_policy() {
        let channel = parse_schedule_source(Path::new("channel.yaml"), VALID_CHANNEL).unwrap();
        let topic = parse_schedule_source(Path::new("topic.yaml"), VALID_TOPIC).unwrap();
        let unavailable =
            parse_schedule_source(Path::new("unavailable.yaml"), UNAVAILABLE_TARGET).unwrap();
        let incompatible =
            parse_schedule_source(Path::new("incompatible.yaml"), INCOMPATIBLE_TARGET).unwrap();
        let unauthorized =
            parse_schedule_source(Path::new("unauthorized.yaml"), UNAUTHORIZED_TARGET).unwrap();

        let catalog = ScheduleContractCatalog::new(
            routes(Some(("agents.wakeup", fixture_message(), true)), None),
            [fixture_contract(128, Vec::new())],
        )
        .unwrap();
        catalog.validate(&channel).unwrap();

        let catalog = ScheduleContractCatalog::new(
            routes(None, Some(("agents.status", fixture_message(), true))),
            [fixture_contract(128, Vec::new())],
        )
        .unwrap();
        catalog.validate(&topic).unwrap();

        let unavailable_catalog =
            ScheduleContractCatalog::new(routes(None, None), [fixture_contract(128, Vec::new())])
                .unwrap();
        assert_eq!(
            unavailable_catalog.validate(&unavailable).unwrap_err().code,
            TARGET_UNAVAILABLE
        );

        let incompatible_catalog = ScheduleContractCatalog::new(
            routes(
                Some((
                    "agents.incompatible",
                    MessageTypeId {
                        id: "fixture.other".to_string(),
                        version: 1,
                    },
                    true,
                )),
                None,
            ),
            [fixture_contract(128, Vec::new())],
        )
        .unwrap();
        assert_eq!(
            incompatible_catalog
                .validate(&incompatible)
                .unwrap_err()
                .code,
            TARGET_MESSAGE_INCOMPATIBLE
        );

        let unauthorized_catalog = ScheduleContractCatalog::new(
            routes(
                Some(("agents.unauthorized", fixture_message(), false)),
                None,
            ),
            [fixture_contract(128, Vec::new())],
        )
        .unwrap();
        assert_eq!(
            unauthorized_catalog
                .validate(&unauthorized)
                .unwrap_err()
                .code,
            TARGET_UNAUTHORIZED
        );

        let payload_catalog = ScheduleContractCatalog::new(
            routes(
                Some(("agents.invalid-payload", fixture_message(), true)),
                None,
            ),
            [fixture_contract(128, Vec::new())],
        )
        .unwrap();
        let invalid_payload =
            parse_schedule_source(Path::new("invalid-payload.yaml"), INVALID_PAYLOAD).unwrap();
        assert_eq!(
            payload_catalog.validate(&invalid_payload).unwrap_err().code,
            PAYLOAD_INVALID
        );

        let oversized_catalog = ScheduleContractCatalog::new(
            routes(Some(("agents.oversized", fixture_message(), true)), None),
            [fixture_contract(24, Vec::new())],
        )
        .unwrap();
        let oversized =
            parse_schedule_source(Path::new("oversized.yaml"), OVERSIZED_PAYLOAD).unwrap();
        assert_eq!(
            oversized_catalog.validate(&oversized).unwrap_err().code,
            PAYLOAD_TOO_LARGE
        );

        let secret_catalog = ScheduleContractCatalog::new(
            routes(Some(("agents.secret", fixture_message(), true)), None),
            [fixture_contract(128, vec!["/apiToken".to_string()])],
        )
        .unwrap();
        let secret = parse_schedule_source(Path::new("secret.yaml"), SECRET_PAYLOAD).unwrap();
        assert_eq!(
            secret_catalog.validate(&secret).unwrap_err().code,
            SECRET_PAYLOAD_FORBIDDEN
        );
    }

    #[test]
    fn catalog_rejects_duplicate_active_message_contracts() {
        let result = ScheduleContractCatalog::new(
            routes(Some(("agents.wakeup", fixture_message(), true)), None),
            [
                fixture_contract(128, Vec::new()),
                fixture_contract(128, Vec::new()),
            ],
        );
        let error = match result {
            Ok(_) => panic!("duplicate active message contracts must be rejected"),
            Err(error) => error,
        };
        assert_eq!(error.code, TARGET_MESSAGE_INCOMPATIBLE);
    }
}
