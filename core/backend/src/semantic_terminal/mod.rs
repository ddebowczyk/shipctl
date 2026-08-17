//! Tauri-free semantic-terminal provider and native driver.
//!
//! Core owns parser integration, projection, input encoding, the semantic
//! terminal driver, and activation-scoped native authority. The private Tauri
//! adapter is in `core/tauri`.

/// Executable evidence that the pinned Ghostty revision supports the semantic
/// facts and encodings the module owns.
#[cfg(test)]
mod compat;
pub mod effects;
pub mod input;
/// Release-only measurements of this module's parser, projection, and wire work.
#[cfg(test)]
mod measure;
/// Executable evidence that semantic state alone can be presented. This is a
/// semantic-terminal test, not a core-host test.
#[cfg(test)]
mod paint_probe;
pub mod painter;
pub mod projection;
pub mod replay;
pub mod retention;
mod service;
/// Recorded PTY output and its semantic state, kept with the interpreter.
#[cfg(test)]
mod traces;
pub mod wire;
pub use effects::{TerminalClipboardContent, TerminalClipboardLocation, TerminalEffect};
pub use libghostty_vt;
pub use service::{
    SemanticTerminalActor, SemanticTerminalAuthority, SemanticTerminalError,
    SemanticTerminalEventSink, SemanticTerminalService, SEMANTIC_TERMINALS_ACTIVATION_DISPOSED,
    SEMANTIC_TERMINALS_DENIED, SEMANTIC_TERMINALS_INVALID_REQUEST, SEMANTIC_TERMINALS_NOT_FOUND,
    SEMANTIC_TERMINALS_PROTOCOL_FAILED, SEMANTIC_TERMINALS_TRANSPORT_FAILED,
    SEMANTIC_TERMINALS_UNAVAILABLE,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use shipctl_module_api::{
    TerminalByteOccurrence, TerminalDriverDescriptor, TerminalDriverError, TerminalDriverFactory,
    TerminalDriverId, TerminalDriverRequestResult, TerminalDriverSession,
    TerminalDriverSessionRequest, TerminalDriverUpdate,
};
use std::sync::Arc;

pub fn driver_id() -> TerminalDriverId {
    TerminalDriverId::new("semantic-terminal")
        .expect("the build-installed semantic-terminal driver id is valid")
}

/// Build-installed native factory for the semantic terminal driver.
pub fn native_factory() -> Arc<dyn TerminalDriverFactory> {
    Arc::new(SemanticTerminalDriverFactory)
}

struct SemanticTerminalDriverFactory;

impl TerminalDriverFactory for SemanticTerminalDriverFactory {
    fn descriptor(&self) -> TerminalDriverDescriptor {
        TerminalDriverDescriptor {
            id: driver_id(),
            native_interpretation: true,
        }
    }

    fn create(
        &self,
        request: TerminalDriverSessionRequest,
    ) -> Result<Box<dyn TerminalDriverSession>, TerminalDriverError> {
        SemanticTerminalDriverSession::new(request).map(|session| Box::new(session) as _)
    }
}

/// Parser-owned state for one semantic terminal. It has no access to a PTY;
/// the host provides ordered occurrences and applies returned reply bytes.
struct SemanticTerminalDriverSession {
    engine: replay::VtReplayEngine,
    stopped: bool,
}

/// Commands that only the semantic driver understands. They are JSON at the
/// shared host boundary so core neither imports nor decodes semantic state.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum SemanticDriverRequest {
    Snapshot {
        #[serde(default)]
        baseline: bool,
    },
    Input {
        input: input::TerminalInput,
    },
    History {
        start_row: u32,
        rows: u32,
    },
    Anchor {
        space: projection::ProjectedSpace,
        at: projection::ProjectedPoint,
    },
    ResolveAnchor {
        id: projection::TerminalAnchorId,
    },
    ReleaseAnchor {
        id: projection::TerminalAnchorId,
    },
    Select {
        request: projection::TerminalSelectionRequest,
    },
}

