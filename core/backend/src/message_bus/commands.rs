use tauri::ipc::Channel;
use tauri::State;

use super::bridge::{
    FrontendBridgeRegistration, HostMessageFrame, MessageBridgeInspection,
    MessageBridgeOpenReceipt, MessageBridgeReply, MessageBusBridgeService,
};
use super::contracts::{
    DeliveryReceipt, MessageContractError, MessageEnvelope, MessageRouteSnapshot, PublishReceipt,
};

#[tauri::command]
pub async fn open_runtime_message_bridge(
    registrations: Vec<FrontendBridgeRegistration>,
    on_frame: Channel<HostMessageFrame>,
    bridges: State<'_, MessageBusBridgeService>,
) -> Result<MessageBridgeOpenReceipt, MessageContractError> {
    bridges.open(registrations, on_frame).await
}

#[tauri::command]
pub async fn reconcile_runtime_message_bridge(
    bridge_id: &str,
    expected_route_generation: u64,
    registrations: Vec<FrontendBridgeRegistration>,
    bridges: State<'_, MessageBusBridgeService>,
) -> Result<MessageBridgeOpenReceipt, MessageContractError> {
    bridges
        .reconcile(bridge_id, expected_route_generation, registrations)
        .await
}

#[tauri::command]
pub async fn close_runtime_message_bridge(
    bridge_id: &str,
    bridges: State<'_, MessageBusBridgeService>,
) -> Result<MessageRouteSnapshot, MessageContractError> {
    bridges.close(bridge_id).await
}

#[tauri::command]
pub async fn send_runtime_message(
    bridge_id: &str,
    activation_id: &str,
    envelope: MessageEnvelope,
    bridges: State<'_, MessageBusBridgeService>,
) -> Result<DeliveryReceipt, MessageContractError> {
    bridges.send(bridge_id, activation_id, envelope).await
}

#[tauri::command]
pub async fn publish_runtime_message(
    bridge_id: &str,
    activation_id: &str,
    envelope: MessageEnvelope,
    bridges: State<'_, MessageBusBridgeService>,
) -> Result<PublishReceipt, MessageContractError> {
    bridges.publish(bridge_id, activation_id, envelope).await
}

#[tauri::command]
pub async fn request_runtime_message(
    bridge_id: &str,
    activation_id: &str,
    envelope: MessageEnvelope,
    bridges: State<'_, MessageBusBridgeService>,
) -> Result<MessageEnvelope, MessageContractError> {
    bridges.request(bridge_id, activation_id, envelope).await
}

#[tauri::command]
pub async fn reply_runtime_message(
    bridge_id: &str,
    reply: MessageBridgeReply,
    bridges: State<'_, MessageBusBridgeService>,
) -> Result<(), MessageContractError> {
    bridges.reply(bridge_id, reply).await
}

#[tauri::command]
pub async fn report_runtime_message_failure(
    bridge_id: &str,
    activation_id: &str,
    endpoint: &str,
    code: &str,
    bridges: State<'_, MessageBusBridgeService>,
) -> Result<(), MessageContractError> {
    bridges
        .report_failure(bridge_id, activation_id, endpoint, code)
        .await
}

#[tauri::command]
pub async fn inspect_runtime_messages(
    bridges: State<'_, MessageBusBridgeService>,
) -> Result<MessageBridgeInspection, MessageContractError> {
    Ok(bridges.inspect().await)
}
