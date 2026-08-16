//! Private Tauri transport for the public Scheduler semantic service.

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

use shipctl_core::scheduler::{
    RegisterScheduleInput, ScheduleLeaseInspection, SchedulerActor, SchedulerDeliveryFrame,
    SchedulerLeaseError, SchedulerLeaseService, SCHEDULER_INVALID_REQUEST,
};

use crate::message_bridge::MessageBusBridgeService;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateSchedulerActivation {
    module_id: String,
    activation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateSchedulerRequest<Input> {
    bridge_id: String,
    activation: PrivateSchedulerActivation,
    correlation_id: String,
    input: Input,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectSchedulesInput {
    owner: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelScheduleInput {
    lease_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StopScheduleObserverInput {
    observer_id: String,
}

fn invalid_request(message: &'static str) -> SchedulerLeaseError {
    SchedulerLeaseError {
        code: SCHEDULER_INVALID_REQUEST.to_string(),
        message: message.to_string(),
        retryable: false,
    }
}

fn validate_request<Input>(
    request: &PrivateSchedulerRequest<Input>,
) -> Result<(), SchedulerLeaseError> {
    if request.correlation_id.trim().is_empty()
        || request.correlation_id.chars().any(char::is_control)
    {
        Err(invalid_request(
            "The scheduler correlation identity is invalid",
        ))
    } else {
        Ok(())
    }
}

async fn authority<Input>(
    request: &PrivateSchedulerRequest<Input>,
    bridges: &MessageBusBridgeService,
) -> Result<
    (
        SchedulerActor,
        shipctl_core::message_bus::ModuleMessageAuthority,
    ),
    SchedulerLeaseError,
> {
    validate_request(request)?;
    let (module_id, authority) = bridges
        .activation_authority(&request.bridge_id, &request.activation.activation_id)
        .await
        .map_err(|_| invalid_request("The scheduler bridge binding is not active"))?;
    if request.activation.module_id != module_id {
        return Err(invalid_request(
            "The scheduler module identity does not match its bridge binding",
        ));
    }
    Ok((
        SchedulerActor {
            module_id,
            activation_id: request.activation.activation_id.clone(),
        },
        authority,
    ))
}

#[tauri::command]
pub async fn register_semantic_schedule(
    request: PrivateSchedulerRequest<RegisterScheduleInput>,
    bridges: State<'_, MessageBusBridgeService>,
    schedules: State<'_, SchedulerLeaseService>,
) -> Result<ScheduleLeaseInspection, SchedulerLeaseError> {
    let (actor, authority) = authority(&request, &bridges).await?;
    schedules.register(actor, &authority, request.input).await
}

#[tauri::command]
pub async fn inspect_semantic_schedules(
    request: PrivateSchedulerRequest<InspectSchedulesInput>,
    bridges: State<'_, MessageBusBridgeService>,
    schedules: State<'_, SchedulerLeaseService>,
) -> Result<Vec<ScheduleLeaseInspection>, SchedulerLeaseError> {
    let (actor, authority) = authority(&request, &bridges).await?;
    if request.input.owner != "activation" {
        return Err(invalid_request("The scheduler inspection scope is invalid"));
    }
    schedules.inspect(&actor, &authority)
}

#[tauri::command]
pub async fn cancel_semantic_schedule(
    request: PrivateSchedulerRequest<CancelScheduleInput>,
    bridges: State<'_, MessageBusBridgeService>,
    schedules: State<'_, SchedulerLeaseService>,
) -> Result<bool, SchedulerLeaseError> {
    let (actor, authority) = authority(&request, &bridges).await?;
    let lease_id = Uuid::parse_str(&request.input.lease_id)
        .map_err(|_| invalid_request("The schedule lease identity is invalid"))?;
    schedules.cancel(&actor, &authority, lease_id).await
}

#[tauri::command]
pub async fn observe_semantic_schedule_deliveries(
    request: PrivateSchedulerRequest<InspectSchedulesInput>,
    on_delivery: Channel<SchedulerDeliveryFrame>,
    bridges: State<'_, MessageBusBridgeService>,
    schedules: State<'_, SchedulerLeaseService>,
) -> Result<String, SchedulerLeaseError> {
    let (actor, authority) = authority(&request, &bridges).await?;
    if request.input.owner != "activation" {
        return Err(invalid_request(
            "The scheduler observation scope is invalid",
        ));
    }
    schedules
        .observe(&actor, &authority, move |frame| {
            let _ = on_delivery.send(frame);
        })
        .map(|observer_id| observer_id.to_string())
}

#[tauri::command]
pub async fn stop_semantic_schedule_observer(
    request: PrivateSchedulerRequest<StopScheduleObserverInput>,
    bridges: State<'_, MessageBusBridgeService>,
    schedules: State<'_, SchedulerLeaseService>,
) -> Result<bool, SchedulerLeaseError> {
    let (actor, authority) = authority(&request, &bridges).await?;
    let observer_id = Uuid::parse_str(&request.input.observer_id)
        .map_err(|_| invalid_request("The scheduler observer identity is invalid"))?;
    schedules.stop_observing(&actor, &authority, observer_id)
}
