use tauri::State;

use shipctl_core::instance::{InstanceContext, InstanceInspection};
use shipctl_core::state::paths::ShipctlPaths;

#[tauri::command]
pub fn inspect_instance(
    context: State<'_, InstanceContext>,
    paths: State<'_, ShipctlPaths>,
) -> InstanceInspection {
    InstanceInspection {
        context: context.inner().clone(),
        durable_sources: paths.durable_sources(),
    }
}
