use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio::task::JoinHandle;

use crate::instance::InstanceContext;
use crate::module_control::ModuleGrant;

use super::contracts::{
    AcceptedMessageDeclarations, BroadcastTopicDeclaration, CapabilityPortDeclaration,
    DirectedChannelDeclaration, MessageContractError, MessageDeclarations, MessageEnvelope,
    ModuleMessageAuthority,
};
use super::diagnostics::{HANDLER_FAILED, HANDLER_UNAVAILABLE, INVALID_IDENTIFIER};

pub type RuntimeHandlerFuture =
    Pin<Box<dyn Future<Output = Result<(), MessageContractError>> + Send + 'static>>;
pub type RuntimePortFuture =
    Pin<Box<dyn Future<Output = Result<MessageEnvelope, MessageContractError>> + Send + 'static>>;
pub type DirectedHandler =
    Arc<dyn Fn(MessageEnvelope, u64) -> RuntimeHandlerFuture + Send + Sync + 'static>;
pub type PortHandler =
    Arc<dyn Fn(MessageEnvelope, u64) -> RuntimePortFuture + Send + Sync + 'static>;

pub(crate) type DeliveryRecorder =
    Arc<dyn Fn(&str, &MessageEnvelope, u64, Option<&'static str>) + Send + Sync + 'static>;

#[derive(Default)]
pub struct RegistrationHandlers {
    directed: BTreeMap<String, DirectedHandler>,
    ports: BTreeMap<String, PortHandler>,
}

impl RegistrationHandlers {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_directed<F, Fut>(mut self, endpoint: impl Into<String>, handler: F) -> Self
    where
        F: Fn(MessageEnvelope) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), MessageContractError>> + Send + 'static,
    {
        self.directed.insert(
            endpoint.into(),
            Arc::new(move |envelope, _| Box::pin(handler(envelope))),
        );
        self
    }

    pub fn with_directed_delivery<F, Fut>(mut self, endpoint: impl Into<String>, handler: F) -> Self
    where
        F: Fn(MessageEnvelope, u64) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), MessageContractError>> + Send + 'static,
    {
        self.directed.insert(
            endpoint.into(),
            Arc::new(move |envelope, generation| Box::pin(handler(envelope, generation))),
        );
        self
    }

    pub fn with_port<F, Fut>(mut self, endpoint: impl Into<String>, handler: F) -> Self
    where
        F: Fn(MessageEnvelope) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<MessageEnvelope, MessageContractError>> + Send + 'static,
    {
        self.ports.insert(
            endpoint.into(),
            Arc::new(move |envelope, _| Box::pin(handler(envelope))),
        );
        self
    }

    pub fn with_port_delivery<F, Fut>(mut self, endpoint: impl Into<String>, handler: F) -> Self
    where
        F: Fn(MessageEnvelope, u64) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<MessageEnvelope, MessageContractError>> + Send + 'static,
    {
        self.ports.insert(
            endpoint.into(),
            Arc::new(move |envelope, generation| Box::pin(handler(envelope, generation))),
        );
        self
    }
}

pub(crate) struct PortRequest {
    pub envelope: MessageEnvelope,
    pub route_generation: u64,
    pub reply: oneshot::Sender<Result<MessageEnvelope, MessageContractError>>,
}

#[derive(Clone)]
pub(crate) struct DirectedDelivery {
    pub envelope: MessageEnvelope,
    pub route_generation: u64,
}

#[derive(Clone)]
pub(crate) struct BroadcastDelivery {
    pub envelope: MessageEnvelope,
    pub route_generation: u64,
}

pub(crate) struct PreparedDirected {
    pub declaration: DirectedChannelDeclaration,
    pub sender: mpsc::Sender<DirectedDelivery>,
    receiver: Mutex<Option<mpsc::Receiver<DirectedDelivery>>>,
    handler: DirectedHandler,
}

pub(crate) struct PreparedTopic {
    pub declaration: BroadcastTopicDeclaration,
    pub sender: broadcast::Sender<BroadcastDelivery>,
}

pub(crate) struct PreparedPort {
    pub declaration: CapabilityPortDeclaration,
    pub sender: mpsc::Sender<PortRequest>,
    receiver: Mutex<Option<mpsc::Receiver<PortRequest>>>,
    handler: PortHandler,
}

struct ActivationRuntimeState {
    withdrawn: AtomicBool,
    cancelled: AtomicBool,
    in_flight: AtomicU64,
    reply_handles: AtomicU64,
}

