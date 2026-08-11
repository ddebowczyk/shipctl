use std::process::Command;
use std::sync::Arc;

use shipctl_module_api::TerminalColorTheme;
use tauri::ipc::{Channel, Response};
use tauri::State;

use crate::terminal::input::{paste_is_safe, TerminalInput};
use crate::terminal::projection::{
    ProjectedPoint, ProjectedSpace, TerminalAnchor, TerminalAnchorId, TerminalHistoryWindow,
    TerminalSelectionRequest, TerminalSelectionState,
};
use crate::terminal::retention::TerminalRetentionPolicy;
use crate::terminal::runtime::{
    PublishedTerminalEvent, TerminalEventSink, TerminalPublicationStats,
};
use crate::terminal::service::{TerminalRegistryEventSink, TerminalService};
use crate::terminal::types::{
    TerminalAttachment, TerminalAttachmentId, TerminalCloseResult, TerminalDescriptor,
    TerminalError, TerminalEvent, TerminalId, TerminalLaunchRequest, TerminalMetadata,
    TerminalRegistryEvent, TerminalRegistrySubscriptionId, TerminalRuntimeSnapshot,
    TerminalTransport,
};
use crate::workspace::config::{normalize_terminal_settings, TerminalSettings};
use crate::workspace::manager::WorkspaceManager;

struct TauriTerminalEventSink {
    on_event: Channel<Response>,
}

impl TerminalEventSink for TauriTerminalEventSink {
    fn publish(
        &self,
        _terminal_id: crate::terminal::types::TerminalId,
        event: TerminalEvent,
    ) -> Result<(), String> {
        let json = serde_json::to_string(&event)
            .map_err(|error| format!("Terminal event encoding failed: {error}"))?;
        self.on_event
            .send(Response::new(json))
            .map_err(|error| format!("Terminal attachment channel closed: {error}"))
    }

    fn commits_screen_on_publish(&self) -> bool {
        false
    }

    fn publish_preencoded(
        &self,
        _terminal_id: crate::terminal::types::TerminalId,
        event: PublishedTerminalEvent,
    ) -> Result<(), String> {
        self.on_event
            .send(Response::new(event.json().to_owned()))
            .map_err(|error| format!("Terminal attachment channel closed: {error}"))
    }
}

