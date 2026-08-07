use std::sync::Arc;

use shep_module_usage::{GlobalCapabilityDataAuthority, HostServices};

use shep_core::workspace::manager::WorkspaceManager;

struct WorkspaceGlobalCapabilityData;

impl GlobalCapabilityDataAuthority for WorkspaceGlobalCapabilityData {
    fn read(&self, capability_id: &str) -> Result<Option<serde_json::Value>, String> {
        WorkspaceManager::new().load_global_capability_data(capability_id)
    }
}

pub fn host_services() -> HostServices {
    HostServices::new(Arc::new(WorkspaceGlobalCapabilityData))
}
