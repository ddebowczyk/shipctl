use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, Weak};

use tauri::ipc::Channel;
use tokio::sync::{oneshot, Mutex as AsyncMutex};
use tokio::task::JoinHandle;
use uuid::Uuid;

use shipctl_core::message_bus::{
    DeliveryReceipt, FrontendBridgeRegistration, HostMessageFrame, HostMessageFrameKind,
    MessageBridgeInspection, MessageBridgeOpenReceipt, MessageBridgeRegistrationObservation,
    MessageBridgeReply, MessageContractError, MessageEnvelope, MessageRouteSnapshot, MessageTypeId,
    ModuleMessageAuthority, PreparedRegistration, PublishReceipt, RegistrationHandlers,
    RuntimeMessageBus, MESSAGE_CONTRACT_SCHEMA_VERSION,
};
use shipctl_core::message_bus::{
    BRIDGE_CLOSED, DUPLICATE_CHANNEL_OWNER, HANDLER_FAILED, HANDLER_UNAVAILABLE,
    INVALID_IDENTIFIER, NO_ACTIVE_CHANNEL_OWNER, SUBSCRIBER_LAG, UNAUTHORIZED_SENDER,
};
struct OrderedChannel {
    bridge_id: String,
    next_sequence: u64,
    channel: Channel<HostMessageFrame>,
}

impl OrderedChannel {
    fn send(
        &mut self,
        activation_id: &str,
        kind: HostMessageFrameKind,
        envelope: MessageEnvelope,
        route_generation: u64,
    ) -> Result<(), MessageContractError> {
        let sequence = self.next_sequence;
        self.next_sequence += 1;
        self.channel
            .send(HostMessageFrame {
                schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
                bridge_id: self.bridge_id.clone(),
                sequence,
                route_generation,
                activation_id: activation_id.to_string(),
                kind,
                endpoint: envelope.endpoint,
                message: envelope.message,
                payload: envelope.payload,
                correlation_id: envelope.correlation_id,
            })
            .map_err(|_| {
                MessageContractError::new(BRIDGE_CLOSED, "Frontend message bridge is closed")
            })
    }
}

type PendingReply = oneshot::Sender<Result<MessageEnvelope, MessageContractError>>;
type PreparedFrontendRegistrations = (
    Vec<Arc<PreparedRegistration>>,
    BTreeMap<String, ModuleMessageAuthority>,
);

struct FrontendBridge {
    transaction: AsyncMutex<()>,
    output: Mutex<OrderedChannel>,
    registrations: Mutex<Vec<Arc<PreparedRegistration>>>,
    registration_inputs: Mutex<Vec<FrontendBridgeRegistration>>,
    authorities: Mutex<BTreeMap<String, ModuleMessageAuthority>>,
    subscriptions: Mutex<Vec<JoinHandle<()>>>,
    pending_replies: Mutex<BTreeMap<String, PendingReply>>,
}

impl FrontendBridge {
    fn new(id: String, channel: Channel<HostMessageFrame>) -> Self {
        Self {
            transaction: AsyncMutex::new(()),
            output: Mutex::new(OrderedChannel {
                bridge_id: id.clone(),
                next_sequence: 1,
                channel,
            }),
            registrations: Mutex::new(Vec::new()),
            registration_inputs: Mutex::new(Vec::new()),
            authorities: Mutex::new(BTreeMap::new()),
            subscriptions: Mutex::new(Vec::new()),
            pending_replies: Mutex::new(BTreeMap::new()),
        }
    }

    fn send_frame(
        &self,
        activation_id: &str,
        kind: HostMessageFrameKind,
        envelope: MessageEnvelope,
        route_generation: u64,
    ) -> Result<(), MessageContractError> {
        self.output
            .lock()
            .expect("message bridge channel lock poisoned")
            .send(activation_id, kind, envelope, route_generation)
    }

