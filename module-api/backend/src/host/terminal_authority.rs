use crate::protocol::{ModuleTerminalCloseResult, ModuleTerminalId, ModuleTerminalSpawnRequest};

/// Transport-neutral terminal authority implemented by the Shipctl host.
pub trait TerminalAuthority: Send + Sync {
    fn spawn(&self, request: ModuleTerminalSpawnRequest) -> Result<ModuleTerminalId, String>;
    fn close(&self, terminal_id: &ModuleTerminalId) -> Result<ModuleTerminalCloseResult, String>;
}
