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
use shipctl_module_api::TerminalColorTheme;

use super::effects::TerminalEffect;
#[cfg(test)]
use super::input::{
    TerminalInput, TerminalKeyAction, TerminalKeyEvent, TerminalModifiers, TerminalMouseAction,
    TerminalMouseButton, TerminalMouseEvent, TerminalSurfaceGeometry,
};
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
    Screen,
    Effects,
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
            TerminalEvent::Screen { .. } => Self::Screen,
            TerminalEvent::Effects { .. } => Self::Effects,
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
            Self::Replay => Some(Self::Screen),
            Self::Screen => Some(Self::Effects),
            Self::Effects => Some(Self::MetadataChanged),
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
        TerminalEventKind::Screen => TerminalEvent::Screen {
            sequence: 3,
            revision: TerminalRevision(4),
            state: std::sync::Arc::new(super::wire::TerminalScreenSnapshot::from_projection(
                sample_projection(),
            )),
        },
        TerminalEventKind::Effects => TerminalEvent::Effects {
            sequence: 4,
            effects: vec![TerminalEffect::Bell],
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

/// A real projection of a real terminal.
///
/// Written by the host's own parser rather than restated as a literal: the
/// projection is a large tree, and a hand-written copy of it here would be a
/// second model that can disagree with the first. The artifact records the
/// field as an object; what an object of that shape contains is proved by
/// `projection.rs` and the recorded corpus.
fn sample_projection() -> super::projection::TerminalProjection {
    let theme = TerminalColorTheme {
        foreground: "#ffffff".to_string(),
        background: "#000000".to_string(),
        palette: vec!["#000000".to_string(); 16],
    };
    let mut engine = super::replay::VtReplayEngine::new(
        80,
        24,
        &theme,
        super::retention::TerminalRetentionPolicy::default(),
    )
    .expect("the contract sample needs a terminal");
    engine.feed(b"contract");
    engine
        .project()
        .expect("the contract sample needs a projection")
}

/// One representative semantic frame, written by the host's own parser.
///
/// The contract artifact records `state` as one object, so nothing below that
/// field is gated by it. A client model that types rows and cells therefore has
/// nothing to check itself against except a reading of the Rust field names —
/// and a reading is what a generated fixture exists to replace. This frame is
/// checked in beside the contract so the client model decodes what the host
/// actually writes.
///
/// The trace carries the facts a client cannot infer from text: a title and a
/// bell as ordered effects, a prompt mark, a styled run, a wide grapheme with a
/// combining mark after it, a hyperlink, and a row that fills and wraps.
#[cfg(test)]
fn sample_screen_frame() -> TerminalEvent {
    let theme = TerminalColorTheme {
        foreground: "#e6e6e6".to_string(),
        background: "#101010".to_string(),
        palette: vec!["#000000".to_string(); 16],
    };
    let mut engine = super::replay::VtReplayEngine::new(
        40,
        8,
        &theme,
        super::retention::TerminalRetentionPolicy::default(),
    )
    .expect("the fixture needs a terminal");

    let mut trace: Vec<u8> = Vec::new();
    trace.extend_from_slice(b"\x1b]0;shipctl\x1b\\");
    trace.extend_from_slice(b"\x1b]133;A\x1b\\$ \x1b[1;38;2;10;20;30mbold\x1b[0m\r\n");
    trace.extend_from_slice("\u{6f22}e\u{301}\r\n".as_bytes());
    trace.extend_from_slice(b"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\\r\n");
    trace.extend(std::iter::repeat_n(b'w', 45));
    trace.extend_from_slice(b"\x07");
    engine.feed(&trace);

    TerminalEvent::Screen {
        sequence: 12,
        revision: TerminalRevision(7),
        state: std::sync::Arc::new(super::wire::TerminalScreenSnapshot::from_projection(
            engine.project().expect("the fixture needs a projection"),
        )),
    }
}

/// Where the representative frame lives. The client model's suite reads this
/// file, so a renamed field or a changed shape fails on both sides.
pub fn screen_fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../core/frontend/terminal/terminalScreenFixture.json")
}