    async fn request_frontend(
        &self,
        activation_id: &str,
        mut envelope: MessageEnvelope,
        route_generation: u64,
    ) -> Result<MessageEnvelope, MessageContractError> {
        let correlation_id = envelope
            .correlation_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        envelope.correlation_id = Some(correlation_id.clone());
        let (sender, receiver) = oneshot::channel();
        if self
            .pending_replies
            .lock()
            .expect("message bridge reply lock poisoned")
            .insert(correlation_id.clone(), sender)
            .is_some()
        {
            return Err(MessageContractError::new(
                INVALID_IDENTIFIER,
                "Capability-port correlation identity is already pending",
            ));
        }
        if let Err(error) = self.send_frame(
            activation_id,
            HostMessageFrameKind::PortRequest,
            envelope,
            route_generation,
        ) {
            self.pending_replies
                .lock()
                .expect("message bridge reply lock poisoned")
                .remove(&correlation_id);
            return Err(error);
        }
        receiver.await.map_err(|_| {
            MessageContractError::new(
                BRIDGE_CLOSED,
                "Frontend capability-port reply was cancelled",
            )
        })?
    }

    fn complete_reply(&self, reply: MessageBridgeReply) -> Result<(), MessageContractError> {
        let result = match (reply.response, reply.error) {
            (Some(response), None) => Ok(response),
            (None, Some(error)) => Err(error),
            _ => {
                return Err(MessageContractError::new(
                    INVALID_IDENTIFIER,
                    "Bridge replies require exactly one response or error",
                ))
            }
        };
        let sender = self
            .pending_replies
            .lock()
            .expect("message bridge reply lock poisoned")
            .remove(&reply.correlation_id)
            .ok_or_else(|| {
                MessageContractError::new(
                    INVALID_IDENTIFIER,
                    "Capability-port correlation identity is not pending",
                )
            })?;
        sender.send(result).map_err(|_| {
            MessageContractError::new(BRIDGE_CLOSED, "Capability-port requester is closed")
        })
    }

    fn authority(
        &self,
        activation_id: &str,
    ) -> Result<ModuleMessageAuthority, MessageContractError> {
        self.authorities
            .lock()
            .expect("message bridge authority lock poisoned")
            .get(activation_id)
            .cloned()
            .ok_or_else(|| {
                MessageContractError::new(
                    UNAUTHORIZED_SENDER,
                    "Activation does not belong to this frontend bridge",
                )
            })
    }

    fn authority_for_module_publish(
        &self,
        module_id: &str,
        envelope: &MessageEnvelope,
    ) -> Result<Option<ModuleMessageAuthority>, MessageContractError> {
        let registrations = self
            .registration_inputs
            .lock()
            .expect("message bridge input lock poisoned");
        let matching = registrations
            .iter()
            .filter(|registration| registration.module_id == module_id)
            .collect::<Vec<_>>();
        if matching.is_empty() {
            return Ok(None);
        }
        if matching.len() > 1 {
            return Err(MessageContractError::new(
                DUPLICATE_CHANNEL_OWNER,
                "Module has more than one active frontend message registration",
            ));
        }
        let registration = matching[0];
        if !registration
            .declarations
            .publishes
            .iter()
            .any(|declaration| {
                declaration.endpoint.id == envelope.endpoint
                    && declaration.endpoint.message == envelope.message
            })
        {
            return Err(MessageContractError::new(
                UNAUTHORIZED_SENDER,
                "Module is not declared to publish this message endpoint",
            ));
        }
        self.authority(&registration.activation_id).map(Some)
    }

    fn delivery_message(
        &self,
        activation_id: &str,
        endpoint: &str,
    ) -> Result<MessageTypeId, MessageContractError> {
        let registrations = self
            .registration_inputs
            .lock()
            .expect("message bridge input lock poisoned");
        let registration = registrations
            .iter()
            .find(|registration| registration.activation_id == activation_id)
            .ok_or_else(|| {
                MessageContractError::new(
                    UNAUTHORIZED_SENDER,
                    "Activation does not belong to this frontend bridge",
                )
            })?;
        registration
            .declarations
            .handles
            .iter()
            .find(|declaration| declaration.endpoint.id == endpoint)
            .map(|declaration| declaration.endpoint.message.clone())
            .or_else(|| {
                registration
                    .declarations
                    .subscribes
                    .iter()
                    .find(|declaration| declaration.id == endpoint)
                    .map(|declaration| declaration.message.clone())
            })
            .ok_or_else(|| {
                MessageContractError::new(
                    INVALID_IDENTIFIER,
                    "Message endpoint is not owned by this frontend activation",
                )
            })
    }

