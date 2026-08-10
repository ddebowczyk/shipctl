//! Cross-language completeness gate for the terminal event model.
//!
//! `types.rs` is the domain authority. TypeScript has no checked relationship to
//! it, so a new variant or a new required field can reach a client that silently
//! ignores it. This module closes that gap with a generated structural artifact
//! and a compile-enforced loop:
//!
//! * a new `TerminalEvent` variant breaks [`TerminalEventKind::of`];
//! * a new kind breaks [`TerminalEventKind::successor`] and [`sample_event`];
//! * a new required field breaks the struct literal in [`sample_event`];
//! * any of those changes the artifact, and the checked-in copy then fails
//!   [`the_checked_in_contract_matches_the_rust_model`] until it is regenerated;
//! * regenerating it fails the TypeScript decoder suite until the decoder is
//!   taught the new shape.
//!
//! The artifact describes structure only. Ordering and lifecycle meaning are
//! behavior and are covered by trace fixtures, not by a schema.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value as JsonValue;

use super::types::{
    TerminalAgentActivity, TerminalAgentAttention, TerminalAgentAttentionKind,
    TerminalAgentReportSource, TerminalAgentState, TerminalDescriptor, TerminalEvent, TerminalExit,
    TerminalExitReason, TerminalId, TerminalLifecycle, TerminalMetadata, TerminalOwner,
    TerminalReplay, TerminalRevision,
};

/// Largest integer a JavaScript `number` represents exactly.
///
/// Sequences and revisions are `u64` in Rust and `number` in TypeScript. Until
/// the semantic protocol chooses a representation, both sides refuse values
/// above this boundary rather than claim consecutive ordering over values one
/// side cannot hold.
pub const MAX_EXACT_JSON_INTEGER: u64 = 9_007_199_254_740_991;

/// One kind per `TerminalEvent` variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalEventKind {
    Output,
    Replay,
    MetadataChanged,
    AgentActivityChanged,
    Exited,
    ResyncRequired,
    Detached,
}

impl TerminalEventKind {
    /// Exhaustive over `TerminalEvent`: a new variant fails to compile here.
    pub fn of(event: &TerminalEvent) -> Self {
        match event {
            TerminalEvent::Output { .. } => Self::Output,
            TerminalEvent::Replay { .. } => Self::Replay,
            TerminalEvent::MetadataChanged { .. } => Self::MetadataChanged,
            TerminalEvent::AgentActivityChanged { .. } => Self::AgentActivityChanged,
            TerminalEvent::Exited { .. } => Self::Exited,
            TerminalEvent::ResyncRequired { .. } => Self::ResyncRequired,
            TerminalEvent::Detached { .. } => Self::Detached,
        }
    }

    /// Exhaustive over the kinds. Enumeration is derived from this chain rather
    /// than from a hand-maintained list that could go stale.
    fn successor(self) -> Option<Self> {
        match self {
            Self::Output => Some(Self::Replay),
            Self::Replay => Some(Self::MetadataChanged),
            Self::MetadataChanged => Some(Self::AgentActivityChanged),
            Self::AgentActivityChanged => Some(Self::Exited),
            Self::Exited => Some(Self::ResyncRequired),
            Self::ResyncRequired => Some(Self::Detached),
            Self::Detached => None,
        }
    }

    pub fn all() -> Vec<Self> {
        let mut kinds = vec![Self::Output];
        while let Some(next) = kinds[kinds.len() - 1].successor() {
            kinds.push(next);
        }
        kinds
    }
}

/// A fully populated instance of every variant.
///
/// Each arm uses a complete struct literal, so adding a required field to a
/// variant fails to compile until a value for it is chosen here — which is also
/// the point at which the field enters the artifact.
pub fn sample_event(kind: TerminalEventKind) -> TerminalEvent {
    match kind {
        TerminalEventKind::Output => TerminalEvent::Output {
            sequence: 1,
            revision: TerminalRevision(2),
            data: std::sync::Arc::from(b"ok".as_slice()),
        },
        TerminalEventKind::Replay => TerminalEvent::Replay {
            sequence: 2,
            replay: TerminalReplay {
                revision: TerminalRevision(3),
                columns: 80,
                rows: 24,
                bytes: std::sync::Arc::from(b"\x1b[H".as_slice()),
            },
        },
        TerminalEventKind::MetadataChanged => TerminalEvent::MetadataChanged {
            sequence: 3,
            descriptor: sample_descriptor(),
        },
        TerminalEventKind::AgentActivityChanged => TerminalEvent::AgentActivityChanged {
            sequence: 4,
            descriptor: sample_descriptor(),
        },
        TerminalEventKind::Exited => TerminalEvent::Exited {
            sequence: 5,
            descriptor: sample_descriptor(),
        },
        TerminalEventKind::ResyncRequired => TerminalEvent::ResyncRequired {
            sequence: 6,
            reason: "subscriber overflow".to_string(),
        },
        TerminalEventKind::Detached => TerminalEvent::Detached {
            sequence: 7,
            reason: "closed".to_string(),
        },
    }
}