impl SemanticTerminalDriverSession {
    fn new(request: TerminalDriverSessionRequest) -> Result<Self, TerminalDriverError> {
        Ok(Self {
            engine: replay::VtReplayEngine::new(
                request.columns,
                request.rows,
                &request.color_theme,
                retention::TerminalRetentionPolicy::from_bytes(request.scrollback_bytes),
            )
            .map_err(TerminalDriverError::new)?,
            stopped: false,
        })
    }
}

impl TerminalDriverSession for SemanticTerminalDriverSession {
    fn on_output(
        &mut self,
        occurrence: TerminalByteOccurrence,
    ) -> Result<TerminalDriverUpdate, TerminalDriverError> {
        if self.stopped {
            return Err(TerminalDriverError::new(
                "semantic terminal driver is stopped",
            ));
        }
        let feed = self.engine.feed(&occurrence.bytes);
        let events = (!feed.effects.is_empty())
            .then(|| {
                serde_json::to_value(&feed.effects).map(|effects| {
                    vec![json!({
                        "event": "effects",
                        "sequence": occurrence.sequence,
                        "effects": effects,
                    })]
                })
            })
            .transpose()
            .map_err(|error| {
                TerminalDriverError::new(format!("could not encode semantic event: {error}"))
            })?
            .unwrap_or_default();
        Ok(TerminalDriverUpdate {
            events,
            reply_bytes: feed.responses,
            presentation_changed: true,
        })
    }

    fn on_resize(&mut self, columns: u16, rows: u16) -> Result<(), TerminalDriverError> {
        self.engine
            .resize(columns, rows)
            .map_err(TerminalDriverError::new)
    }

    fn snapshot(&mut self, baseline: bool) -> Result<JsonValue, TerminalDriverError> {
        let projection = if baseline {
            self.engine.project_baseline()
        } else {
            self.engine.project()
        }
        .map_err(TerminalDriverError::new)?;
        // The browser contract is the compact run-based snapshot.  The raw
        // projection is the interpreter's internal model; sending it here
        // would omit the `selection` overlay and use per-cell rows that the
        // browser decoder deliberately does not accept.
        serde_json::to_value(wire::TerminalScreenSnapshot::from_projection(projection)).map_err(
            |error| {
                TerminalDriverError::new(format!(
                    "could not encode semantic terminal snapshot: {error}"
                ))
            },
        )
    }

    fn presentation(
        &mut self,
        sequence: u64,
        revision: u64,
        baseline: bool,
    ) -> Result<JsonValue, TerminalDriverError> {
        Ok(json!({
            "event": "screen",
            "sequence": sequence,
            "revision": revision,
            "state": self.snapshot(baseline)?,
        }))
    }

    fn replay(&mut self) -> Result<Vec<u8>, TerminalDriverError> {
        self.engine.replay().map_err(TerminalDriverError::new)
    }

    fn set_color_theme(
        &mut self,
        theme: &shipctl_module_api::TerminalColorTheme,
    ) -> Result<TerminalDriverUpdate, TerminalDriverError> {
        let reply_bytes = self
            .engine
            .set_theme(theme)
            .map_err(TerminalDriverError::new)?;
        Ok(TerminalDriverUpdate {
            events: Vec::new(),
            reply_bytes,
            presentation_changed: true,
        })
    }

