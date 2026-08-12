//! Semantic-terminal native dependency boundary.
//!
//! Core uses this re-export only during the runtime migration. The parser,
//! projection, and command code move here next; keeping the dependency here
//! now prevents a new direct Ghostty dependency from being added to core.

/// Executable evidence that the pinned Ghostty revision supports the semantic
/// facts and encodings the module owns.
#[cfg(test)]
mod compat;
pub mod effects;
mod host;
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
/// Recorded PTY output and its semantic state, kept with the interpreter.
#[cfg(test)]
mod traces;
pub mod wire;
pub use effects::{TerminalClipboardContent, TerminalClipboardLocation, TerminalEffect};
pub use host::{HostServices, SemanticTerminalEventSink, SemanticTerminalHost};
pub use libghostty_vt;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use shipctl_module_api::{
    TerminalByteOccurrence, TerminalDriverDescriptor, TerminalDriverError, TerminalDriverFactory,
    TerminalDriverId, TerminalDriverRequestResult, TerminalDriverSession,
    TerminalDriverSessionRequest, TerminalDriverUpdate,
};
use std::sync::Arc;
use tauri::{
    ipc::{Channel, Response},
    plugin::TauriPlugin,
    Manager, Runtime, State,
};

pub const PLUGIN_NAME: &str = "shipctl-semantic-terminal";
pub const GET_SNAPSHOT_COMMAND: &str =
    "plugin:shipctl-semantic-terminal|get_semantic_terminal_snapshot";
pub const ATTACH_COMMAND: &str = "plugin:shipctl-semantic-terminal|attach_semantic_terminal";
pub const CREDIT_SCREEN_COMMAND: &str =
    "plugin:shipctl-semantic-terminal|credit_semantic_terminal_screen";
pub const DETACH_COMMAND: &str = "plugin:shipctl-semantic-terminal|detach_semantic_terminal";
pub const RESIZE_COMMAND: &str = "plugin:shipctl-semantic-terminal|resize_semantic_terminal";
pub const INPUT_COMMAND: &str = "plugin:shipctl-semantic-terminal|input_semantic_terminal";
pub const HISTORY_COMMAND: &str = "plugin:shipctl-semantic-terminal|history_semantic_terminal";
pub const ANCHOR_COMMAND: &str = "plugin:shipctl-semantic-terminal|anchor_semantic_terminal";
pub const RESOLVE_ANCHOR_COMMAND: &str =
    "plugin:shipctl-semantic-terminal|resolve_semantic_terminal_anchor";
pub const RELEASE_ANCHOR_COMMAND: &str =
    "plugin:shipctl-semantic-terminal|release_semantic_terminal_anchor";
pub const SELECT_COMMAND: &str = "plugin:shipctl-semantic-terminal|select_semantic_terminal";
pub const PASTE_SAFETY_COMMAND: &str =
    "plugin:shipctl-semantic-terminal|is_semantic_terminal_paste_safe";
pub const PUBLICATION_STATS_COMMAND: &str =
    "plugin:shipctl-semantic-terminal|get_semantic_terminal_publication_stats";
pub const APP_MEMORY_COMMAND: &str =
    "plugin:shipctl-semantic-terminal|get_semantic_terminal_app_memory";

struct SemanticTerminalPluginState {
    services: HostServices,
}

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

#[tauri::command]
fn get_semantic_terminal_snapshot(
    terminal_id: String,
    state: State<'_, SemanticTerminalPluginState>,
) -> Result<JsonValue, String> {
    state.services.terminal().request(
        &terminal_id,
        json!({ "operation": "snapshot", "baseline": true }),
    )
}

#[tauri::command]
fn attach_semantic_terminal(
    terminal_id: String,
    claims_resize: bool,
    on_event: Channel<Response>,
    state: State<'_, SemanticTerminalPluginState>,
) -> Result<JsonValue, String> {
    let sink: SemanticTerminalEventSink = Arc::new(move |event| {
        let json = serde_json::to_string(&event)
            .map_err(|error| format!("Semantic terminal event encoding failed: {error}"))?;
        on_event
            .send(Response::new(json))
            .map_err(|error| format!("Semantic terminal attachment channel closed: {error}"))
    });
    state
        .services
        .terminal()
        .attach(&terminal_id, claims_resize, sink)
}

#[tauri::command]
fn credit_semantic_terminal_screen(
    attachment_id: String,
    committed_sequence: u64,
    state: State<'_, SemanticTerminalPluginState>,
) -> Result<(), String> {
    state
        .services
        .terminal()
        .credit_screen(&attachment_id, committed_sequence)
}

#[tauri::command]
fn detach_semantic_terminal(
    attachment_id: String,
    state: State<'_, SemanticTerminalPluginState>,
) -> Result<(), String> {
    state.services.terminal().detach(&attachment_id)
}

#[tauri::command]
fn resize_semantic_terminal(
    terminal_id: String,
    attachment_id: String,
    columns: u16,
    rows: u16,
    state: State<'_, SemanticTerminalPluginState>,
) -> Result<(), String> {
    state
        .services
        .terminal()
        .resize(&terminal_id, &attachment_id, columns, rows)
}

