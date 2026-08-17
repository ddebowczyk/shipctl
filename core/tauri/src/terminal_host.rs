use std::process::Command;
use std::sync::Arc;

use shipctl_core::terminal_host::TerminalColorTheme;
use tauri::ipc::{Channel, Response};
use tauri::State;

use shipctl_core::terminal_host::retention::TerminalRetentionPolicy;
use shipctl_core::terminal_host::runtime::{
    PublishedTerminalEvent, TerminalEventSink, TerminalPublicationStats,
};
use shipctl_core::terminal_host::service::{TerminalRegistryEventSink, TerminalService};
use shipctl_core::terminal_host::types::{
    TerminalAttachmentId, TerminalCloseResult, TerminalDescriptor, TerminalError, TerminalEvent,
    TerminalId, TerminalLaunchRequest, TerminalMetadata, TerminalRawAttachment,
    TerminalRegistryEvent, TerminalRegistrySubscriptionId,
};
use shipctl_core::workspace::config::{normalize_terminal_settings, TerminalSettings};
use shipctl_core::workspace::manager::WorkspaceManager;

struct TauriTerminalEventSink {
    on_event: Channel<Response>,
}

impl TerminalEventSink for TauriTerminalEventSink {
    fn publish(
        &self,
        _terminal_id: shipctl_core::terminal_host::types::TerminalId,
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
        _terminal_id: shipctl_core::terminal_host::types::TerminalId,
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

/// Attach the generic, exact PTY byte stream. Terminal implementations select
/// their own parser after this boundary; no caller supplies a migration
/// transport selector.
#[tauri::command]
pub fn attach_raw_terminal(
    terminal_id: TerminalId,
    claims_resize: bool,
    on_event: Channel<Response>,
    terminals: State<'_, TerminalService>,
) -> Result<TerminalRawAttachment, String> {
    let sink: Arc<dyn TerminalEventSink> = Arc::new(TauriTerminalEventSink { on_event });
    terminals
        .attach_raw(terminal_id, sink, claims_resize)
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