fn sample_descriptor() -> TerminalDescriptor {
    TerminalDescriptor {
        id: TerminalId::default(),
        revision: TerminalRevision(9),
        lifecycle: TerminalLifecycle::Running,
        exit: Some(TerminalExit {
            code: Some(0),
            reason: TerminalExitReason::ProcessExit,
            observed_at_ms: 1,
        }),
        metadata: TerminalMetadata {
            label: "shell".to_string(),
            cwd: PathBuf::from("/repo"),
            project_path: Some(PathBuf::from("/repo")),
            display_command: "zsh".to_string(),
            created_at_ms: 1,
            owner: TerminalOwner::Module {
                module_id: "commands".to_string(),
                owner_key: "commands:dev".to_string(),
                module_session_id: "commands:invocation-one".to_string(),
            },
            owner_metadata: Some(JsonValue::Null),
            presentation: Some(JsonValue::Null),
        },
        columns: 80,
        rows: 24,
        last_output_at_ms: Some(1),
        agent_activity: Some(TerminalAgentActivity {
            revision: 1,
            state: TerminalAgentState::Working,
            message: Some("building".to_string()),
            updated_at_ms: 1,
            source: TerminalAgentReportSource {
                identifier: "claude".to_string(),
                version: "1".to_string(),
            },
            attention: Some(TerminalAgentAttention {
                kind: TerminalAgentAttentionKind::Blocked,
                revision: 1,
            }),
        }),
    }
}

/// Structural description of one wire field.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldContract {
    /// `"string"`, `"number"`, `"boolean"`, `"array"`, `"object"`, or `"null"`.
    pub json_type: String,
    /// True when the sample carries a value; a nullable field is still required
    /// to be present on the wire.
    pub nullable: bool,
}

/// Structural description of one event variant.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariantContract {
    pub tag: String,
    pub fields: BTreeMap<String, FieldContract>,
}

/// The whole checked artifact.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEventContract {
    /// Field carrying the variant tag.
    pub tag_field: String,
    pub max_exact_integer: u64,
    pub variants: Vec<VariantContract>,
}

fn json_type_of(value: &JsonValue) -> &'static str {
    match value {
        JsonValue::Null => "null",
        JsonValue::Bool(_) => "boolean",
        JsonValue::Number(_) => "number",
        JsonValue::String(_) => "string",
        JsonValue::Array(_) => "array",
        JsonValue::Object(_) => "object",
    }
}

/// Build the contract from the authoritative serialization boundary. The shape
/// is read out of serde's own output, not restated by hand.
pub fn terminal_event_contract() -> TerminalEventContract {
    let variants = TerminalEventKind::all()
        .into_iter()
        .map(|kind| {
            let value = serde_json::to_value(sample_event(kind))
                .expect("terminal events must serialize for the contract");
            let object = value
                .as_object()
                .expect("terminal events serialize as tagged objects")
                .clone();
            let tag = object
                .get("event")
                .and_then(JsonValue::as_str)
                .expect("terminal events carry a string tag")
                .to_string();
            let fields = object
                .iter()
                .filter(|(name, _)| name.as_str() != "event")
                .map(|(name, field)| {
                    (
                        name.clone(),
                        FieldContract {
                            json_type: json_type_of(field).to_string(),
                            nullable: field.is_null(),
                        },
                    )
                })
                .collect();
            VariantContract { tag, fields }
        })
        .collect();

    TerminalEventContract {
        tag_field: "event".to_string(),
        max_exact_integer: MAX_EXACT_JSON_INTEGER,
        variants,
    }
}

/// Where the generated artifact lives. The frontend decoder suite reads the
/// same file, so drift is detected on both sides of the boundary.
pub fn contract_artifact_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../core/frontend/terminal/terminalEventContract.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_variant_has_exactly_one_kind_and_one_sample() {
        for kind in TerminalEventKind::all() {
            assert_eq!(TerminalEventKind::of(&sample_event(kind)), kind);
        }
    }

    #[test]
    fn every_variant_carries_an_exact_ordered_sequence() {
        for kind in TerminalEventKind::all() {
            let value = serde_json::to_value(sample_event(kind)).expect("serialize");
            let sequence = value
                .get("sequence")
                .and_then(JsonValue::as_u64)
                .unwrap_or_else(|| panic!("{kind:?} must carry a sequence"));
            assert!(sequence > 0 && sequence <= MAX_EXACT_JSON_INTEGER);
        }
    }

    /// The gate. Regenerate with
    /// `SHIPCTL_WRITE_TERMINAL_CONTRACT=1 cargo test terminal::contract`.
    #[test]
    fn the_checked_in_contract_matches_the_rust_model() {
        let contract = terminal_event_contract();
        let rendered = format!(
            "{}\n",
            serde_json::to_string_pretty(&contract).expect("render contract")
        );
        let path = contract_artifact_path();

        if std::env::var_os("SHIPCTL_WRITE_TERMINAL_CONTRACT").is_some() {
            std::fs::write(&path, &rendered).expect("write contract");
            return;
        }

        let checked_in = std::fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            checked_in, rendered,
            "the terminal event contract is stale; regenerate it with \
             SHIPCTL_WRITE_TERMINAL_CONTRACT=1 and update the TypeScript decoder"
        );
    }
}
