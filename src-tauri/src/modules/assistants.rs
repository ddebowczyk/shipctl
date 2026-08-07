use std::sync::Arc;

use shep_module_api::TerminalOutput;
use shep_module_assistants::{HostServices, TerminalAuthority, TerminalLaunchRequest};
use tauri::ipc::Channel;

use shep_core::terminal::manager::PtyManager;

struct HostTerminalAuthority {
    manager: PtyManager,
}

impl TerminalAuthority for HostTerminalAuthority {
    fn spawn(
        &self,
        request: TerminalLaunchRequest,
        on_data: Channel<TerminalOutput>,
    ) -> Result<u32, String> {
        self.manager.spawn(
            &request.command,
            Some(request.arguments),
            &request.cwd,
            request.environment,
            request.columns,
            request.rows,
            request.color_theme,
            on_data,
        )
    }

    fn kill(&self, terminal_id: u32) -> Result<(), String> {
        self.manager.kill(terminal_id)
    }
}

pub fn host_services(manager: PtyManager) -> HostServices {
    HostServices::new(Arc::new(HostTerminalAuthority { manager }))
}