/// One representative history window, read out of the host's own retention.
///
/// A screen frame carries the viewport, so nothing in the screen fixture shows
/// what a client is given for the rows behind it. The trace scrolls the early
/// rows off deliberately and puts the facts a client cannot infer from text
/// among them: a prompt mark, a styled run, a wide grapheme with a combining
/// mark, a hyperlink, and a row that fills and wraps. If history rows were ever
/// a poorer kind of row than viewport rows, this fixture would say so.
#[cfg(test)]
fn sample_history_window() -> super::projection::TerminalHistoryWindow {
    let theme = TerminalColorTheme {
        foreground: "#e6e6e6".to_string(),
        background: "#101010".to_string(),
        palette: vec!["#000000".to_string(); 16],
    };
    let mut engine = super::replay::VtReplayEngine::new(
        40,
        8,
        &theme,
        super::retention::TerminalRetentionPolicy::default(),
    )
    .expect("the fixture needs a terminal");

    let mut trace: Vec<u8> = Vec::new();
    trace.extend_from_slice(b"\x1b]133;A\x1b\\$ \x1b[1;38;2;10;20;30mbold\x1b[0m\r\n");
    trace.extend_from_slice("\u{6f22}e\u{301}\r\n".as_bytes());
    trace.extend_from_slice(b"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\\r\n");
    trace.extend(std::iter::repeat_n(b'w', 45));
    trace.extend_from_slice(b"\r\n");
    // Past the eight rows this screen holds, so the rows above are behind the
    // viewport rather than on it.
    for line in 0..12 {
        trace.extend_from_slice(format!("scrolled-{line}\r\n").as_bytes());
    }
    engine.feed(&trace);

    engine
        .project_history(0, 6)
        .expect("the fixture needs a history window")
}

/// Where that window lives. The client model's suite reads it for the same
/// reason it reads the screen fixture: the host writes the shape, not a
/// reading of the host.
pub fn history_fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../core/frontend/terminal/terminalHistoryFixture.json")
}

/// One representative anchor: a line the host pinned, after it scrolled off.
///
/// This is the state a client reads an anchor in that it cannot read a row
/// number in — the line is behind the viewport, so the anchor names it in
/// history and on the screen and in neither of the two spaces that only name
/// visible rows. Both encodings a client must decode are therefore in one
/// sample: a point the host wrote, and the null it writes for a space that does
/// not name the line.
#[cfg(test)]
fn sample_anchor() -> super::projection::TerminalAnchor {
    let theme = TerminalColorTheme {
        foreground: "#e6e6e6".to_string(),
        background: "#101010".to_string(),
        palette: vec!["#000000".to_string(); 16],
    };
    let mut engine = super::replay::VtReplayEngine::new(
        40,
        8,
        &theme,
        super::retention::TerminalRetentionPolicy::default(),
    )
    .expect("the fixture needs a terminal");

    engine.feed(b"anchored\r\n");
    let anchor = engine
        .anchor(
            super::projection::ProjectedSpace::Active,
            super::projection::ProjectedPoint { column: 0, row: 0 },
        )
        .expect("the fixture needs an anchor");
    // Past the eight rows this screen holds, so the anchored line is behind the
    // viewport rather than on it.
    for line in 0..12 {
        engine.feed(format!("scrolled-{line}\r\n").as_bytes());
    }

    engine
        .resolve_anchor(anchor.id)
        .expect("the anchor reads")
        .expect("the host is still holding the anchor")
}

/// Where that anchor lives, read by the client's reading-position suite.
pub fn anchor_fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../core/frontend/terminal/terminalAnchorFixture.json")
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

/// One named semantic input, as the host reads it off the wire.
#[cfg(test)]
#[derive(Serialize)]
pub(super) struct NamedInput {
    pub(super) name: &'static str,
    pub(super) input: TerminalInput,
}

