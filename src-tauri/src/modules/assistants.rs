use std::str::FromStr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use shipctl_module_api::{
    ModuleTerminalCloseResult, ModuleTerminalId, ModuleTerminalSpawnRequest, TerminalAuthority,
};
use shipctl_module_assistants::HostServices;

use shipctl_core::terminal::{
    TerminalId, TerminalLaunchRequest as HostLaunchRequest, TerminalLaunchTarget, TerminalMetadata,
    TerminalOwner, TerminalService,
};

struct HostTerminalAuthority {
    terminals: TerminalService,
}

impl TerminalAuthority for HostTerminalAuthority {
    fn spawn(&self, request: ModuleTerminalSpawnRequest) -> Result<ModuleTerminalId, String> {
        let descriptor = self
            .terminals
            .spawn(HostLaunchRequest {
                target: TerminalLaunchTarget::Program {
                    program: request.command.clone().into(),
                    argv: request.arguments,
                },
                cwd: request.cwd.clone().into(),
                environment: request.environment,
                columns: request.columns,
                rows: request.rows,
                color_theme: request.color_theme,
                metadata: TerminalMetadata {
                    label: request.label,
                    cwd: request.cwd.into(),
                    project_path: Some(request.project_path.into()),
                    display_command: request.command,
                    created_at_ms: now_epoch_millis(),
                    owner: TerminalOwner::Module {
                        module_id: request.module_id,
                        owner_key: request.owner_key,
                        module_session_id: request.module_session_id,
                    },
                    owner_metadata: Some(request.owner_metadata),
                    presentation: request.presentation,
                },
            })
            .map_err(|error| error.to_string())?;
        ModuleTerminalId::from_host(descriptor.id.to_string())
    }

    fn close(&self, terminal_id: &ModuleTerminalId) -> Result<ModuleTerminalCloseResult, String> {
        let terminal_id = TerminalId::from_str(terminal_id.as_str())
            .map_err(|error| format!("Invalid terminal ID: {error}"))?;
        self.terminals
            .close(terminal_id)
            .map(|result| ModuleTerminalCloseResult {
                existed: result.existed,
            })
            .map_err(|error| error.to_string())
    }
}

pub fn host_services(terminals: TerminalService) -> HostServices {
    HostServices::new(Arc::new(HostTerminalAuthority { terminals }))
}

fn now_epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