    fn shutdown(&self) {
        let pending = {
            let mut pending = self
                .pending_replies
                .lock()
                .expect("message bridge reply lock poisoned");
            std::mem::take(&mut *pending)
        };
        for (_, sender) in pending {
            let _ = sender.send(Err(MessageContractError::new(
                BRIDGE_CLOSED,
                "Frontend message bridge closed",
            )));
        }
        for task in self
            .subscriptions
            .lock()
            .expect("message bridge subscription lock poisoned")
            .drain(..)
        {
            task.abort();
        }
    }

    fn replace_subscriptions(&self, next: Vec<JoinHandle<()>>) {
        let previous = {
            let mut subscriptions = self
                .subscriptions
                .lock()
                .expect("message bridge subscription lock poisoned");
            std::mem::replace(&mut *subscriptions, next)
        };
        for task in previous {
            task.abort();
        }
    }
}

#[derive(Clone)]
pub struct MessageBusBridgeService {
    bus: RuntimeMessageBus,
    bridges: Arc<AsyncMutex<BTreeMap<String, Arc<FrontendBridge>>>>,
}

impl MessageBusBridgeService {
    pub fn new(bus: RuntimeMessageBus) -> Self {
        Self {
            bus,
            bridges: Arc::new(AsyncMutex::new(BTreeMap::new())),
        }
    }

    fn prepare_frontend_registrations(
        &self,
        bridge: &Arc<FrontendBridge>,
        registrations: &[FrontendBridgeRegistration],
    ) -> Result<PreparedFrontendRegistrations, MessageContractError> {
        let weak_bridge = Arc::downgrade(bridge);
        let mut prepared = Vec::new();
        let mut authorities = BTreeMap::new();
        for input in registrations {
            if input.module_id.trim().is_empty() {
                return Err(MessageContractError::new(
                    INVALID_IDENTIFIER,
                    "Frontend message registration requires a module identity",
                ));
            }
            let authority =
                ModuleMessageAuthority::from_host(input.activation_id.clone(), &input.grants);
            for subscription in &input.declarations.subscribes {
                authority.authorize(&format!("message.subscribe.{}", subscription.id))?;
            }
            let mut handlers = RegistrationHandlers::new();
            for declaration in &input.declarations.handles {
                let endpoint = declaration.endpoint.id.clone();
                let activation_id = input.activation_id.clone();
                let weak_bridge = Weak::clone(&weak_bridge);
                handlers =
                    handlers.with_directed_delivery(endpoint, move |envelope, generation| {
                        let weak_bridge = Weak::clone(&weak_bridge);
                        let activation_id = activation_id.clone();
                        async move {
                            weak_bridge
                                .upgrade()
                                .ok_or_else(|| {
                                    MessageContractError::new(
                                        BRIDGE_CLOSED,
                                        "Frontend bridge closed",
                                    )
                                })?
                                .send_frame(
                                    &activation_id,
                                    HostMessageFrameKind::Directed,
                                    envelope,
                                    generation,
                                )
                        }
                    });
            }
            for declaration in &input.declarations.ports {
                let endpoint = declaration.id.clone();
                let activation_id = input.activation_id.clone();
                let weak_bridge = Weak::clone(&weak_bridge);
                handlers = handlers.with_port_delivery(endpoint, move |envelope, generation| {
                    let weak_bridge = Weak::clone(&weak_bridge);
                    let activation_id = activation_id.clone();
                    async move {
                        weak_bridge
                            .upgrade()
                            .ok_or_else(|| {
                                MessageContractError::new(BRIDGE_CLOSED, "Frontend bridge closed")
                            })?
                            .request_frontend(&activation_id, envelope, generation)
                            .await
                    }
                });
            }
            prepared.push(Arc::new(PreparedRegistration::prepare(
                self.bus.context(),
                input.activation_id.clone(),
                &input.grants,
                input.declarations.clone(),
                handlers,
            )?));
            authorities.insert(input.activation_id.clone(), authority);
        }
        Ok((prepared, authorities))
    }