/// The input half of the screen fixture, and the same argument for it.
///
/// `input.rs` is the authority for what a client may report. A client that
/// builds those values from browser events has nothing to check itself against
/// except a reading of the Rust field names, and the shapes are exactly where a
/// reading goes wrong: a defaulted modifier that must still be written, an
/// absent value that must be `null` rather than missing, a tag that names the
/// variant. Each sample below is one thing a person does, so a client suite can
/// build the same event and compare whole values.
///
/// The names are the join. A renamed or deleted sample fails the client suite
/// that looks it up, and a new variant of [`TerminalInput`] fails to compile
/// here until it has one.
#[cfg(test)]
pub(super) fn sample_inputs() -> Vec<NamedInput> {
    fn surface() -> TerminalSurfaceGeometry {
        TerminalSurfaceGeometry {
            screen_width: 800.0,
            screen_height: 480.0,
            cell_width: 9.0,
            cell_height: 18.0,
            padding_top: 4.0,
            padding_bottom: 4.0,
            padding_left: 6.0,
            padding_right: 6.0,
        }
    }

    fn key(
        name: &'static str,
        action: TerminalKeyAction,
        code: &str,
        text: Option<&str>,
        mods: TerminalModifiers,
        composing: bool,
    ) -> NamedInput {
        NamedInput {
            name,
            input: TerminalInput::Key(TerminalKeyEvent {
                action,
                code: code.to_string(),
                text: text.map(str::to_string),
                mods,
                composing,
            }),
        }
    }

    fn mouse(
        name: &'static str,
        action: TerminalMouseAction,
        button: Option<TerminalMouseButton>,
        mods: TerminalModifiers,
        any_button_pressed: bool,
    ) -> NamedInput {
        NamedInput {
            name,
            input: TerminalInput::Mouse(TerminalMouseEvent {
                action,
                button,
                mods,
                x: 123.5,
                y: 47.0,
                surface: surface(),
                any_button_pressed,
            }),
        }
    }

    let ctrl = TerminalModifiers {
        ctrl: true,
        ..TerminalModifiers::default()
    };
    let locks = TerminalModifiers {
        shift: true,
        caps_lock: true,
        num_lock: true,
        ..TerminalModifiers::default()
    };
    let alt_shift = TerminalModifiers {
        alt: true,
        shift: true,
        ..TerminalModifiers::default()
    };

    vec![
        // A printable key carries what the layout produced. The host decides
        // what byte that becomes under the child's current modes.
        key(
            "key-press-plain",
            TerminalKeyAction::Press,
            "KeyC",
            Some("c"),
            TerminalModifiers::default(),
            false,
        ),
        // Ctrl+C still reports the unmodified text. The control byte is the
        // host's conclusion, never the client's.
        key(
            "key-press-ctrl",
            TerminalKeyAction::Press,
            "KeyC",
            Some("c"),
            ctrl,
            false,
        ),
        // A key that produces no text names only the physical key.
        key(
            "key-press-named",
            TerminalKeyAction::Press,
            "ArrowUp",
            None,
            TerminalModifiers::default(),
            false,
        ),
        key(
            "key-repeat",
            TerminalKeyAction::Repeat,
            "KeyA",
            Some("a"),
            TerminalModifiers::default(),
            false,
        ),
        // Releases matter to the Kitty protocol and to nothing else. A client
        // reports them and does not decide whether they are wanted.
        key(
            "key-release",
            TerminalKeyAction::Release,
            "KeyC",
            Some("c"),
            TerminalModifiers::default(),
            false,
        ),
        // A key inside a composition produces no bytes; the commit arrives as
        // `text`.
        key(
            "key-composing",
            TerminalKeyAction::Press,
            "KeyA",
            Some("a"),
            TerminalModifiers::default(),
            true,
        ),
        // Lock state is held, not pressed, and is reported the same way.
        key(
            "key-locks",
            TerminalKeyAction::Press,
            "Digit1",
            Some("!"),
            locks,
            false,
        ),
        NamedInput {
            name: "text-commit",
            input: TerminalInput::Text {
                text: "\u{6f22}\u{5b57}".to_string(),
            },
        },
        NamedInput {
            name: "paste",
            input: TerminalInput::Paste {
                text: "echo hi".to_string(),
            },
        },
        mouse(
            "mouse-press-left",
            TerminalMouseAction::Press,
            Some(TerminalMouseButton::Left),
            TerminalModifiers::default(),
            true,
        ),
        // A drag is a motion that names the held button.
        mouse(
            "mouse-motion-drag",
            TerminalMouseAction::Motion,
            Some(TerminalMouseButton::Left),
            TerminalModifiers::default(),
            true,
        ),
        // A hover names none.
        mouse(
            "mouse-motion-idle",
            TerminalMouseAction::Motion,
            None,
            TerminalModifiers::default(),
            false,
        ),
        mouse(
            "mouse-release-right",
            TerminalMouseAction::Release,
            Some(TerminalMouseButton::Right),
            alt_shift,
            false,
        ),
        // The wheel is buttons four to seven, pressed and never released — the
        // encoding every mouse format has carried since X11, asserted against
        // the pinned parser in
        // `compat.rs::the_wheel_encodes_as_the_buttons_the_scroll_flag_names`.
        // A client turning a wheel event into one of these is following the
        // host's own convention rather than inventing a scroll message.
        mouse(
            "mouse-wheel-up",
            TerminalMouseAction::Press,
            Some(TerminalMouseButton::Four),
            TerminalModifiers::default(),
            false,
        ),
        mouse(
            "mouse-wheel-down",
            TerminalMouseAction::Press,
            Some(TerminalMouseButton::Five),
            TerminalModifiers::default(),
            false,
        ),
        mouse(
            "mouse-wheel-left",
            TerminalMouseAction::Press,
            Some(TerminalMouseButton::Six),
            TerminalModifiers::default(),
            false,
        ),
        mouse(
            "mouse-wheel-right",
            TerminalMouseAction::Press,
            Some(TerminalMouseButton::Seven),
            TerminalModifiers::default(),
            false,
        ),
        // The webview's three keybinding presets, which ship a byte sequence
        // each. Reported as meaning they produce the same bytes, which
        // `runtime.rs::the_keybinding_presets_are_bytes_this_host_already_makes`
        // asserts against these very samples, and which
        // `tests/keybindingPresets.test.ts` holds the client's table to.
        key(
            "preset-delete-word",
            TerminalKeyAction::Press,
            "KeyW",
            Some("w"),
            ctrl,
            false,
        ),
        key(
            "preset-clear-screen",
            TerminalKeyAction::Press,
            "KeyL",
            Some("l"),
            ctrl,
            false,
        ),
        // Shift-return asks for the character return would not produce, which
        // is why this preset is text and not a key.
        NamedInput {
            name: "preset-newline",
            input: TerminalInput::Text {
                text: "\n".to_string(),
            },
        },
        NamedInput {
            name: "focus-gained",
            input: TerminalInput::Focus { gained: true },
        },
        NamedInput {
            name: "focus-lost",
            input: TerminalInput::Focus { gained: false },
        },
    ]
}

