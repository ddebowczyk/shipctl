use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::watch;
use uuid::Uuid;

use shipctl_core::instance::ControlError;
use shipctl_core::module_control::live::{
    FrontendRuntimeSnapshotInput, ModuleControlService, ReconciliationFailureInput,
    RuntimeModuleCatalog, RuntimeSnapshotReceipt,
};
use shipctl_core::module_control::REVISION_OBSERVER_UNAVAILABLE;

#[derive(Clone, Default)]
pub struct ModuleRegistryRevisionObservers {
    cancellations: Arc<Mutex<BTreeMap<Uuid, watch::Sender<bool>>>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleRegistryRevisionFrame {
    schema_version: u32,
    registry_revision: u64,
}

impl ModuleRegistryRevisionObservers {
    fn register(&self) -> Result<(Uuid, watch::Receiver<bool>), ControlError> {
        let observer_id = Uuid::new_v4();
        let (cancel, receiver) = watch::channel(false);
        self.cancellations
            .lock()
            .map_err(|_| revision_observer_error("The module revision observer lock is poisoned"))?
            .insert(observer_id, cancel);
        Ok((observer_id, receiver))
    }

    fn remove(&self, observer_id: Uuid) -> Result<bool, ControlError> {
        let cancellation = self
            .cancellations
            .lock()
            .map_err(|_| revision_observer_error("The module revision observer lock is poisoned"))?
            .remove(&observer_id);
        if let Some(cancellation) = cancellation {
            cancellation.send_replace(true);
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

fn revision_observer_error(message: &'static str) -> ControlError {
    ControlError::new(REVISION_OBSERVER_UNAVAILABLE, message)
}

#[tauri::command]
pub fn publish_module_runtime_snapshot(
    service: State<'_, ModuleControlService>,
    snapshot: FrontendRuntimeSnapshotInput,
) -> Result<RuntimeSnapshotReceipt, ControlError> {
    service.publish_frontend_snapshot(snapshot)
}

#[tauri::command]
pub fn list_runtime_modules(
    service: State<'_, ModuleControlService>,
) -> Result<RuntimeModuleCatalog, ControlError> {
    service.runtime_modules()
}

/// Open one instance-scoped revision stream. Its first frame is the current
/// durable revision. Later frames may coalesce because the frontend rereads
/// the complete desired catalog after each frame.
#[tauri::command]
pub async fn observe_module_registry_revisions(
    service: State<'_, ModuleControlService>,
    observers: State<'_, ModuleRegistryRevisionObservers>,
    on_revision: Channel<ModuleRegistryRevisionFrame>,
) -> Result<String, ControlError> {
    let (observer_id, mut cancellation) = observers.register()?;
    let mut revisions = service.observe_registry_revisions();
    let observer_registry = observers.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut last_sent = None;
        loop {
            if *cancellation.borrow() {
                break;
            }
            let revision = *revisions.borrow_and_update();
            if last_sent != Some(revision) {
                let frame = ModuleRegistryRevisionFrame {
                    schema_version: 1,
                    registry_revision: revision,
                };
                if on_revision.send(frame).is_err() {
                    break;
                }
                last_sent = Some(revision);
            }
            tokio::select! {
                changed = revisions.changed() => {
                    if changed.is_err() {
                        break;
                    }
                }
                changed = cancellation.changed() => {
                    if changed.is_err() || *cancellation.borrow() {
                        break;
                    }
                }
            }
        }
        if let Ok(mut active) = observer_registry.cancellations.lock() {
            active.remove(&observer_id);
        }
    });
    Ok(observer_id.to_string())
}

#[tauri::command]
pub fn stop_module_registry_revision_observer(
    observers: State<'_, ModuleRegistryRevisionObservers>,
    observer_id: String,
) -> Result<bool, ControlError> {
    let observer_id = Uuid::parse_str(&observer_id)
        .map_err(|_| revision_observer_error("The module revision observer id is invalid"))?;
    observers.remove(observer_id)
}

#[tauri::command]
pub fn report_module_reconciliation_failure(
    service: State<'_, ModuleControlService>,
    failure: ReconciliationFailureInput,
) -> Result<(), ControlError> {
    service.report_reconciliation_failure(failure)
}