#[tauri::command]
fn input_semantic_terminal(
    terminal_id: String,
    input: JsonValue,
    state: State<'_, SemanticTerminalPluginState>,
) -> Result<JsonValue, String> {
    state.services.terminal().request(
        &terminal_id,
        json!({ "operation": "input", "input": input }),
    )
}

#[tauri::command]
fn history_semantic_terminal(
    terminal_id: String,
    start_row: u32,
    rows: u32,
    state: State<'_, SemanticTerminalPluginState>,
) -> Result<JsonValue, String> {
    state.services.terminal().request(
        &terminal_id,
        json!({ "operation": "history", "start_row": start_row, "rows": rows }),
    )
}

#[tauri::command]
fn anchor_semantic_terminal(
    terminal_id: String,
    space: JsonValue,
    at: JsonValue,
    state: State<'_, SemanticTerminalPluginState>,
) -> Result<JsonValue, String> {
    state.services.terminal().request(
        &terminal_id,
        json!({ "operation": "anchor", "space": space, "at": at }),
    )
}

#[tauri::command]
fn resolve_semantic_terminal_anchor(
    terminal_id: String,
    anchor: JsonValue,
    state: State<'_, SemanticTerminalPluginState>,
) -> Result<JsonValue, String> {
    state.services.terminal().request(
        &terminal_id,
        json!({ "operation": "resolve_anchor", "id": anchor }),
    )
}

#[tauri::command]
fn release_semantic_terminal_anchor(
    terminal_id: String,
    anchor: JsonValue,
    state: State<'_, SemanticTerminalPluginState>,
) -> Result<JsonValue, String> {
    state.services.terminal().request(
        &terminal_id,
        json!({ "operation": "release_anchor", "id": anchor }),
    )
}

#[tauri::command]
fn select_semantic_terminal(
    terminal_id: String,
    request: JsonValue,
    state: State<'_, SemanticTerminalPluginState>,
) -> Result<JsonValue, String> {
    state.services.terminal().request(
        &terminal_id,
        json!({ "operation": "select", "request": request }),
    )
}

#[tauri::command]
fn is_semantic_terminal_paste_safe(text: &str) -> bool {
    input::paste_is_safe(&text)
}

#[tauri::command]
fn get_semantic_terminal_publication_stats(
    terminal_id: String,
    state: State<'_, SemanticTerminalPluginState>,
) -> Result<JsonValue, String> {
    state.services.terminal().publication_stats(&terminal_id)
}

#[tauri::command]
fn get_semantic_terminal_app_memory(
    state: State<'_, SemanticTerminalPluginState>,
) -> Result<JsonValue, String> {
    state.services.terminal().app_memory()
}

/// Install the semantic plugin and its namespaced command surface.
pub fn init<R: Runtime>(services: HostServices) -> TauriPlugin<R> {
    tauri::plugin::Builder::new(PLUGIN_NAME)
        .setup(move |app, _api| {
            app.manage(SemanticTerminalPluginState {
                services: services.clone(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_semantic_terminal_snapshot,
            attach_semantic_terminal,
            credit_semantic_terminal_screen,
            detach_semantic_terminal,
            resize_semantic_terminal,
            input_semantic_terminal,
            history_semantic_terminal,
            anchor_semantic_terminal,
            resolve_semantic_terminal_anchor,
            release_semantic_terminal_anchor,
            select_semantic_terminal,
            is_semantic_terminal_paste_safe,
            get_semantic_terminal_publication_stats,
            get_semantic_terminal_app_memory,
        ])
        .build()
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
    fn exposes_namespaced_semantic_terminal_commands() {
        assert_eq!(super::PLUGIN_NAME, "shipctl-semantic-terminal");
        assert_eq!(
            super::GET_SNAPSHOT_COMMAND,
            "plugin:shipctl-semantic-terminal|get_semantic_terminal_snapshot"
        );
        assert_eq!(
            super::ATTACH_COMMAND,
            "plugin:shipctl-semantic-terminal|attach_semantic_terminal"
        );
        assert_eq!(
            super::CREDIT_SCREEN_COMMAND,
            "plugin:shipctl-semantic-terminal|credit_semantic_terminal_screen"
        );
        assert_eq!(
            super::DETACH_COMMAND,
            "plugin:shipctl-semantic-terminal|detach_semantic_terminal"
        );
        assert_eq!(
            super::RESIZE_COMMAND,
            "plugin:shipctl-semantic-terminal|resize_semantic_terminal"
        );
        assert_eq!(
            super::INPUT_COMMAND,
            "plugin:shipctl-semantic-terminal|input_semantic_terminal"
        );
        assert_eq!(
            super::PUBLICATION_STATS_COMMAND,
            "plugin:shipctl-semantic-terminal|get_semantic_terminal_publication_stats"
        );
        assert_eq!(
            super::APP_MEMORY_COMMAND,
            "plugin:shipctl-semantic-terminal|get_semantic_terminal_app_memory"
        );
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
