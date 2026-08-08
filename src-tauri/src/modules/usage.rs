use std::sync::Arc;

use shipctl_module_usage::{GlobalCapabilityDataAuthority, HostServices};

use shipctl_core::workspace::manager::WorkspaceManager;

struct WorkspaceGlobalCapabilityData {
    workspace: WorkspaceManager,
}

impl GlobalCapabilityDataAuthority for WorkspaceGlobalCapabilityData {
    fn read(&self, capability_id: &str) -> Result<Option<serde_json::Value>, String> {
        self.workspace.load_global_capability_data(capability_id)
    }
}

pub fn host_services(workspace: WorkspaceManager) -> HostServices {
    HostServices::new(Arc::new(WorkspaceGlobalCapabilityData { workspace }))
}