    fn start_subscriptions(
        &self,
        bridge: &Arc<FrontendBridge>,
        registrations: &[FrontendBridgeRegistration],
        authorities: &BTreeMap<String, ModuleMessageAuthority>,
    ) -> Result<Vec<JoinHandle<()>>, MessageContractError> {
        let mut tasks = Vec::new();
        for input in registrations {
            let authority = authorities.get(&input.activation_id).ok_or_else(|| {
                MessageContractError::new(
                    UNAUTHORIZED_SENDER,
                    "Activation does not belong to this frontend bridge",
                )
            })?;
            for declaration in &input.declarations.subscribes {
                let mut subscription = self.bus.subscribe(authority, &declaration.id)?;
                let weak_bridge = Arc::downgrade(bridge);
                let activation_id = input.activation_id.clone();
                tasks.push(tokio::spawn(async move {
                    loop {
                        match subscription.recv_delivery().await {
                            Ok(delivery) => {
                                let Some(bridge) = weak_bridge.upgrade() else {
                                    break;
                                };
                                if bridge
                                    .send_frame(
                                        &activation_id,
                                        HostMessageFrameKind::Broadcast,
                                        delivery.envelope,
                                        delivery.route_generation,
                                    )
                                    .is_err()
                                {
                                    break;
                                }
                            }
                            Err(error) if error.code == SUBSCRIBER_LAG => {
                                continue;
                            }
                            Err(_) => break,
                        }
                    }
                }));
            }
        }
        Ok(tasks)
    }

    pub async fn open(
        &self,
        registrations: Vec<FrontendBridgeRegistration>,
        channel: Channel<HostMessageFrame>,
    ) -> Result<MessageBridgeOpenReceipt, MessageContractError> {
        let bridge_id = Uuid::new_v4().to_string();
        let bridge = Arc::new(FrontendBridge::new(bridge_id.clone(), channel));
        let (prepared, authorities) =
            self.prepare_frontend_registrations(&bridge, &registrations)?;

        let snapshot = self.bus.register_many(prepared.clone()).await?;
        let subscriptions = self.start_subscriptions(&bridge, &registrations, &authorities)?;
        *bridge
            .registrations
            .lock()
            .expect("message bridge registration lock poisoned") = prepared;
        *bridge
            .authorities
            .lock()
            .expect("message bridge authority lock poisoned") = authorities;
        *bridge
            .registration_inputs
            .lock()
            .expect("message bridge input lock poisoned") = registrations;
        bridge.replace_subscriptions(subscriptions);

        self.bridges.lock().await.insert(bridge_id.clone(), bridge);
        Ok(MessageBridgeOpenReceipt {
            schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
            bridge_id,
            snapshot,
        })
    }

    pub async fn reconcile(
        &self,
        bridge_id: &str,
        expected_route_generation: u64,
        registrations: Vec<FrontendBridgeRegistration>,
    ) -> Result<MessageBridgeOpenReceipt, MessageContractError> {
        let bridge = self.bridge(bridge_id).await?;
        let _transaction = bridge.transaction.lock().await;
        let (prepared, authorities) =
            self.prepare_frontend_registrations(&bridge, &registrations)?;
        let retired_activation_ids = bridge
            .registrations
            .lock()
            .expect("message bridge registration lock poisoned")
            .iter()
            .map(|registration| registration.activation_id().to_string())
            .collect::<Vec<_>>();

        let snapshot = self
            .bus
            .reconcile_many(
                expected_route_generation,
                &retired_activation_ids,
                prepared.clone(),
            )
            .await?;
        let subscriptions = self.start_subscriptions(&bridge, &registrations, &authorities)?;
        *bridge
            .registrations
            .lock()
            .expect("message bridge registration lock poisoned") = prepared;
        *bridge
            .authorities
            .lock()
            .expect("message bridge authority lock poisoned") = authorities;
        *bridge
            .registration_inputs
            .lock()
            .expect("message bridge input lock poisoned") = registrations;
        bridge.replace_subscriptions(subscriptions);
        self.bus.reap_retired().await;

        Ok(MessageBridgeOpenReceipt {
            schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
            bridge_id: bridge_id.to_string(),
            snapshot,
        })
    }

