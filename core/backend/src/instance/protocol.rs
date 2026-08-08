use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::context::InstanceBuildIdentity;
use crate::state::archive::StateArchiveInspection;

pub const CONTROL_FRAME_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWorkBlocker {
    pub kind: String,
    pub count: usize,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceRecord {
    pub instance_id: Uuid,
    pub name: String,
    pub build: InstanceBuildIdentity,
    pub process_id: u32,
    pub process_started_at: u64,
    pub state_root: PathBuf,
    pub runtime_root: PathBuf,
    pub endpoint_protocol: String,
    pub lifecycle: InstanceLifecycle,
    pub active_work: Vec<ActiveWorkBlocker>,
    pub state_fingerprint: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstanceLifecycle {
    Ready,
    Stopping,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlError {
    pub code: Box<String>,
    pub message: Box<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_selector: Option<Box<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_instance_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_root: Option<Box<PathBuf>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<Box<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed: Option<Box<String>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blockers: Vec<ActiveWorkBlocker>,
}

impl ControlError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: Box::new(code.into()),
            message: Box::new(message.into()),
            requested_selector: None,
            resolved_instance_id: None,
            state_root: None,
            expected: None,
            observed: None,
            blockers: Vec::new(),
        }
    }

    pub fn for_context(mut self, instance_id: Uuid, state_root: PathBuf) -> Self {
        self.resolved_instance_id = Some(instance_id);
        self.state_root = Some(Box::new(state_root));
        self
    }

    pub fn with_selector(mut self, selector: impl Into<String>) -> Self {
        self.requested_selector = Some(Box::new(selector.into()));
        self
    }

    pub fn with_expected_observed(
        mut self,
        expected: impl Into<String>,
        observed: impl Into<String>,
    ) -> Self {
        self.expected = Some(Box::new(expected.into()));
        self.observed = Some(Box::new(observed.into()));
        self
    }

    pub fn with_blockers(mut self, blockers: Vec<ActiveWorkBlocker>) -> Self {
        self.blockers = blockers;
        self
    }
}

impl std::fmt::Display for ControlError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ControlError {}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryProblem {
    pub descriptor_path: PathBuf,
    pub category: DiscoveryProblemCategory,
    pub error: ControlError,
    pub reclaimed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryProblemCategory {
    Stale,
    Unauthorized,
    Incompatible,
    HandshakeFailed,
    InvalidDescriptor,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryReport {
    pub instances: Vec<InstanceRecord>,
    pub problems: Vec<DiscoveryProblem>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopOutcome {
    pub instance: InstanceRecord,
    pub accepted: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredDescriptor {
    pub descriptor_schema_version: u32,
    pub instance: InstanceRecord,
    pub endpoint: String,
    pub auth_token: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControlRequest {
    pub frame_schema_version: u32,
    pub control_protocol_version: u32,
    pub request_id: Uuid,
    pub auth_token: String,
    pub operation: ControlOperation,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub(crate) enum ControlOperation {
    Ping,
    Inspect,
    SaveState { destination: PathBuf },
    Shutdown { force: bool },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControlResponse {
    pub frame_schema_version: u32,
    pub request_id: Uuid,
    pub result: Option<ControlResponseResult>,
    pub error: Option<ControlError>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type", content = "value")]
pub(crate) enum ControlResponseResult {
    Instance(InstanceRecord),
    StateArchive(StateArchiveInspection),
    Stop(StopOutcome),
}

impl ControlResponse {
    pub fn success(request_id: Uuid, result: ControlResponseResult) -> Self {
        Self {
            frame_schema_version: CONTROL_FRAME_SCHEMA_VERSION,
            request_id,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(request_id: Uuid, error: ControlError) -> Self {
        Self {
            frame_schema_version: CONTROL_FRAME_SCHEMA_VERSION,
            request_id,
            result: None,
            error: Some(error),
        }
    }
}
