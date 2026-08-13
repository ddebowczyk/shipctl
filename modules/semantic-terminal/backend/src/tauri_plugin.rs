//! Tauri adapter for the semantic-terminal command surface.
//!
//! The parent module holds the driver and semantic data types. This adapter is
//! only built into the desktop application.

use std::sync::Arc;

use serde_json::{json, Value as JsonValue};
use tauri::{
    ipc::{Channel, Response},
    plugin::TauriPlugin,
    Manager, Runtime, State,
};

use crate::PLUGIN_NAME;
use shipctl_module_semantic_terminal_core::{input, HostServices, SemanticTerminalEventSink};

struct SemanticTerminalPluginState {
    services: HostServices,
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
