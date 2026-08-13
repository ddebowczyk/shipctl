use tauri::State;

use shipctl_core::instance::ControlError;
use shipctl_core::module_control::live::{
    FrontendRuntimeSnapshotInput, ModuleControlService, RuntimeSnapshotReceipt,
    StartupModuleCatalog,
};

#[tauri::command]
pub fn publish_module_runtime_snapshot(
    service: State<'_, ModuleControlService>,
    snapshot: FrontendRuntimeSnapshotInput,
) -> Result<RuntimeSnapshotReceipt, ControlError> {
    service.publish_frontend_snapshot(snapshot)
}

#[tauri::command]
pub fn list_startup_modules(
    service: State<'_, ModuleControlService>,
) -> Result<StartupModuleCatalog, ControlError> {
    service.startup_modules()
}
