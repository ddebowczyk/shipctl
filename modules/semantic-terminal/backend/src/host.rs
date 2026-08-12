//! Host operations that the semantic-terminal plugin needs.
//!
//! The module owns the command names and semantic payloads. The executable
//! composition root supplies this narrow adapter so the module never imports
//! the core PTY implementation.

use serde_json::Value as JsonValue;
use std::sync::Arc;

/// Delivers one module-owned semantic event to a webview attachment.
pub type SemanticTerminalEventSink = Arc<dyn Fn(JsonValue) -> Result<(), String> + Send + Sync>;

/// The semantic operations the host routes to the selected terminal driver.
///
/// JSON is intentional at this plugin boundary: all schemas and decoding stay
/// in the semantic module, and the host does not acquire semantic screen,
/// selection, history, or input types.
pub trait SemanticTerminalHost: Send + Sync {
    /// Route one module-owned request to the selected driver. The request and
    /// response schemas stay in this module.
    fn request(&self, terminal_id: &str, request: JsonValue) -> Result<JsonValue, String>;
    fn attach(
        &self,
        terminal_id: &str,
        claims_resize: bool,
        on_event: SemanticTerminalEventSink,
    ) -> Result<JsonValue, String>;
    /// Release one semantic presentation attachment. The attachment id is
    /// opaque to this module; the host verifies it belongs to the terminal
    /// session before releasing its physical resize claim.
    fn detach(&self, attachment_id: &str) -> Result<(), String>;
    /// Commit the semantic driver's last screen frame and permit one newer
    /// frame. The host applies credit without decoding the semantic event.
    fn credit_screen(&self, attachment_id: &str, committed_sequence: u64) -> Result<(), String>;
    /// Apply a physical terminal resize on behalf of the attachment that owns
    /// the semantic presentation. The host remains the PTY size authority.
    fn resize(
        &self,
        terminal_id: &str,
        attachment_id: &str,
        columns: u16,
        rows: u16,
    ) -> Result<(), String>;
    /// Read host-owned publication observations for a semantic terminal.
    /// The numbers remain opaque JSON so the host does not decode semantic
    /// presentation state and the module owns the public command schema.
    fn publication_stats(&self, terminal_id: &str) -> Result<JsonValue, String>;
    /// Read the process RSS for development-only scenario measurements.
    fn app_memory(&self) -> Result<JsonValue, String>;
}

/// Build-time composition of the semantic module with its host adapter.
#[derive(Clone)]
pub struct HostServices {
    terminal: Arc<dyn SemanticTerminalHost>,
}

impl HostServices {
    pub fn new(terminal: Arc<dyn SemanticTerminalHost>) -> Self {
        Self { terminal }
    }

    pub(crate) fn terminal(&self) -> &Arc<dyn SemanticTerminalHost> {
        &self.terminal
    }
}