    pub async fn close(
        &self,
        bridge_id: &str,
    ) -> Result<MessageRouteSnapshot, MessageContractError> {
        let Some(bridge) = self.bridges.lock().await.remove(bridge_id) else {
            return Ok(self.bus.snapshot());
        };
        let _transaction = bridge.transaction.lock().await;
        bridge.shutdown();
        let registrations = bridge
            .registrations
            .lock()
            .expect("message bridge registration lock poisoned")
            .clone();
        let activation_ids = registrations
            .iter()
            .map(|registration| registration.activation_id().to_string())
            .collect::<Vec<_>>();
        self.bus.withdraw_many(&activation_ids).await?;
        self.bus.reap_retired().await;
        Ok(self.bus.snapshot())
    }

    async fn bridge(&self, bridge_id: &str) -> Result<Arc<FrontendBridge>, MessageContractError> {
        self.bridges
            .lock()
            .await
            .get(bridge_id)
            .cloned()
            .ok_or_else(|| MessageContractError::new(BRIDGE_CLOSED, "Frontend bridge is closed"))
    }

    pub async fn send(
        &self,
        bridge_id: &str,
        activation_id: &str,
        envelope: MessageEnvelope,
    ) -> Result<DeliveryReceipt, MessageContractError> {
        let bridge = self.bridge(bridge_id).await?;
        let authority = {
            let _transaction = bridge.transaction.lock().await;
            bridge.authority(activation_id)?
        };
        self.bus.send(&authority, envelope).await
    }

    pub async fn publish(
        &self,
        bridge_id: &str,
        activation_id: &str,
        envelope: MessageEnvelope,
    ) -> Result<PublishReceipt, MessageContractError> {
        let bridge = self.bridge(bridge_id).await?;
        let authority = {
            let _transaction = bridge.transaction.lock().await;
            bridge.authority(activation_id)?
        };
        self.bus.publish(&authority, envelope)
    }

    /// Publishes a host-originated module notification using the authority of
    /// the live frontend activation that declared the topic. Callers supply a
    /// module identity, never an activation identity.
    pub async fn publish_for_module(
        &self,
        module_id: &str,
        envelope: MessageEnvelope,
    ) -> Result<PublishReceipt, MessageContractError> {
        let bridges = self
            .bridges
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for bridge in bridges {
            let _transaction = bridge.transaction.lock().await;
            if let Some(authority) = bridge.authority_for_module_publish(module_id, &envelope)? {
                return self.bus.publish(&authority, envelope);
            }
        }
        Err(MessageContractError::new(
            NO_ACTIVE_CHANNEL_OWNER,
            "Module has no active frontend message registration",
        ))
    }

    pub async fn request(
        &self,
        bridge_id: &str,
        activation_id: &str,
        envelope: MessageEnvelope,
    ) -> Result<MessageEnvelope, MessageContractError> {
        let bridge = self.bridge(bridge_id).await?;
        let authority = {
            let _transaction = bridge.transaction.lock().await;
            bridge.authority(activation_id)?
        };
        self.bus.request(&authority, envelope).await
    }

    pub async fn reply(
        &self,
        bridge_id: &str,
        reply: MessageBridgeReply,
    ) -> Result<(), MessageContractError> {
        let bridge = self.bridge(bridge_id).await?;
        bridge.complete_reply(reply)
    }

    pub async fn report_failure(
        &self,
        bridge_id: &str,
        activation_id: &str,
        endpoint: &str,
        code: &str,
    ) -> Result<(), MessageContractError> {
        let code = match code {
            HANDLER_FAILED => HANDLER_FAILED,
            HANDLER_UNAVAILABLE => HANDLER_UNAVAILABLE,
            _ => {
                return Err(MessageContractError::new(
                    INVALID_IDENTIFIER,
                    "Frontend message failures require a stable handler code",
                ))
            }
        };
        let bridge = self.bridge(bridge_id).await?;
        let _transaction = bridge.transaction.lock().await;
        let message = bridge.delivery_message(activation_id, endpoint)?;
        self.bus.record_frontend_failure(endpoint, &message, code);
        Ok(())
    }