impl ActivationRuntimeState {
    fn new() -> Self {
        Self {
            withdrawn: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            in_flight: AtomicU64::new(0),
            reply_handles: AtomicU64::new(0),
        }
    }
}

struct ActivationLease(Arc<ActivationRuntimeState>);

impl ActivationLease {
    fn acquire(state: Arc<ActivationRuntimeState>) -> Self {
        state.in_flight.fetch_add(1, Ordering::SeqCst);
        Self(state)
    }
}

impl Drop for ActivationLease {
    fn drop(&mut self) {
        self.0.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

pub struct PreparedRegistration {
    instance_incarnation: String,
    activation_id: String,
    authority: ModuleMessageAuthority,
    declarations: Arc<AcceptedMessageDeclarations>,
    pub(crate) directed: BTreeMap<String, Arc<PreparedDirected>>,
    pub(crate) topics: BTreeMap<String, Arc<PreparedTopic>>,
    pub(crate) ports: BTreeMap<String, Arc<PreparedPort>>,
    state: Arc<ActivationRuntimeState>,
    cancellation: watch::Sender<bool>,
    started: AtomicBool,
    workers: Mutex<Vec<JoinHandle<()>>>,
}

impl std::fmt::Debug for PreparedRegistration {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreparedRegistration")
            .field("instance_incarnation", &self.instance_incarnation)
            .field("activation_id", &self.activation_id)
            .field("declarations", &self.declarations.declarations())
            .finish_non_exhaustive()
    }
}

impl PreparedRegistration {
    pub fn prepare(
        context: &InstanceContext,
        activation_id: impl Into<String>,
        grants: &[ModuleGrant],
        declarations: MessageDeclarations,
        mut handlers: RegistrationHandlers,
    ) -> Result<Self, MessageContractError> {
        let activation_id = activation_id.into();
        if activation_id.trim().is_empty() {
            return Err(MessageContractError::new(
                INVALID_IDENTIFIER,
                "Registration activation identity cannot be empty",
            ));
        }

        let declarations = Arc::new(declarations.prepare()?);
        let mut directed = BTreeMap::new();
        for declaration in &declarations.declarations().handles {
            let handler = handlers
                .directed
                .remove(&declaration.endpoint.id)
                .ok_or_else(|| {
                    MessageContractError::new(
                        HANDLER_UNAVAILABLE,
                        format!("No handler was prepared for {:?}", declaration.endpoint.id),
                    )
                })?;
            let (sender, receiver) = mpsc::channel(declaration.capacity as usize);
            directed.insert(
                declaration.endpoint.id.clone(),
                Arc::new(PreparedDirected {
                    declaration: declaration.clone(),
                    sender,
                    receiver: Mutex::new(Some(receiver)),
                    handler,
                }),
            );
        }

        let mut topics = BTreeMap::new();
        for declaration in &declarations.declarations().publishes {
            let (sender, receiver) = broadcast::channel(declaration.capacity as usize);
            drop(receiver);
            topics.insert(
                declaration.endpoint.id.clone(),
                Arc::new(PreparedTopic {
                    declaration: declaration.clone(),
                    sender,
                }),
            );
        }

        let mut ports = BTreeMap::new();
        for declaration in &declarations.declarations().ports {
            let handler = handlers.ports.remove(&declaration.id).ok_or_else(|| {
                MessageContractError::new(
                    HANDLER_UNAVAILABLE,
                    format!(
                        "No capability-port handler was prepared for {:?}",
                        declaration.id
                    ),
                )
            })?;
            let (sender, receiver) = mpsc::channel(declaration.capacity as usize);
            ports.insert(
                declaration.id.clone(),
                Arc::new(PreparedPort {
                    declaration: declaration.clone(),
                    sender,
                    receiver: Mutex::new(Some(receiver)),
                    handler,
                }),
            );
        }

        if !handlers.directed.is_empty() || !handlers.ports.is_empty() {
            return Err(MessageContractError::new(
                HANDLER_UNAVAILABLE,
                "Prepared handlers must match declared endpoints exactly",
            ));
        }

        let (cancellation, _) = watch::channel(false);
        Ok(Self {
            instance_incarnation: context.instance_id.to_string(),
            authority: ModuleMessageAuthority::from_host(activation_id.clone(), grants),
            activation_id,
            declarations,
            directed,
            topics,
            ports,
            state: Arc::new(ActivationRuntimeState::new()),
            cancellation,
            started: AtomicBool::new(false),
            workers: Mutex::new(Vec::new()),
        })
    }

