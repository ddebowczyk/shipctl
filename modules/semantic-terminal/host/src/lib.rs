//! The semantic-terminal module's native host adapter.
//!
//! This crate is the only integration point that sees both the removable
//! semantic module and Shipctl's terminal host. The app bundle composes its
//! public functions but owns no semantic-terminal behavior.

use std::process::Command;
use std::str::FromStr;
use std::sync::Arc;

use shipctl_core::terminal_host::{
    TerminalAttachmentId, TerminalDriverEventSink, TerminalId, TerminalService,
};
use shipctl_module_api::TerminalDriverRegistry;
use shipctl_module_semantic_terminal_core::{
    HostServices, SemanticTerminalEventSink, SemanticTerminalHost,
};
use tauri::{Builder, Runtime};

struct HostSemanticTerminal {
    terminals: TerminalService,
}

impl HostSemanticTerminal {
    fn terminal_id(value: &str) -> Result<TerminalId, String> {
        TerminalId::from_str(value).map_err(|error| format!("Invalid terminal ID: {error}"))
    }

    fn attachment_id(value: &str) -> Result<TerminalAttachmentId, String> {
        serde_json::from_value(serde_json::Value::String(value.to_string()))
            .map_err(|error| format!("Invalid terminal attachment ID: {error}"))
    }

    fn encode(value: impl serde::Serialize) -> Result<serde_json::Value, String> {
        serde_json::to_value(value)
            .map_err(|error| format!("Could not encode semantic terminal response: {error}"))
    }

    fn app_rss() -> u64 {
        Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .and_then(|value| value.trim().parse::<u64>().ok())
            .map(|kilobytes| kilobytes * 1024)
            .unwrap_or(0)
    }
}

impl SemanticTerminalHost for HostSemanticTerminal {
    fn request(
        &self,
        terminal_id: &str,
        request: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.terminals
            .request_driver(Self::terminal_id(terminal_id)?, request)
            .map_err(|error| error.to_string())
    }

    fn attach(
        &self,
        terminal_id: &str,
        claims_resize: bool,
        on_event: SemanticTerminalEventSink,
    ) -> Result<serde_json::Value, String> {
        let sink: Arc<dyn TerminalDriverEventSink> =
            Arc::new(move |_terminal_id, event| on_event(event));
        Self::encode(
            self.terminals
                .attach_driver(Self::terminal_id(terminal_id)?, sink, claims_resize)
                .map_err(|error| error.to_string())?,
        )
    }

    fn detach(&self, attachment_id: &str) -> Result<(), String> {
        self.terminals
            .detach(Self::attachment_id(attachment_id)?)
            .map_err(|error| error.to_string())
    }

    fn credit_screen(&self, attachment_id: &str, committed_sequence: u64) -> Result<(), String> {
        self.terminals
            .credit_driver_presentation(Self::attachment_id(attachment_id)?, committed_sequence)
            .map_err(|error| error.to_string())
    }

    fn resize(
        &self,
        terminal_id: &str,
        attachment_id: &str,
        columns: u16,
        rows: u16,
    ) -> Result<(), String> {
        self.terminals
            .resize(
                Self::terminal_id(terminal_id)?,
                Self::attachment_id(attachment_id)?,
                columns,
                rows,
            )
            .map_err(|error| error.to_string())
    }

    fn publication_stats(&self, terminal_id: &str) -> Result<serde_json::Value, String> {
        Self::encode(
            self.terminals
                .publication_stats(Self::terminal_id(terminal_id)?)
                .map_err(|error| error.to_string())?,
        )
    }

    fn app_memory(&self) -> Result<serde_json::Value, String> {
        Ok(serde_json::json!({ "appRss": Self::app_rss() }))
    }
}

fn host_services(terminals: TerminalService) -> HostServices {
    HostServices::new(Arc::new(HostSemanticTerminal { terminals }))
}

/// Register the module's native terminal driver.
pub fn register_native_driver(drivers: &mut TerminalDriverRegistry) {
    drivers
        .register(shipctl_module_semantic_terminal_core::native_factory())
        .expect("the semantic terminal driver registers once");
}

/// Install the module-owned Tauri command namespace with its host bridge.
pub fn install<R: Runtime>(builder: Builder<R>, terminals: TerminalService) -> Builder<R> {
    builder.plugin(shipctl_module_semantic_terminal::init(host_services(
        terminals,
    )))
}