    fn request(
        &mut self,
        request: JsonValue,
    ) -> Result<TerminalDriverRequestResult, TerminalDriverError> {
        if self.stopped {
            return Err(TerminalDriverError::new(
                "semantic terminal driver is stopped",
            ));
        }
        let request =
            serde_json::from_value::<SemanticDriverRequest>(request).map_err(|error| {
                TerminalDriverError::new(format!("invalid semantic terminal request: {error}"))
            })?;
        let (payload, reply_bytes, presentation_changed) = match request {
            SemanticDriverRequest::Snapshot { baseline } => {
                (self.snapshot(baseline)?, Vec::new(), false)
            }
            SemanticDriverRequest::Input { input } => {
                let bytes = self
                    .engine
                    .encode_input(&input)
                    .map_err(TerminalDriverError::new)?;
                (json!(bytes.len()), bytes, false)
            }
            SemanticDriverRequest::History { start_row, rows } => (
                serde_json::to_value(
                    self.engine
                        .project_history(start_row, rows)
                        .map_err(TerminalDriverError::new)?,
                )
                .map_err(|error| {
                    TerminalDriverError::new(format!(
                        "could not encode semantic terminal history: {error}"
                    ))
                })?,
                Vec::new(),
                false,
            ),
            SemanticDriverRequest::Anchor { space, at } => (
                serde_json::to_value(
                    self.engine
                        .anchor(space, at)
                        .map_err(TerminalDriverError::new)?,
                )
                .map_err(|error| {
                    TerminalDriverError::new(format!(
                        "could not encode semantic terminal anchor: {error}"
                    ))
                })?,
                Vec::new(),
                false,
            ),
            SemanticDriverRequest::ResolveAnchor { id } => (
                serde_json::to_value(
                    self.engine
                        .resolve_anchor(id)
                        .map_err(TerminalDriverError::new)?,
                )
                .map_err(|error| {
                    TerminalDriverError::new(format!(
                        "could not encode resolved semantic terminal anchor: {error}"
                    ))
                })?,
                Vec::new(),
                false,
            ),
            SemanticDriverRequest::ReleaseAnchor { id } => {
                (json!(self.engine.release_anchor(id)), Vec::new(), false)
            }
            SemanticDriverRequest::Select { request } => (
                serde_json::to_value(
                    self.engine
                        .apply_selection(request)
                        .map_err(TerminalDriverError::new)?,
                )
                .map_err(|error| {
                    TerminalDriverError::new(format!(
                        "could not encode semantic terminal selection: {error}"
                    ))
                })?,
                Vec::new(),
                true,
            ),
        };
        Ok(TerminalDriverRequestResult {
            payload,
            reply_bytes,
            presentation_changed,
        })
    }

    fn stop(&mut self) {
        self.stopped = true;
    }
}

#[cfg(test)]
mod tests {
    use shipctl_module_api::{
        TerminalByteOccurrence, TerminalColorTheme, TerminalDriverSessionRequest,
    };

    #[test]
    fn identifies_the_semantic_driver() {
        assert_eq!(super::driver_id().as_str(), "semantic-terminal");
    }

    #[test]
    fn factory_parses_ordered_bytes_and_returns_semantic_occurrences() {
        let factory = super::native_factory();
        let mut session = factory
            .create(TerminalDriverSessionRequest {
                columns: 80,
                rows: 24,
                color_theme: TerminalColorTheme {
                    foreground: "#ffffff".to_string(),
                    background: "#000000".to_string(),
                    palette: vec!["#000000".to_string(); 16],
                },
                scrollback_bytes: 1024,
            })
            .unwrap();

        let update = session
            .on_output(TerminalByteOccurrence {
                sequence: 1,
                bytes: b"\x1b]2;semantic title\x07\x07".to_vec(),
            })
            .unwrap();

        assert_eq!(
            update.events,
            vec![serde_json::json!({
                "event": "effects",
                "sequence": 1,
                "effects": [
                    { "kind": "title", "title": "semantic title" },
                    { "kind": "bell" },
                ],
            })]
        );
        assert!(update.reply_bytes.is_empty());
        assert!(update.presentation_changed);
    }

    #[test]
    fn factory_owns_semantic_snapshot_and_input_requests() {
        let factory = super::native_factory();
        let mut session = factory
            .create(TerminalDriverSessionRequest {
                columns: 80,
                rows: 24,
                color_theme: TerminalColorTheme {
                    foreground: "#ffffff".to_string(),
                    background: "#000000".to_string(),
                    palette: vec!["#000000".to_string(); 16],
                },
                scrollback_bytes: 1024,
            })
            .unwrap();

        session
            .on_output(TerminalByteOccurrence {
                sequence: 1,
                bytes: b"module state".to_vec(),
            })
            .unwrap();
        let snapshot = session.snapshot(true).unwrap();
        assert_eq!(snapshot["viewport"][0]["runs"][0]["glyphs"][0], "m");
        assert!(snapshot["selection"].is_array());
        assert!(snapshot["viewport"][0].get("cells").is_none());

        let input = session
            .request(serde_json::json!({
                "operation": "input",
                "input": { "kind": "text", "text": "ok" },
            }))
            .unwrap();
        assert_eq!(input.payload, serde_json::json!(2));
        assert_eq!(input.reply_bytes, b"ok");
    }
}