/// Where the input samples live. The client's input suite reads this file, so a
/// renamed field or a changed tag fails on both sides.
pub fn input_fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../core/frontend/terminal/terminalInputFixture.json")
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

    /// Every variant of the input model carries a named sample.
    ///
    /// The match is exhaustive, so a new variant of [`TerminalInput`] stops
    /// this module compiling until it is sampled, and the wire tag is asserted
    /// beside it so the name a client looks for is the name the host reads.
    #[test]
    fn every_input_variant_has_a_named_sample_and_names_itself_on_the_wire() {
        fn tag(input: &TerminalInput) -> &'static str {
            match input {
                TerminalInput::Key(_) => "key",
                TerminalInput::Text { .. } => "text",
                TerminalInput::Paste { .. } => "paste",
                TerminalInput::Mouse(_) => "mouse",
                TerminalInput::Focus { .. } => "focus",
            }
        }

        let samples = sample_inputs();
        let mut names: Vec<&str> = samples.iter().map(|sample| sample.name).collect();
        let unique: std::collections::BTreeSet<&str> = names.iter().copied().collect();
        names.sort_unstable();
        assert_eq!(
            names.len(),
            unique.len(),
            "sample names are the client's key"
        );

        for sample in &samples {
            let value = serde_json::to_value(&sample.input).expect("serialize an input");
            assert_eq!(
                value.get("kind").and_then(JsonValue::as_str),
                Some(tag(&sample.input)),
                "{} must name its variant on the wire",
                sample.name
            );
        }

        let covered: std::collections::BTreeSet<&str> =
            samples.iter().map(|sample| tag(&sample.input)).collect();
        assert_eq!(
            covered,
            std::collections::BTreeSet::from(["focus", "key", "mouse", "paste", "text"])
        );
    }

    /// The same gate again, for input: the values a client must produce.
    #[test]
    fn the_checked_in_input_fixture_matches_the_rust_model() {
        let rendered = format!(
            "{}\n",
            serde_json::to_string_pretty(&sample_inputs()).expect("render the input fixture")
        );
        let path = input_fixture_path();

        if std::env::var_os("SHIPCTL_WRITE_TERMINAL_CONTRACT").is_some() {
            std::fs::write(&path, &rendered).expect("write the input fixture");
            return;
        }

        let checked_in = std::fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            checked_in, rendered,
            "the checked-in input fixture is stale; regenerate it with \
             SHIPCTL_WRITE_TERMINAL_CONTRACT=1 and update the client's input adapter"
        );
    }

    /// The same gate, one level deeper: the frame the client model reads.
    #[test]
    fn the_checked_in_screen_fixture_matches_the_rust_model() {
        let rendered = format!(
            "{}\n",
            serde_json::to_string_pretty(&sample_screen_frame())
                .expect("render the screen fixture")
        );
        let path = screen_fixture_path();

        if std::env::var_os("SHIPCTL_WRITE_TERMINAL_CONTRACT").is_some() {
            std::fs::write(&path, &rendered).expect("write the screen fixture");
            return;
        }

        let checked_in = std::fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            checked_in, rendered,
            "the checked-in screen fixture is stale; regenerate it with \
             SHIPCTL_WRITE_TERMINAL_CONTRACT=1 and update the client model"
        );
    }

    /// History and the compact viewport use different wire shapes but retain
    /// the same semantic row facts.
    ///
    /// History is an on-demand response. The live viewport is replaceable
    /// frame state and uses runs to avoid repeating paint facts on every cell.
    /// Both decode into the same client row model, so neither may omit a fact
    /// the client cannot reconstruct.
    #[test]
    fn a_history_row_carries_everything_a_viewport_row_carries() {
        let window = sample_history_window();
        assert!(
            window.history_rows >= window.rows.len(),
            "a window cannot hold more rows than history does"
        );

        let history = serde_json::to_value(&window.rows).expect("serialize history rows");
        let viewport = match sample_screen_frame() {
            TerminalEvent::Screen { state, .. } => {
                serde_json::to_value(&state.viewport).expect("serialize viewport rows")
            }
            _ => panic!("the screen fixture is a screen frame"),
        };

        let fields = |rows: &JsonValue| -> std::collections::BTreeSet<String> {
            rows.as_array()
                .expect("rows are an array")
                .iter()
                .flat_map(|row| {
                    row.as_object()
                        .expect("a row is an object")
                        .keys()
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .collect()
        };
        assert_eq!(
            fields(&history),
            std::collections::BTreeSet::from([
                "cells".to_string(),
                "continuation".to_string(),
                "prompt".to_string(),
                "wrapped".to_string(),
            ]),
            "history keeps its on-demand cell shape"
        );
        assert_eq!(
            fields(&viewport),
            std::collections::BTreeSet::from([
                "continuation".to_string(),
                "prompt".to_string(),
                "runs".to_string(),
                "wrapped".to_string(),
            ]),
            "replaceable viewport state keeps its compact run shape"
        );

        // The facts a client cannot infer from text survive the scroll.
        let cells: Vec<&JsonValue> = history
            .as_array()
            .expect("rows are an array")
            .iter()
            .flat_map(|row| row["cells"].as_array().expect("cells are an array"))
            .collect();
        assert!(
            cells.iter().any(|cell| cell["width"] == "wide"),
            "the wide grapheme did not survive scrolling into history"
        );
        assert!(
            cells.iter().any(|cell| cell["hyperlink"].is_string()),
            "the hyperlink did not survive scrolling into history"
        );
        assert!(
            cells.iter().any(|cell| cell["bold"] == true),
            "the styled run did not survive scrolling into history"
        );

        let runs: Vec<&JsonValue> = viewport
            .as_array()
            .expect("rows are an array")
            .iter()
            .flat_map(|row| row["runs"].as_array().expect("runs are an array"))
            .collect();
        assert!(
            runs.iter().any(|run| run["width"] == "wide"),
            "the compact viewport lost the wide-cell boundary"
        );
        assert!(
            runs.iter().any(|run| run["hyperlink"].is_string()),
            "the compact viewport lost the hyperlink"
        );
        assert!(
            runs.iter().any(|run| run["bold"] == true),
            "the compact viewport lost the styled run"
        );
    }

    /// The same gate, for the window the client reads.
    #[test]
    fn the_checked_in_history_fixture_matches_the_rust_model() {
        let rendered = format!(
            "{}\n",
            serde_json::to_string_pretty(&sample_history_window())
                .expect("render the history fixture")
        );
        let path = history_fixture_path();

        if std::env::var_os("SHIPCTL_WRITE_TERMINAL_CONTRACT").is_some() {
            std::fs::write(&path, &rendered).expect("write the history fixture");
            return;
        }

        let checked_in = std::fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            checked_in, rendered,
            "the checked-in history fixture is stale; regenerate it with \
             SHIPCTL_WRITE_TERMINAL_CONTRACT=1 and update the client model"
        );
    }

    /// The anchored line is in history and on the screen, and in neither space
    /// that names only visible rows. A client that reads a row number cannot
    /// tell any of that.
    #[test]
    fn the_sample_anchor_names_a_line_no_row_number_could_hold() {
        let anchor = sample_anchor();

        assert!(anchor.retained, "the line is still in the terminal");
        assert!(
            anchor.loss_reported,
            "history holds lines here, so a lost one would be reported"
        );
        assert!(anchor.history.is_some(), "the line is behind the viewport");
        assert!(anchor.screen.is_some());
        assert_eq!(anchor.viewport, None, "and is not drawn");
        assert_eq!(anchor.active, None, "and the child cannot write to it");
    }

    /// The same gate, for the anchor the client reads.
    #[test]
    fn the_checked_in_anchor_fixture_matches_the_rust_model() {
        let rendered = format!(
            "{}\n",
            serde_json::to_string_pretty(&sample_anchor()).expect("render the anchor fixture")
        );
        let path = anchor_fixture_path();

        if std::env::var_os("SHIPCTL_WRITE_TERMINAL_CONTRACT").is_some() {
            std::fs::write(&path, &rendered).expect("write the anchor fixture");
            return;
        }

        let checked_in = std::fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            checked_in, rendered,
            "the checked-in anchor fixture is stale; regenerate it with \
             SHIPCTL_WRITE_TERMINAL_CONTRACT=1 and update the client model"
        );
    }
}