    pub async fn inspect(&self) -> MessageBridgeInspection {
        self.bus.reap_retired().await;
        let bridges = self
            .bridges
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut registrations = bridges
            .iter()
            .flat_map(|bridge| {
                bridge
                    .registration_inputs
                    .lock()
                    .expect("message bridge input lock poisoned")
                    .iter()
                    .map(MessageBridgeRegistrationObservation::from)
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        registrations.sort_by(|left, right| left.activation_id.cmp(&right.activation_id));
        MessageBridgeInspection {
            schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
            bridge_count: bridges.len() as u64,
            snapshot: self.bus.snapshot(),
            endpoints: self.bus.inspect_endpoints().await,
            activations: self.bus.inspect_activations().await,
            registrations,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use serde_json::json;
    use tauri::ipc::InvokeResponseBody;

    use shipctl_core::instance::{
        InstanceBuildIdentity, InstanceContext, LaunchProvenance, RootSource,
    };
    use shipctl_core::message_bus::{
        BroadcastTopicDeclaration, CapabilityPortDeclaration, DirectedChannelDeclaration,
        MessageDeclarations, MessageSchemaDescriptor, MessageTypeContract, RouteEndpointRef,
    };
    use shipctl_core::module_control::ModuleGrant;

    use super::*;

    const CHANNEL: &str = "fixture.directed";
    const BACKEND_CHANNEL: &str = "fixture.backend";
    const TOPIC: &str = "fixture.events";
    const PORT: &str = "fixture.lookup";
    const MESSAGE: &str = "fixture.value";
    const RESPONSE: &str = "fixture.response";

    fn context() -> InstanceContext {
        InstanceContext {
            instance_id: Uuid::new_v4(),
            name: "bridge-test".to_string(),
            state_root: PathBuf::from("/not-used/state"),
            runtime_root: PathBuf::from("/not-used/runtime"),
            state_root_source: RootSource::Explicit,
            runtime_root_source: RootSource::Explicit,
            build: InstanceBuildIdentity {
                app_version: "test".to_string(),
                control_protocol_version: 1,
            },
            launch_provenance: LaunchProvenance::DirectUi,
        }
    }

    fn message(id: &str) -> MessageTypeId {
        MessageTypeId {
            id: id.to_string(),
            version: 1,
        }
    }

    fn contract(id: &str) -> MessageTypeContract {
        let path = format!("schemas/{}.json", id.replace('.', "-"));
        MessageTypeContract {
            message: message(id),
            schema: MessageSchemaDescriptor {
                draft: "https://json-schema.org/draft/2020-12/schema".to_string(),
                root: path.clone(),
                resources: BTreeMap::from([(
                    path.clone(),
                    json!({
                        "$schema": "https://json-schema.org/draft/2020-12/schema",
                        "$id": format!("shipctl-artifact:///{path}"),
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["value"],
                        "properties": {"value": {"type": "integer"}}
                    }),
                )]),
                max_encoded_bytes: 64,
                redacted_fields: Vec::new(),
                compatible_versions: vec![1],
            },
        }
    }

    fn declarations() -> MessageDeclarations {
        MessageDeclarations {
            schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
            provides: vec![contract(MESSAGE), contract(RESPONSE)],
            handles: vec![DirectedChannelDeclaration {
                endpoint: RouteEndpointRef {
                    id: CHANNEL.to_string(),
                    message: message(MESSAGE),
                },
                capacity: 2,
                required_grant: format!("message.send.{CHANNEL}"),
                scheduler_allowed: true,
            }],
            publishes: vec![BroadcastTopicDeclaration {
                endpoint: RouteEndpointRef {
                    id: TOPIC.to_string(),
                    message: message(MESSAGE),
                },
                capacity: 2,
                required_grant: format!("message.publish.{TOPIC}"),
                scheduler_allowed: true,
            }],
            subscribes: vec![RouteEndpointRef {
                id: TOPIC.to_string(),
                message: message(MESSAGE),
            }],
            ports: vec![CapabilityPortDeclaration {
                id: PORT.to_string(),
                request: message(MESSAGE),
                response: message(RESPONSE),
                capacity: 1,
                required_grant: format!("message.request.{PORT}"),
                scheduler_allowed: false,
            }],
        }
    }

    fn envelope(endpoint: &str, message_id: &str, value: u64) -> MessageEnvelope {
        MessageEnvelope {
            schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
            endpoint: endpoint.to_string(),
            message: message(message_id),
            payload: json!({"value": value}),
            correlation_id: None,
        }
    }

    fn registration_for(activation_id: &str) -> FrontendBridgeRegistration {
        FrontendBridgeRegistration {
            module_id: "fixture".to_string(),
            activation_id: activation_id.to_string(),
            grants: [
                format!("message.send.{CHANNEL}"),
                format!("message.publish.{TOPIC}"),
                format!("message.subscribe.{TOPIC}"),
                format!("message.request.{PORT}"),
            ]
            .into_iter()
            .map(|id| ModuleGrant {
                id,
                effective: true,
            })
            .collect(),
            declarations: declarations(),
        }
    }

    fn registration() -> FrontendBridgeRegistration {
        registration_for("fixture@digest#activation")
    }

    fn test_channel(frames: Arc<Mutex<Vec<HostMessageFrame>>>) -> Channel<HostMessageFrame> {
        Channel::new(move |body| {
            let InvokeResponseBody::Json(source) = body else {
                panic!("message bridge frame must be JSON")
            };
            frames
                .lock()
                .unwrap()
                .push(serde_json::from_str(&source).unwrap());
            Ok(())
        })
    }

    async fn wait_until(mut predicate: impl FnMut() -> bool) {
        while !predicate() {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ordered_bridge_delivers_directed_broadcast_and_port_frames() {
        let bus = RuntimeMessageBus::new(context());
        let service = MessageBusBridgeService::new(bus);
        let frames = Arc::new(Mutex::new(Vec::new()));
        let registration = registration();
        let activation_id = registration.activation_id.clone();
        let receipt = service
            .open(vec![registration], test_channel(Arc::clone(&frames)))
            .await
            .unwrap();

        service
            .send(
                &receipt.bridge_id,
                &activation_id,
                envelope(CHANNEL, MESSAGE, 1),
            )
            .await
            .unwrap();
        service
            .publish(
                &receipt.bridge_id,
                &activation_id,
                envelope(TOPIC, MESSAGE, 2),
            )
            .await
            .unwrap();
        wait_until(|| frames.lock().unwrap().len() == 2).await;

        let request = tokio::spawn({
            let service = service.clone();
            let bridge_id = receipt.bridge_id.clone();
            let activation_id = activation_id.clone();
            async move {
                service
                    .request(&bridge_id, &activation_id, envelope(PORT, MESSAGE, 3))
                    .await
            }
        });
        wait_until(|| frames.lock().unwrap().len() == 3).await;
        let port_frame = frames
            .lock()
            .unwrap()
            .iter()
            .find(|frame| frame.kind == HostMessageFrameKind::PortRequest)
            .unwrap()
            .clone();
        service
            .reply(
                &receipt.bridge_id,
                MessageBridgeReply {
                    correlation_id: port_frame.correlation_id.unwrap(),
                    response: Some(envelope(PORT, RESPONSE, 4)),
                    error: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(request.await.unwrap().unwrap().payload["value"], 4);

        {
            let frames = frames.lock().unwrap();
            assert_eq!(
                frames
                    .iter()
                    .map(|frame| frame.sequence)
                    .collect::<Vec<_>>(),
                vec![1, 2, 3]
            );
            assert!(frames
                .iter()
                .all(|frame| frame.activation_id == activation_id));
        }
        service.close(&receipt.bridge_id).await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn host_module_publish_uses_only_the_live_declared_module_authority() {
        let bus = RuntimeMessageBus::new(context());
        let service = MessageBusBridgeService::new(bus);
        let frames = Arc::new(Mutex::new(Vec::new()));
        let registration = registration();
        let activation_id = registration.activation_id.clone();
        let receipt = service
            .open(vec![registration], test_channel(Arc::clone(&frames)))
            .await
            .unwrap();

        let published = service
            .publish_for_module("fixture", envelope(TOPIC, MESSAGE, 1))
            .await
            .unwrap();
        assert_eq!(published.subscriber_count, 1);
        wait_until(|| frames.lock().unwrap().len() == 1).await;
        let frame = frames.lock().unwrap()[0].clone();
        assert_eq!(frame.kind, HostMessageFrameKind::Broadcast);
        assert_eq!(frame.activation_id, activation_id);

        assert_eq!(
            service
                .publish_for_module("foreign", envelope(TOPIC, MESSAGE, 2))
                .await
                .unwrap_err()
                .code,
            NO_ACTIVE_CHANNEL_OWNER
        );
        service.close(&receipt.bridge_id).await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reported_frontend_failure_is_bound_to_the_registered_subscription() {
        let bus = RuntimeMessageBus::new(context());
        let service = MessageBusBridgeService::new(bus);
        let registration = registration();
        let activation_id = registration.activation_id.clone();
        let receipt = service
            .open(
                vec![registration],
                test_channel(Arc::new(Mutex::new(Vec::new()))),
            )
            .await
            .unwrap();

        service
            .report_failure(&receipt.bridge_id, &activation_id, TOPIC, HANDLER_FAILED)
            .await
            .unwrap();
        let endpoint = service
            .inspect()
            .await
            .endpoints
            .into_iter()
            .find(|endpoint| endpoint.endpoint == TOPIC)
            .unwrap();
        assert_eq!(endpoint.failed, 1);
        assert_eq!(endpoint.last_failure.unwrap().code, HANDLER_FAILED);
        assert_eq!(
            service
                .report_failure(
                    &receipt.bridge_id,
                    &activation_id,
                    "fixture.unknown",
                    HANDLER_FAILED,
                )
                .await
                .unwrap_err()
                .code,
            INVALID_IDENTIFIER
        );
        service.close(&receipt.bridge_id).await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bridge_authority_close_and_reopen_are_activation_scoped() {
        let bus = RuntimeMessageBus::new(context());
        let backend = Arc::new(
            PreparedRegistration::prepare(
                bus.context(),
                "backend@core#activation",
                &[],
                MessageDeclarations {
                    handles: vec![DirectedChannelDeclaration {
                        endpoint: RouteEndpointRef {
                            id: BACKEND_CHANNEL.to_string(),
                            message: message(MESSAGE),
                        },
                        capacity: 1,
                        required_grant: format!("message.send.{BACKEND_CHANNEL}"),
                        scheduler_allowed: false,
                    }],
                    publishes: Vec::new(),
                    subscribes: Vec::new(),
                    ports: Vec::new(),
                    ..declarations()
                },
                RegistrationHandlers::new().with_directed(BACKEND_CHANNEL, |_| async { Ok(()) }),
            )
            .unwrap(),
        );
        bus.register(Arc::clone(&backend)).await.unwrap();
        let service = MessageBusBridgeService::new(bus.clone());
        let frames = Arc::new(Mutex::new(Vec::new()));
        let first = service
            .open(vec![registration()], test_channel(Arc::clone(&frames)))
            .await
            .unwrap();
        assert_eq!(
            service
                .send(
                    &first.bridge_id,
                    "foreign@digest#activation",
                    envelope(CHANNEL, MESSAGE, 1),
                )
                .await
                .unwrap_err()
                .code,
            UNAUTHORIZED_SENDER
        );
        let closed = service.close(&first.bridge_id).await.unwrap();
        assert_eq!(closed.channels.len(), 1);
        assert!(closed
            .channels
            .iter()
            .all(|route| route.owner_activation_id == backend.activation_id()));
        assert_eq!(service.close(&first.bridge_id).await.unwrap(), closed);

        let reopened = service
            .open(vec![registration()], test_channel(frames))
            .await
            .unwrap();
        assert!(reopened
            .snapshot
            .channels
            .iter()
            .any(|route| route.owner_activation_id == backend.activation_id()));
        service.close(&reopened.bridge_id).await.unwrap();
        let backend = bus.withdraw(backend.activation_id()).await.unwrap();
        backend.dispose().await;
    }
}
