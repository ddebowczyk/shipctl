use std::sync::Arc;

use shep_module_api::TerminalOutput;
use shep_module_assistants::{
    HostServices, PiConfigAuthority, PiSettings, TerminalAuthority, TerminalLaunchRequest,
};
use tauri::ipc::Channel;

use crate::pty::manager::PtyManager;

struct HostTerminalAuthority {
    manager: PtyManager,
}

struct HostPiConfigAuthority;

impl PiConfigAuthority for HostPiConfigAuthority {
    fn get(&self) -> Result<shep_module_assistants::PiConfig, String> {
        crate::pi_config::get_pi_config()
    }

    fn save_settings(&self, settings: PiSettings) -> Result<(), String> {
        crate::pi_config::save_pi_settings(settings)
    }

    fn save_api_key(&self, provider: &str, api_key: &str) -> Result<(), String> {
        crate::pi_config::save_pi_api_key(provider, api_key)
    }

    fn delete_api_key(&self, provider: &str) -> Result<(), String> {
        crate::pi_config::delete_pi_api_key(provider)
    }
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
    HostServices::new(
        Arc::new(HostTerminalAuthority { manager }),
        Arc::new(HostPiConfigAuthority),
    )
}