/// Final explicit spawn surface. It returns durable host state and does not
/// require a renderer channel; callers attach independently.
#[tauri::command]
pub fn spawn_terminal(
    request: TerminalLaunchRequest,
    terminals: State<'_, TerminalService>,
) -> Result<TerminalDescriptor, String> {
    terminals.spawn(request).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_terminals(terminals: State<'_, TerminalService>) -> Vec<TerminalDescriptor> {
    terminals.list()
}

#[tauri::command]
pub fn get_terminal(
    terminal_id: TerminalId,
    terminals: State<'_, TerminalService>,
) -> Result<TerminalDescriptor, String> {
    terminals
        .get(terminal_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_terminal_snapshot(
    terminal_id: TerminalId,
    terminals: State<'_, TerminalService>,
) -> Result<TerminalRuntimeSnapshot, String> {
    terminals
        .snapshot(terminal_id)
        .map_err(|error| error.to_string())
}

/// Read publication observations without changing the terminal or its demand.
#[tauri::command]
pub fn get_terminal_publication_stats(
    terminal_id: TerminalId,
    terminals: State<'_, TerminalService>,
) -> Result<TerminalPublicationStats, String> {
    terminals
        .publication_stats(terminal_id)
        .map_err(|error| error.to_string())
}

/// Input admission. This is the only terminal command that returns the whole
/// [`TerminalError`]: the client must tell an expected lifecycle refusal
/// (exited, closing, gone) from a real validation or I/O failure, and only the
/// code carries that distinction.
#[tauri::command]
pub fn write_terminal(
    terminal_id: TerminalId,
    data: Vec<u8>,
    terminals: State<'_, TerminalService>,
) -> Result<(), TerminalError> {
    terminals.write(terminal_id, &data)
}

/// The semantic half of input admission, and the one the webview is moving to.
///
/// The client reports what a person did; the host encodes it from the modes
/// the child selected and answers how many bytes that became. Zero is a normal
/// answer, not a failure: a focus report or a mouse motion produces nothing
/// unless the child asked for it. This returns the whole [`TerminalError`] for
/// the same reason [`write_terminal`] does.
#[tauri::command]
pub fn input_terminal(
    terminal_id: TerminalId,
    input: TerminalInput,
    terminals: State<'_, TerminalService>,
) -> Result<usize, TerminalError> {
    terminals.input(terminal_id, input)
}

/// The rows behind the viewport.
///
/// A screen frame carries the viewport, so scrollback is read rather than
/// streamed. The host is the retention authority: this is what lets a client
/// show what scrolled away without keeping its own copy of the child's output,
/// which is the dependency area 05 deletes.
///
/// An empty window is an answer, not a failure — history shrinks whenever the
/// terminal evicts, and a request past what it holds returns the rows that
/// exist.
#[tauri::command]
pub fn history_terminal(
    terminal_id: TerminalId,
    start_row: u32,
    rows: u32,
    terminals: State<'_, TerminalService>,
) -> Result<TerminalHistoryWindow, TerminalError> {
    terminals.project_history(terminal_id, start_row, rows)
}

/// Pin a cell, so a client can keep naming one line while row numbers move.
///
/// A history row number is a position, and eviction renumbers every row behind
/// the one it drops. A client that must point at one line across reads — a
/// reader scrolled back, a mark, a selection endpoint — holds this instead of a
/// number, and the host moves it with its cell through scrolling, eviction and
/// reflow.
///
/// The host holds the pin until the client releases it, which is why this is
/// the one terminal read that leaves something behind.
#[tauri::command]
pub fn anchor_terminal(
    terminal_id: TerminalId,
    space: ProjectedSpace,
    at: ProjectedPoint,
    terminals: State<'_, TerminalService>,
) -> Result<TerminalAnchor, TerminalError> {
    terminals.anchor(terminal_id, space, at)
}

/// Where an anchored line is now, in every space that still names it.
///
/// A handle the host does not hold answers with nothing rather than with
/// another line, so a client that outlived its own anchor learns so.
#[tauri::command]
pub fn resolve_terminal_anchor(
    terminal_id: TerminalId,
    anchor: TerminalAnchorId,
    terminals: State<'_, TerminalService>,
) -> Result<Option<TerminalAnchor>, TerminalError> {
    terminals.resolve_anchor(terminal_id, anchor)
}

/// Drop an anchor, answering whether the host was holding it.
#[tauri::command]
pub fn release_terminal_anchor(
    terminal_id: TerminalId,
    anchor: TerminalAnchorId,
    terminals: State<'_, TerminalService>,
) -> Result<bool, TerminalError> {
    terminals.release_anchor(terminal_id, anchor)
}

/// Select by intent, and answer what the host holds.
///
/// The client names a point, a word, a command's output or a movement. It never
/// names a set of cells: which cells an intent covers depends on where rows
/// wrap, where a word ends, where the OSC 133 marks are and where history
/// begins, and a client that decided that would be the second authority on the
/// screen this path exists to end. The selected text comes back with the
/// answer, so copying needs no client-side reconstruction either.
#[tauri::command]
pub fn select_terminal(
    terminal_id: TerminalId,
    request: TerminalSelectionRequest,
    terminals: State<'_, TerminalService>,
) -> Result<TerminalSelectionState, TerminalError> {
    terminals.select(terminal_id, request)
}

#[tauri::command]
pub fn resize_terminal(
    terminal_id: TerminalId,
    attachment_id: TerminalAttachmentId,
    columns: u16,
    rows: u16,
    terminals: State<'_, TerminalService>,
) -> Result<(), String> {
    terminals
        .resize(terminal_id, attachment_id, columns, rows)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn close_terminal(
    terminal_id: TerminalId,
    terminals: State<'_, TerminalService>,
) -> Result<TerminalCloseResult, String> {
    terminals
        .close(terminal_id)
        .map_err(|error| error.to_string())
}

/// Open an attachment for the webview, in the encoding it names.
///
/// The encoding is the caller's and has no default here. Choosing one for a
/// client that did not ask is how the webview stayed on the byte path while
/// every other client could select the semantic one; the control socket's own
/// default exists only for clients built before the field did, which the
/// webview is not. The field, and the choice, die with area 05.
#[tauri::command]
pub fn attach_terminal(
    terminal_id: TerminalId,
    claims_resize: bool,
    transport: TerminalTransport,
    on_event: Channel<Response>,
    terminals: State<'_, TerminalService>,
) -> Result<TerminalAttachment, String> {
    let sink: Arc<dyn TerminalEventSink> = Arc::new(TauriTerminalEventSink { on_event });
    terminals
        .attach_with(terminal_id, sink, claims_resize, transport)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn detach_terminal(
    attachment_id: TerminalAttachmentId,
    terminals: State<'_, TerminalService>,
) -> Result<(), String> {
    terminals
        .detach(attachment_id)
        .map_err(|error| error.to_string())
}

/// Grant one more replaceable semantic screen after the renderer committed
/// the named frame. Lifecycle and effect events do not consume this credit.
#[tauri::command]
pub fn credit_terminal_screen(
    attachment_id: TerminalAttachmentId,
    committed_sequence: u64,
    terminals: State<'_, TerminalService>,
) -> Result<(), TerminalError> {
    terminals.credit_screen(attachment_id, committed_sequence)
}

/// Subscribe before listing to close the create/exit race during renderer
/// reconciliation. The feed is inventory state only; terminal bytes continue
/// to use independently detachable output attachments.
#[tauri::command]
pub fn subscribe_terminal_registry(
    on_event: Channel<TerminalRegistryEvent>,
    terminals: State<'_, TerminalService>,
) -> TerminalRegistrySubscriptionId {
    let sink: Arc<dyn TerminalRegistryEventSink> = Arc::new(move |event| {
        on_event
            .send(event)
            .map_err(|error| format!("Terminal registry channel closed: {error}"))
    });
    terminals.subscribe_registry(sink)
}

#[tauri::command]
pub fn unsubscribe_terminal_registry(
    subscription_id: TerminalRegistrySubscriptionId,
    terminals: State<'_, TerminalService>,
) {
    terminals.unsubscribe_registry(subscription_id);
}

#[tauri::command]
pub fn update_terminal_color_theme(
    color_theme: TerminalColorTheme,
    terminals: State<'_, TerminalService>,
) -> Result<(), String> {
    terminals
        .set_color_theme(color_theme)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn update_terminal_metadata(
    terminal_id: TerminalId,
    metadata: TerminalMetadata,
    terminals: State<'_, TerminalService>,
) -> Result<TerminalDescriptor, String> {
    terminals
        .update_metadata(terminal_id, metadata)
        .map_err(|error| error.to_string())
}

/// The canonical result of reading or committing terminal settings.
///
/// `retention_revision` lets a client discard its own delayed response: a lower
/// revision than the one it already holds describes an older policy.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettingsCommit {
    #[serde(flatten)]
    pub settings: TerminalSettings,
    pub retention_revision: u64,
}

#[tauri::command]
pub fn get_terminal_settings(
    workspace: State<'_, WorkspaceManager>,
    terminals: State<'_, TerminalService>,
) -> Result<TerminalSettingsCommit, String> {
    let mut settings = workspace.load_terminal_settings()?;
    normalize_terminal_settings(&mut settings);
    Ok(TerminalSettingsCommit {
        settings,
        retention_revision: terminals.retention().revision,
    })
}

/// Normalize, persist, then commit the service revision. Durable persistence
/// and the service revision are one product commit; terminals created after it
/// use the new policy and running terminals keep the policy they were built
/// with, because the pinned parser accepts a retention budget only at
/// construction.
#[tauri::command]
pub fn save_terminal_settings(
    mut settings: TerminalSettings,
    workspace: State<'_, WorkspaceManager>,
    terminals: State<'_, TerminalService>,
) -> Result<TerminalSettingsCommit, String> {
    normalize_terminal_settings(&mut settings);
    workspace.save_terminal_settings(&settings)?;
    let committed = terminals.set_retention(TerminalRetentionPolicy::from_bytes(
        settings.scrollback_bytes,
    ));
    Ok(TerminalSettingsCommit {
        settings,
        retention_revision: committed.revision,
    })
}

/// Classify paste text with the host's terminal-input policy.
#[tauri::command]
pub fn is_terminal_paste_safe(text: &str) -> bool {
    paste_is_safe(text)
}

#[derive(serde::Serialize)]
pub struct MemoryStats {
    pub app_rss: u64,
    pub children_rss: u64,
}

#[tauri::command]
pub async fn get_memory_stats(
    terminals: State<'_, TerminalService>,
) -> Result<MemoryStats, String> {
    let app_rss = rss_for_pid(std::process::id() as i32);
    let mut children_rss = 0;
    for pid in terminals.child_pids() {
        let pid = pid as i32;
        children_rss += rss_for_pid(pid);
        if let Ok(output) = Command::new("pgrep")
            .arg("-P")
            .arg(pid.to_string())
            .output()
        {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                if let Ok(child) = line.trim().parse::<i32>() {
                    children_rss += rss_for_pid(child);
                }
            }
        }
    }
    Ok(MemoryStats {
        app_rss,
        children_rss,
    })
}

fn rss_for_pid(pid: i32) -> u64 {
    Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|kilobytes| kilobytes * 1024)
        .unwrap_or(0)
}
