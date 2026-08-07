use std::sync::Arc;

use shep_module_usage::{HostServices, ProviderSettingsAuthority, ProviderVisibility};

use crate::workspace::manager::WorkspaceManager;

struct WorkspaceProviderSettings;

impl ProviderSettingsAuthority for WorkspaceProviderSettings {
    fn provider_visibility(&self) -> ProviderVisibility {
        let settings = WorkspaceManager::new()
            .load_usage_settings()
            .unwrap_or_default();
        ProviderVisibility {
            claude: settings.claude.show,
            codex: settings.codex.show,
            gemini: settings.gemini.show,
            antigravity: settings.antigravity.show,
        }
    }
}

pub fn host_services() -> HostServices {
    HostServices::new(Arc::new(WorkspaceProviderSettings))
}