    pub fn activation_id(&self) -> &str {
        &self.activation_id
    }

    pub fn authority(&self) -> &ModuleMessageAuthority {
        &self.authority
    }

    pub fn declarations(&self) -> &AcceptedMessageDeclarations {
        &self.declarations
    }

    pub fn instance_incarnation(&self) -> &str {
        &self.instance_incarnation
    }

    pub fn is_withdrawn(&self) -> bool {
        self.state.withdrawn.load(Ordering::SeqCst)
    }

    pub fn is_cancelled(&self) -> bool {
        self.state.cancelled.load(Ordering::SeqCst)
    }

    pub fn in_flight(&self) -> u64 {
        self.state.in_flight.load(Ordering::SeqCst)
    }

    pub fn reply_handles(&self) -> u64 {
        self.state.reply_handles.load(Ordering::SeqCst)
    }

    pub(crate) fn start(&self, recorder: DeliveryRecorder) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }

        let mut workers = self.workers.lock().expect("message worker lock poisoned");
        for route in self.directed.values() {
            let Some(mut receiver) = route
                .receiver
                .lock()
                .expect("directed receiver lock poisoned")
                .take()
            else {
                continue;
            };
            let endpoint = route.declaration.endpoint.id.clone();
            let handler = Arc::clone(&route.handler);
            let state = Arc::clone(&self.state);
            let mut cancellation = self.cancellation.subscribe();
            let recorder = Arc::clone(&recorder);
            workers.push(tokio::spawn(async move {
                loop {
                    let delivery = tokio::select! {
                        changed = cancellation.changed() => {
                            if changed.is_err() || *cancellation.borrow() {
                                break;
                            }
                            continue;
                        }
                        envelope = receiver.recv() => match envelope {
                            Some(delivery) => delivery,
                            None => break,
                        },
                    };
                    let DirectedDelivery {
                        envelope,
                        route_generation,
                    } = delivery;
                    let _lease = ActivationLease::acquire(Arc::clone(&state));
                    let failure = handler(envelope.clone(), route_generation)
                        .await
                        .err()
                        .map(|_| HANDLER_FAILED);
                    recorder(&endpoint, &envelope, route_generation, failure);
                }
            }));
        }

        for route in self.ports.values() {
            let Some(mut receiver) = route
                .receiver
                .lock()
                .expect("port receiver lock poisoned")
                .take()
            else {
                continue;
            };
            let endpoint = route.declaration.id.clone();
            let handler = Arc::clone(&route.handler);
            let state = Arc::clone(&self.state);
            let mut cancellation = self.cancellation.subscribe();
            let recorder = Arc::clone(&recorder);
            workers.push(tokio::spawn(async move {
                loop {
                    let request = tokio::select! {
                        changed = cancellation.changed() => {
                            if changed.is_err() || *cancellation.borrow() {
                                break;
                            }
                            continue;
                        }
                        request = receiver.recv() => match request {
                            Some(request) => request,
                            None => break,
                        },
                    };
                    let _lease = ActivationLease::acquire(Arc::clone(&state));
                    state.reply_handles.fetch_add(1, Ordering::SeqCst);
                    let PortRequest {
                        envelope,
                        route_generation,
                        mut reply,
                    } = request;
                    let result = tokio::select! {
                        result = handler(envelope.clone(), route_generation) => Some(result),
                        _ = reply.closed() => None,
                    };
                    state.reply_handles.fetch_sub(1, Ordering::SeqCst);
                    if let Some(result) = result {
                        let failure = result.as_ref().err().map(|_| HANDLER_FAILED);
                        recorder(&endpoint, &envelope, route_generation, failure);
                        let _ = reply.send(result);
                    }
                }
            }));
        }
    }

    pub(crate) fn withdraw_and_cancel(&self) {
        self.state.withdrawn.store(true, Ordering::SeqCst);
        if !self.state.cancelled.swap(true, Ordering::SeqCst) {
            self.cancellation.send_replace(true);
        }
    }

    pub async fn dispose(&self) {
        self.withdraw_and_cancel();
        let workers = {
            let mut workers = self.workers.lock().expect("message worker lock poisoned");
            std::mem::take(&mut *workers)
        };
        for worker in workers {
            let _ = worker.await;
        }
    }
}
