use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use shipctl_module_api::TerminalDriverId;
use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;
use uuid::Uuid;

pub fn default_terminal_driver_id() -> TerminalDriverId {
    TerminalDriverId::new("semantic-terminal")
        .expect("the built-in semantic terminal driver id is valid")
}

/// Stable identity of one host-owned terminal runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TerminalId(Uuid);

impl TerminalId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for TerminalId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for TerminalId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for TerminalId {
    type Err = uuid::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(value).map(Self)
    }
}

/// Identity of one disposable observer. It never identifies the process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TerminalAttachmentId(Uuid);

impl TerminalAttachmentId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for TerminalAttachmentId {
    fn default() -> Self {
        Self::new()
    }
}

/// Identity of one renderer subscription to host registry changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TerminalRegistrySubscriptionId(Uuid);

impl TerminalRegistrySubscriptionId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for TerminalRegistrySubscriptionId {
    fn default() -> Self {
        Self::new()
    }
}

/// Monotonic version of public terminal state.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TerminalRevision(pub u64);

impl TerminalRevision {
    pub fn next(self) -> Self {
        Self(
            self.0
                .checked_add(1)
                .expect("terminal revision overflow is a fatal invariant violation"),
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalLifecycle {
    Starting,
    Running,
    Closing,
    Exited,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalExitReason {
    ProcessExit,
    ExplicitClose,
    HostShutdown,
    StartupFailure,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
    pub code: Option<i32>,
    pub reason: TerminalExitReason,
    pub observed_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TerminalOwner {
    Core,
    Module {
        #[serde(rename = "moduleId")]
        module_id: String,
        #[serde(rename = "ownerKey")]
        owner_key: String,
        #[serde(rename = "moduleSessionId")]
        module_session_id: String,
    },
}

/// Public metadata needed to rebuild placement and ownership projections.
///
/// Launch arguments and environment values intentionally do not belong here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMetadata {
    pub label: String,
    pub cwd: PathBuf,
    pub project_path: Option<PathBuf>,
    pub display_command: String,
    pub created_at_ms: u64,
    pub owner: TerminalOwner,
    pub owner_metadata: Option<JsonValue>,
    pub presentation: Option<JsonValue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalAgentReportKind {
    Idle,
    Working,
    Blocked,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalAgentState {
    Idle,
    Working,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalAgentAttentionKind {
    Blocked,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalAgentReportSource {
    pub identifier: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAgentAttention {
    pub kind: TerminalAgentAttentionKind,
    pub revision: u64,
}

/// Supplemental agent state. Host process lifecycle remains authoritative.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAgentActivity {
    pub revision: u64,
    pub state: TerminalAgentState,
    pub message: Option<String>,
    pub updated_at_ms: u64,
    pub source: TerminalAgentReportSource,
    pub attention: Option<TerminalAgentAttention>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalAgentReportRequest {
    pub terminal_id: TerminalId,
    pub kind: TerminalAgentReportKind,
    pub source: TerminalAgentReportSource,
    pub message: Option<String>,
}

/// Agent reports become public descriptor metadata. Their serialized request
/// is bounded by the terminal control path's established 100,000-byte budget,
/// inherited from the replaced renderer ACK contract rather than guessed anew.
pub const TERMINAL_AGENT_REPORT_MAX_BYTES: usize = 100_000;

/// Redacted, transport-safe current state of a terminal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDescriptor {
    pub id: TerminalId,
    #[serde(default = "default_terminal_driver_id")]
    pub driver_id: TerminalDriverId,
    pub revision: TerminalRevision,
    pub lifecycle: TerminalLifecycle,
    pub exit: Option<TerminalExit>,
    pub metadata: TerminalMetadata,
    pub columns: u16,
    pub rows: u16,
    pub last_output_at_ms: Option<u64>,
    pub agent_activity: Option<TerminalAgentActivity>,
}

/// Inventory changes emitted independently from disposable terminal output
/// attachments. `Upserted` carries complete current public state so a client
/// can recover after dropping any earlier notification.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum TerminalRegistryEvent {
    Upserted { descriptor: TerminalDescriptor },
    Removed { terminal_id: TerminalId },
}

/// Ordered event emitted by the host runtime. Transport adapters may encode
/// it for Tauri, the control socket, or tests without becoming process owners.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum TerminalEvent {
    Output {
        sequence: u64,
        revision: TerminalRevision,
        data: std::sync::Arc<[u8]>,
    },
    MetadataChanged {
        sequence: u64,
        descriptor: TerminalDescriptor,
    },
    AgentActivityChanged {
        sequence: u64,
        descriptor: TerminalDescriptor,
    },
    Exited {
        sequence: u64,
        descriptor: TerminalDescriptor,
    },
    ResyncRequired {
        sequence: u64,
        reason: String,
    },
    Detached {
        sequence: u64,
        reason: String,
    },
}

/// Attachment facts for a client that receives and interprets exact child
/// bytes. Unlike [`TerminalAttachment`], this boundary never carries an ANSI
/// replay or a host-rendered terminal state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRawAttachment {
    pub attachment_id: TerminalAttachmentId,
    pub live: bool,
    pub descriptor: TerminalDescriptor,
    pub sequence_boundary: u64,
}

/// Attachment facts for a selected native driver's own presentation stream.
/// The host carries the opaque baseline but never decodes its schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDriverAttachment {
    pub attachment_id: TerminalAttachmentId,
    pub live: bool,
    pub descriptor: TerminalDescriptor,
    pub sequence_boundary: u64,
    pub snapshot: JsonValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCloseResult {
    pub existed: bool,
    pub exit: Option<TerminalExit>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalErrorCode {
    NotFound,
    Exited,
    Closing,
    ShuttingDown,
    InvalidRequest,
    StartupFailed,
    RuntimeStopped,
    Io,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalError {
    pub code: TerminalErrorCode,
    pub message: String,
}

impl TerminalError {
    pub fn new(code: TerminalErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for TerminalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.message.fmt(formatter)
    }
}

impl std::error::Error for TerminalError {}

/// Explicit process-launch semantics. `Shell` is an interactive login shell;
/// `ShellCommand` is a separately named trusted-source boundary; `Program`
/// preserves argv boundaries and never passes through a shell.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TerminalLaunchTarget {
    Shell {
        executable: Option<PathBuf>,
    },
    ShellCommand {
        executable: Option<PathBuf>,
        source: String,
    },
    Program {
        program: PathBuf,
        argv: Vec<String>,
    },
}

/// Private spawn input. This type deliberately has no `Serialize` derive so
/// secrets cannot accidentally become part of list/get responses.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLaunchRequest {
    #[serde(default = "default_terminal_driver_id")]
    pub driver_id: TerminalDriverId,
    pub target: TerminalLaunchTarget,
    pub cwd: PathBuf,
    pub environment: HashMap<String, String>,
    pub columns: u16,
    pub rows: u16,
    pub color_theme: shipctl_module_api::TerminalColorTheme,
    pub metadata: TerminalMetadata,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata() -> TerminalMetadata {
        TerminalMetadata {
            label: "Agent".to_string(),
            cwd: PathBuf::from("/workspace"),
            project_path: Some(PathBuf::from("/workspace")),
            display_command: "assistant".to_string(),
            created_at_ms: 1_786_277_553_000,
            owner: TerminalOwner::Module {
                module_id: "assistants".to_string(),
                owner_key: "agent-7".to_string(),
                module_session_id: "assistant-session-7".to_string(),
            },
            owner_metadata: Some(serde_json::json!({ "model": "example" })),
            presentation: None,
        }
    }

    #[test]
    fn ids_serialize_as_opaque_uuid_strings() {
        let id = TerminalId::new();
        let json = serde_json::to_string(&id).unwrap();

        assert_eq!(serde_json::from_str::<TerminalId>(&json).unwrap(), id);
        assert_eq!(json, format!("\"{id}\""));
    }

    #[test]
    fn descriptor_serialization_excludes_launch_secrets() {
        const ARG_SECRET: &str = "secret-argv-sentinel";
        const ENV_SECRET: &str = "secret-environment-sentinel";
        let launch = TerminalLaunchRequest {
            driver_id: default_terminal_driver_id(),
            target: TerminalLaunchTarget::Program {
                program: PathBuf::from("/usr/bin/assistant"),
                argv: vec!["--token".to_string(), ARG_SECRET.to_string()],
            },
            cwd: PathBuf::from("/workspace"),
            environment: HashMap::from([("API_TOKEN".to_string(), ENV_SECRET.to_string())]),
            columns: 80,
            rows: 24,
            color_theme: shipctl_module_api::TerminalColorTheme {
                foreground: "#ffffff".to_string(),
                background: "#000000".to_string(),
                palette: vec!["#000000".to_string(); 16],
            },
            metadata: metadata(),
        };
        let descriptor = TerminalDescriptor {
            id: TerminalId::new(),
            driver_id: launch.driver_id.clone(),
            revision: TerminalRevision(1),
            lifecycle: TerminalLifecycle::Running,
            exit: None,
            metadata: launch.metadata.clone(),
            columns: launch.columns,
            rows: launch.rows,
            last_output_at_ms: None,
            agent_activity: None,
        };

        let json = serde_json::to_string(&descriptor).unwrap();
        assert!(!json.contains(ARG_SECRET));
        assert!(!json.contains(ENV_SECRET));
        assert!(!json.contains("API_TOKEN"));
        assert!(!json.contains("/usr/bin/assistant"));
    }

    #[test]
    fn owner_metadata_is_json_by_construction() {
        let json = serde_json::to_value(metadata()).unwrap();

        assert_eq!(json["owner"]["type"], "module");
        assert_eq!(json["owner"]["moduleId"], "assistants");
        assert_eq!(json["ownerMetadata"]["model"], "example");
    }
}
