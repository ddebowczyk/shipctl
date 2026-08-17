use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, oneshot, watch, Mutex as AsyncMutex};

use crate::instance::InstanceContext;

use super::contracts::{
    BroadcastRoute, CapabilityRoute, DeliveryReceipt, DirectedRoute, MessageContractError,
    MessageEnvelope, MessageObservation, MessageRouteSnapshot, MessageTypeId,
    ModuleMessageAuthority, PublishReceipt, RedactedMessageContext,
    MESSAGE_CONTRACT_SCHEMA_VERSION,
};
use super::diagnostics::{
    DUPLICATE_CHANNEL_OWNER, HANDLER_FAILED, HANDLER_UNAVAILABLE, INCOMPATIBLE_MESSAGE_VERSION,
    NO_ACTIVE_CHANNEL_OWNER, ROUTE_GENERATION_CHANGED, SCHEDULER_SECRET_PAYLOAD_FORBIDDEN,
    SUBSCRIBER_LAG, UNAUTHORIZED_SENDER, UNKNOWN_MESSAGE_CONTRACT,
};
use super::routes::{
    BroadcastDelivery, DeliveryRecorder, DirectedDelivery, PortRequest, PreparedDirected,
    PreparedPort, PreparedRegistration, PreparedTopic,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EndpointRuntimeObservation {
    pub endpoint: String,
    pub accepted: u64,
    pub delivered: u64,
    pub failed: u64,
    pub lagged: u64,
    pub queued: u64,
    pub capacity: u64,
    pub last_failure: Option<MessageObservation>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivationRuntimeObservation {
    pub activation_id: String,
    pub withdrawn: bool,
    pub cancelled: bool,
    pub in_flight: u64,
    pub reply_handles: u64,
}

#[derive(Default)]
struct EndpointCounters {
    accepted: u64,
    delivered: u64,
    failed: u64,
    lagged: u64,
    last_failure: Option<MessageObservation>,
}

#[derive(Default)]
struct ObservationStore {
    endpoints: Mutex<BTreeMap<String, EndpointCounters>>,
}

impl ObservationStore {
    fn accepted(&self, endpoint: &str) {
        self.endpoints
            .lock()
            .expect("message observation lock poisoned")
            .entry(endpoint.to_string())
            .or_default()
            .accepted += 1;
    }

    fn delivered(
        &self,
        endpoint: &str,
        envelope: &MessageEnvelope,
        route_generation: u64,
        failure: Option<&'static str>,
    ) {
        let mut endpoints = self
            .endpoints
            .lock()
            .expect("message observation lock poisoned");
        let counters = endpoints.entry(endpoint.to_string()).or_default();
        counters.delivered += 1;
        if let Some(code) = failure {
            counters.failed += 1;
            counters.last_failure = Some(observation(code, envelope, route_generation));
        }
    }

    fn rejected(&self, error: &MessageContractError, envelope: &MessageEnvelope, generation: u64) {
        let mut endpoints = self
            .endpoints
            .lock()
            .expect("message observation lock poisoned");
        let counters = endpoints.entry(envelope.endpoint.clone()).or_default();
        counters.failed += 1;
        counters.last_failure = Some(observation(
            stable_public_code(&error.code),
            envelope,
            generation,
        ));
    }

    fn lagged(&self, endpoint: &str, message: &MessageTypeId, generation: u64) {
        let mut endpoints = self
            .endpoints
            .lock()
            .expect("message observation lock poisoned");
        let counters = endpoints.entry(endpoint.to_string()).or_default();
        counters.lagged += 1;
        counters.failed += 1;
        counters.last_failure = Some(MessageObservation {
            schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
            code: SUBSCRIBER_LAG.to_string(),
            endpoint: Some(endpoint.to_string()),
            message: Some(message.clone()),
            route_generation: generation,
            context: RedactedMessageContext::default(),
        });
    }

    fn frontend_failed(
        &self,
        endpoint: &str,
        message: &MessageTypeId,
        generation: u64,
        code: &'static str,
    ) {
        let mut endpoints = self
            .endpoints
            .lock()
            .expect("message observation lock poisoned");
        let counters = endpoints.entry(endpoint.to_string()).or_default();
        counters.failed += 1;
        counters.last_failure = Some(MessageObservation {
            schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
            code: code.to_string(),
            endpoint: Some(endpoint.to_string()),
            message: Some(message.clone()),
            route_generation: generation,
            context: RedactedMessageContext::default(),
        });
    }
}

fn stable_public_code(code: &str) -> &'static str {
    super::diagnostics::PUBLIC_CODES
        .iter()
        .copied()
        .find(|candidate| *candidate == code)
        .unwrap_or(HANDLER_FAILED)
}

fn observation(
    code: &'static str,
    envelope: &MessageEnvelope,
    route_generation: u64,
) -> MessageObservation {
    MessageObservation {
        schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
        code: code.to_string(),
        endpoint: Some(envelope.endpoint.clone()),
        message: Some(envelope.message.clone()),
        route_generation,
        context: RedactedMessageContext::default(),
    }
}

struct DirectedRouteEntry {
    registration: Arc<PreparedRegistration>,
    route: Arc<PreparedDirected>,
}

struct TopicRouteEntry {
    registration: Arc<PreparedRegistration>,
    route: Arc<PreparedTopic>,
}

struct PortRouteEntry {
    registration: Arc<PreparedRegistration>,
    route: Arc<PreparedPort>,
}

struct RouteTable {
    public: MessageRouteSnapshot,
    channels: BTreeMap<String, DirectedRouteEntry>,
    topics: BTreeMap<String, TopicRouteEntry>,
    ports: BTreeMap<String, PortRouteEntry>,
}

impl RouteTable {
    fn empty(context: &InstanceContext) -> Self {
        Self {
            public: MessageRouteSnapshot {
                schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
                instance_id: context.name.clone(),
                incarnation: context.instance_id.to_string(),
                route_generation: 0,
                channels: Vec::new(),
                topics: Vec::new(),
                ports: Vec::new(),
            },
            channels: BTreeMap::new(),
            topics: BTreeMap::new(),
            ports: BTreeMap::new(),
        }
    }

    fn build(
        context: &InstanceContext,
        generation: u64,
        registrations: &BTreeMap<String, Arc<PreparedRegistration>>,
    ) -> Result<Self, MessageContractError> {
        let incarnation = context.instance_id.to_string();
        let mut channels = BTreeMap::new();
        let mut topics = BTreeMap::new();
        let mut ports = BTreeMap::new();
        let mut endpoint_ids = BTreeSet::new();

        for registration in registrations.values() {
            if registration.instance_incarnation() != incarnation {
                return Err(MessageContractError::new(
                    NO_ACTIVE_CHANNEL_OWNER,
                    "Prepared registrations cannot cross instance incarnations",
                ));
            }
            for (id, route) in &registration.directed {
                if !endpoint_ids.insert(id.clone()) {
                    return Err(MessageContractError::new(
                        DUPLICATE_CHANNEL_OWNER,
                        format!("Endpoint {id:?} has more than one active owner"),
                    ));
                }
                channels.insert(
                    id.clone(),
                    DirectedRouteEntry {
                        registration: Arc::clone(registration),
                        route: Arc::clone(route),
                    },
                );
            }
            for (id, route) in &registration.topics {
                if !endpoint_ids.insert(id.clone()) {
                    return Err(MessageContractError::new(
                        DUPLICATE_CHANNEL_OWNER,
                        format!("Endpoint {id:?} has more than one active owner"),
                    ));
                }
                topics.insert(
                    id.clone(),
                    TopicRouteEntry {
                        registration: Arc::clone(registration),
                        route: Arc::clone(route),
                    },
                );
            }
            for (id, route) in &registration.ports {
                if !endpoint_ids.insert(id.clone()) {
                    return Err(MessageContractError::new(
                        DUPLICATE_CHANNEL_OWNER,
                        format!("Endpoint {id:?} has more than one active owner"),
                    ));
                }
                ports.insert(
                    id.clone(),
                    PortRouteEntry {
                        registration: Arc::clone(registration),
                        route: Arc::clone(route),
                    },
                );
            }
        }

        for registration in registrations.values() {
            for subscription in &registration.declarations().declarations().subscribes {
                let Some(topic) = topics.get(&subscription.id) else {
                    return Err(MessageContractError::new(
                        NO_ACTIVE_CHANNEL_OWNER,
                        format!(
                            "Subscribed topic {:?} has no active publisher",
                            subscription.id
                        ),
                    ));
                };
                if topic.route.declaration.endpoint.message.id != subscription.message.id
                    || !topic
                        .registration
                        .declarations()
                        .contract(&topic.route.declaration.endpoint.message)
                        .expect("published topic contract was prepared")
                        .contract()
                        .schema
                        .compatible_versions
                        .contains(&subscription.message.version)
                {
                    return Err(MessageContractError::new(
                        INCOMPATIBLE_MESSAGE_VERSION,
                        format!("Subscription {:?} is incompatible", subscription.id),
                    ));
                }
            }
        }

        let public = MessageRouteSnapshot {
            schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
            instance_id: context.name.clone(),
            incarnation,
            route_generation: generation,
            channels: channels
                .values()
                .map(|entry| DirectedRoute {
                    endpoint: entry.route.declaration.endpoint.clone(),
                    owner_activation_id: entry.registration.activation_id().to_string(),
                    capacity: entry.route.declaration.capacity,
                    scheduler_allowed: entry.route.declaration.scheduler_allowed,
                })
                .collect(),
            topics: topics
                .values()
                .map(|entry| BroadcastRoute {
                    endpoint: entry.route.declaration.endpoint.clone(),
                    subscriber_count: registrations
                        .values()
                        .flat_map(|registration| {
                            &registration.declarations().declarations().subscribes
                        })
                        .filter(|subscription| {
                            subscription.id == entry.route.declaration.endpoint.id
                        })
                        .count() as u32,
                    capacity: entry.route.declaration.capacity,
                    scheduler_allowed: entry.route.declaration.scheduler_allowed,
                })
                .collect(),
            ports: ports
                .values()
                .map(|entry| CapabilityRoute {
                    id: entry.route.declaration.id.clone(),
                    request: entry.route.declaration.request.clone(),
                    response: entry.route.declaration.response.clone(),
                    owner_activation_id: entry.registration.activation_id().to_string(),
                    capacity: entry.route.declaration.capacity,
                    scheduler_allowed: entry.route.declaration.scheduler_allowed,
                })
                .collect(),
        };
        Ok(Self {
            public,
            channels,
            topics,
            ports,
        })
    }
}

struct UpdateState {
    registrations: BTreeMap<String, Arc<PreparedRegistration>>,
    retired: Vec<Arc<PreparedRegistration>>,
}

struct RuntimeMessageBusInner {
    context: InstanceContext,
    routes: watch::Sender<Arc<RouteTable>>,
    public_routes: watch::Sender<Arc<MessageRouteSnapshot>>,
    updates: AsyncMutex<UpdateState>,
    observations: Arc<ObservationStore>,
}

#[derive(Clone)]
pub struct RuntimeMessageBus {
    inner: Arc<RuntimeMessageBusInner>,
}

/// The only route kinds the core scheduler may target.
///
/// Capability ports deliberately remain excluded: scheduler preflight proves
/// one-way channel/topic delivery only and never creates an authority grant.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SchedulerPreflightTargetKind {
    Channel,
    Topic,
}

/// A candidate scheduler delivery to validate against the live route table.
#[derive(Clone, Debug, PartialEq)]
pub struct SchedulerPreflightRequest {
    pub target_kind: SchedulerPreflightTargetKind,
    pub envelope: MessageEnvelope,
}

/// Immutable identity of the route table that accepted a scheduler candidate.
///
/// The values are private so callers can retain and compare the preflight
/// binding but cannot fabricate or alter it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SchedulerPreflightSnapshot {
    instance_id: String,
    incarnation: String,
    route_generation: u64,
}

impl SchedulerPreflightSnapshot {
    fn from_routes(routes: &MessageRouteSnapshot) -> Self {
        Self {
            instance_id: routes.instance_id.clone(),
            incarnation: routes.incarnation.clone(),
            route_generation: routes.route_generation,
        }
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn incarnation(&self) -> &str {
        &self.incarnation
    }

    pub fn route_generation(&self) -> u64 {
        self.route_generation
    }
}

/// A redacted, source-addressable failure from a scheduler preflight batch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SchedulerPreflightError {
    request_index: usize,
    error: MessageContractError,
}

impl SchedulerPreflightError {
    fn new(request_index: usize, error: MessageContractError) -> Self {
        Self {
            request_index,
            error: MessageContractError {
                code: error.code,
                message: "Scheduled target failed message-bus preflight".to_string(),
            },
        }
    }

    /// Index into the input request slice. The scheduler owns that mapping to
    /// a source file and can therefore emit source-located diagnostics without
    /// parsing error text.
    pub fn request_index(&self) -> usize {
        self.request_index
    }

    /// The code-preserving, payload-free public message-bus error.
    pub fn error(&self) -> &MessageContractError {
        &self.error
    }
}

impl std::fmt::Display for SchedulerPreflightError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Scheduler preflight request {} failed: {}",
            self.request_index, self.error
        )
    }
}

impl std::error::Error for SchedulerPreflightError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.error)
    }
}

/// A scheduler delivery failure bound to the exact live route table used for
/// validation and delivery.
///
/// The message-bus error is redacted before it enters this wrapper, so the
/// scheduler can retain its code and route generation without retaining a
/// payload or schema-validation detail.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SchedulerDeliveryError {
    route_generation: u64,
    error: MessageContractError,
}

impl SchedulerDeliveryError {
    fn new(route_generation: u64, error: MessageContractError) -> Self {
        Self {
            route_generation,
            error: redact_scheduler_delivery_error(error),
        }
    }

    pub(crate) fn route_generation(&self) -> u64 {
        self.route_generation
    }

    pub(crate) fn code(&self) -> &str {
        &self.error.code
    }

    pub(crate) fn error(&self) -> &MessageContractError {
        &self.error
    }
}

impl std::fmt::Display for SchedulerDeliveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Scheduler delivery on route generation {} failed: {}",
            self.route_generation, self.error
        )
    }
}

impl std::error::Error for SchedulerDeliveryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.error)
    }
}

impl RuntimeMessageBus {
    pub fn new(context: InstanceContext) -> Self {
        let initial = Arc::new(RouteTable::empty(&context));
        let (routes, _) = watch::channel(Arc::clone(&initial));
        let (public_routes, _) = watch::channel(Arc::new(initial.public.clone()));
        Self {
            inner: Arc::new(RuntimeMessageBusInner {
                context,
                routes,
                public_routes,
                updates: AsyncMutex::new(UpdateState {
                    registrations: BTreeMap::new(),
                    retired: Vec::new(),
                }),
                observations: Arc::new(ObservationStore::default()),
            }),
        }
    }

    pub fn context(&self) -> &InstanceContext {
        &self.inner.context
    }

    pub fn snapshot(&self) -> MessageRouteSnapshot {
        self.inner.routes.borrow().public.clone()
    }

    pub fn subscribe_snapshots(&self) -> watch::Receiver<Arc<MessageRouteSnapshot>> {
        self.inner.public_routes.subscribe()
    }

    /// Records a frontend handler outcome after the bridge has contained the
    /// failure. The frame payload is deliberately unavailable at this seam.
    pub fn record_frontend_failure(
        &self,
        endpoint: &str,
        message: &MessageTypeId,
        code: &'static str,
    ) {
        let generation = self.inner.routes.borrow().public.route_generation;
        self.inner
            .observations
            .frontend_failed(endpoint, message, generation, code);
    }

    /// Validates scheduler candidates against one immutable live route table.
    ///
    /// The callback is intentionally synchronous and executes while the route
    /// update mutex is held. It may build a scheduler snapshot from the
    /// returned binding, but must not wait for or invoke route mutation.
    /// Preflight is validation only: it neither grants authority nor enqueues
    /// a message for delivery.
    pub async fn with_scheduler_preflight<T>(
        &self,
        requests: &[SchedulerPreflightRequest],
        operation: impl FnOnce(SchedulerPreflightSnapshot) -> T,
    ) -> Result<T, SchedulerPreflightError> {
        self.with_scheduler_preflight_all(requests, operation)
            .await
            .map_err(|errors| {
                errors
                    .into_iter()
                    .next()
                    .expect("all-errors preflight only fails with at least one error")
            })
    }

    /// Validates every scheduler candidate against one immutable live route
    /// table and reports each failure in input order.
    ///
    /// The callback is synchronous and runs only when every request succeeds,
    /// while the route update mutex remains held. This lets the scheduler
    /// build one source-indexed candidate snapshot against one bus generation
    /// without granting authority or delivering a message.
    pub async fn with_scheduler_preflight_all<T>(
        &self,
        requests: &[SchedulerPreflightRequest],
        operation: impl FnOnce(SchedulerPreflightSnapshot) -> T,
    ) -> Result<T, Vec<SchedulerPreflightError>> {
        let _updates = self.inner.updates.lock().await;
        let routes = self.inner.routes.borrow().clone();
        let errors = requests
            .iter()
            .enumerate()
            .filter_map(|(request_index, request)| {
                validate_scheduler_preflight_request(&routes, request)
                    .err()
                    .map(|error| SchedulerPreflightError::new(request_index, error))
            })
            .collect::<Vec<_>>();
        if !errors.is_empty() {
            return Err(errors);
        }
        Ok(operation(SchedulerPreflightSnapshot::from_routes(
            &routes.public,
        )))
    }

    pub async fn register(
        &self,
        registration: Arc<PreparedRegistration>,
    ) -> Result<MessageRouteSnapshot, MessageContractError> {
        self.register_many(vec![registration]).await
    }

    pub async fn register_many(
        &self,
        registrations: Vec<Arc<PreparedRegistration>>,
    ) -> Result<MessageRouteSnapshot, MessageContractError> {
        let mut updates = self.inner.updates.lock().await;
        let mut next = updates.registrations.clone();
        for registration in registrations {
            if next
                .insert(
                    registration.activation_id().to_string(),
                    Arc::clone(&registration),
                )
                .is_some()
            {
                return Err(MessageContractError::new(
                    DUPLICATE_CHANNEL_OWNER,
                    format!(
                        "Activation {:?} is already registered",
                        registration.activation_id()
                    ),
                ));
            }
        }
        self.publish_locked(&mut updates, next)
    }

    pub async fn replace(
        &self,
        retired_activation_id: &str,
        registration: Arc<PreparedRegistration>,
    ) -> Result<MessageRouteSnapshot, MessageContractError> {
        let mut updates = self.inner.updates.lock().await;
        if !updates.registrations.contains_key(retired_activation_id) {
            return Err(MessageContractError::new(
                NO_ACTIVE_CHANNEL_OWNER,
                format!("Activation {retired_activation_id:?} is not active"),
            ));
        }
        let mut next = updates.registrations.clone();
        next.remove(retired_activation_id);
        if next.contains_key(registration.activation_id()) {
            return Err(MessageContractError::new(
                DUPLICATE_CHANNEL_OWNER,
                format!(
                    "Activation {:?} is already registered",
                    registration.activation_id()
                ),
            ));
        }
        next.insert(
            registration.activation_id().to_string(),
            Arc::clone(&registration),
        );
        self.publish_locked(&mut updates, next)
    }

    /// Atomically replaces one caller-owned activation set while preserving all
    /// registrations owned by other host capabilities. Candidate registrations
    /// are fully prepared before this method acquires the publication lock.
    pub async fn reconcile_many(
        &self,
        expected_route_generation: u64,
        retired_activation_ids: &[String],
        registrations: Vec<Arc<PreparedRegistration>>,
    ) -> Result<MessageRouteSnapshot, MessageContractError> {
        let mut updates = self.inner.updates.lock().await;
        let current_generation = self.inner.routes.borrow().public.route_generation;
        if current_generation != expected_route_generation {
            return Err(MessageContractError::new(
                ROUTE_GENERATION_CHANGED,
                format!(
                    "Expected message route generation {expected_route_generation}, found {current_generation}"
                ),
            ));
        }

        let mut next = updates.registrations.clone();
        for activation_id in retired_activation_ids {
            next.remove(activation_id);
        }
        for registration in registrations {
            if next
                .insert(
                    registration.activation_id().to_string(),
                    Arc::clone(&registration),
                )
                .is_some()
            {
                return Err(MessageContractError::new(
                    DUPLICATE_CHANNEL_OWNER,
                    format!(
                        "Activation {:?} is already registered",
                        registration.activation_id()
                    ),
                ));
            }
        }
        self.publish_locked(&mut updates, next)
    }

    /// Reconciles one caller-owned registration family together with schedule
    /// candidates that depend on the successor route table.
    ///
    /// The route table is built and scheduler requests are validated while the
    /// update lock is held, but neither is public at that point. `prepare`
    /// must only construct private scheduler state. After the route table is
    /// published, `commit` receives that prepared state without an await or a
    /// fallible step. A rejected schedule therefore leaves the old routes
    /// public, and a committed schedule can never target an unpublished route.
    pub async fn reconcile_many_with_scheduler_preflight<T>(
        &self,
        expected_route_generation: u64,
        retired_activation_ids: &[String],
        registrations: Vec<Arc<PreparedRegistration>>,
        requests: &[SchedulerPreflightRequest],
        prepare: impl FnOnce(SchedulerPreflightSnapshot) -> Result<T, MessageContractError>,
        commit: impl FnOnce(T),
    ) -> Result<MessageRouteSnapshot, MessageContractError> {
        let mut updates = self.inner.updates.lock().await;
        let current_generation = self.inner.routes.borrow().public.route_generation;
        if current_generation != expected_route_generation {
            return Err(MessageContractError::new(
                ROUTE_GENERATION_CHANGED,
                format!(
                    "Expected message route generation {expected_route_generation}, found {current_generation}"
                ),
            ));
        }

        let mut next = updates.registrations.clone();
        for activation_id in retired_activation_ids {
            next.remove(activation_id);
        }
        for registration in registrations {
            if next
                .insert(
                    registration.activation_id().to_string(),
                    Arc::clone(&registration),
                )
                .is_some()
            {
                return Err(MessageContractError::new(
                    DUPLICATE_CHANNEL_OWNER,
                    format!(
                        "Activation {:?} is already registered",
                        registration.activation_id()
                    ),
                ));
            }
        }

        let generation = self.inner.routes.borrow().public.route_generation + 1;
        let table = Arc::new(RouteTable::build(&self.inner.context, generation, &next)?);
        let errors = requests
            .iter()
            .enumerate()
            .filter_map(|(request_index, request)| {
                validate_scheduler_preflight_request(&table, request)
                    .err()
                    .map(|error| SchedulerPreflightError::new(request_index, error))
            })
            .collect::<Vec<_>>();
        if let Some(error) = errors.first() {
            return Err(error.error().clone());
        }
        let prepared = prepare(SchedulerPreflightSnapshot::from_routes(&table.public))?;
        let snapshot = self.publish_table_locked(&mut updates, next, table);
        commit(prepared);
        Ok(snapshot)
    }

    pub async fn publish_complete(
        &self,
        registrations: Vec<Arc<PreparedRegistration>>,
    ) -> Result<MessageRouteSnapshot, MessageContractError> {
        let mut next = BTreeMap::new();
        for registration in registrations {
            if next
                .insert(
                    registration.activation_id().to_string(),
                    Arc::clone(&registration),
                )
                .is_some()
            {
                return Err(MessageContractError::new(
                    DUPLICATE_CHANNEL_OWNER,
                    format!(
                        "Activation {:?} occurs more than once",
                        registration.activation_id()
                    ),
                ));
            }
        }
        let mut updates = self.inner.updates.lock().await;
        self.publish_locked(&mut updates, next)
    }

    pub async fn withdraw(
        &self,
        activation_id: &str,
    ) -> Result<Arc<PreparedRegistration>, MessageContractError> {
        self.withdraw_many(&[activation_id.to_string()])
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| {
                MessageContractError::new(
                    NO_ACTIVE_CHANNEL_OWNER,
                    format!("Activation {activation_id:?} is not active"),
                )
            })
    }

    pub async fn withdraw_many(
        &self,
        activation_ids: &[String],
    ) -> Result<Vec<Arc<PreparedRegistration>>, MessageContractError> {
        let mut updates = self.inner.updates.lock().await;
        let mut next = updates.registrations.clone();
        let retired = activation_ids
            .iter()
            .filter_map(|activation_id| next.remove(activation_id))
            .collect::<Vec<_>>();
        if retired.is_empty() {
            return Ok(retired);
        }
        self.publish_locked(&mut updates, next)?;
        Ok(retired)
    }

    /// Disposes retired registrations after all observable leases are gone.
    /// Registrations that still own work remain available to inspection.
    pub async fn reap_retired(&self) -> u64 {
        let ready = {
            let mut updates = self.inner.updates.lock().await;
            let mut ready = Vec::new();
            updates.retired.retain(|registration| {
                if registration.in_flight() == 0 && registration.reply_handles() == 0 {
                    ready.push(Arc::clone(registration));
                    false
                } else {
                    true
                }
            });
            ready
        };
        let count = ready.len() as u64;
        for registration in ready {
            registration.dispose().await;
        }
        count
    }

    fn publish_locked(
        &self,
        updates: &mut UpdateState,
        next: BTreeMap<String, Arc<PreparedRegistration>>,
    ) -> Result<MessageRouteSnapshot, MessageContractError> {
        let generation = self.inner.routes.borrow().public.route_generation + 1;
        let table = Arc::new(RouteTable::build(&self.inner.context, generation, &next)?);
        Ok(self.publish_table_locked(updates, next, table))
    }

    fn publish_table_locked(
        &self,
        updates: &mut UpdateState,
        next: BTreeMap<String, Arc<PreparedRegistration>>,
        table: Arc<RouteTable>,
    ) -> MessageRouteSnapshot {
        let observations = Arc::clone(&self.inner.observations);
        let recorder: DeliveryRecorder =
            Arc::new(move |endpoint, envelope, generation, failure| {
                observations.delivered(endpoint, envelope, generation, failure);
            });
        for registration in next.values() {
            registration.start(Arc::clone(&recorder));
        }

        let retired = updates
            .registrations
            .values()
            .filter(|old| {
                next.get(old.activation_id())
                    .is_none_or(|new| !Arc::ptr_eq(old, new))
            })
            .cloned()
            .collect::<Vec<_>>();

        self.inner.routes.send_replace(Arc::clone(&table));
        self.inner
            .public_routes
            .send_replace(Arc::new(table.public.clone()));
        updates.registrations = next;
        for registration in retired {
            registration.withdraw_and_cancel();
            updates.retired.push(registration);
        }
        table.public.clone()
    }

    pub async fn send(
        &self,
        authority: &ModuleMessageAuthority,
        envelope: MessageEnvelope,
    ) -> Result<DeliveryReceipt, MessageContractError> {
        let table = self.inner.routes.borrow().clone();
        let result = async {
            let route = table.channels.get(&envelope.endpoint).ok_or_else(|| {
                MessageContractError::new(
                    NO_ACTIVE_CHANNEL_OWNER,
                    format!("Channel {:?} has no active owner", envelope.endpoint),
                )
            })?;
            authority.authorize(&route.route.declaration.required_grant)?;
            validate_message(
                &route.registration,
                &route.route.declaration.endpoint.message,
                &envelope,
            )?;
            if route.registration.is_withdrawn() {
                return Err(MessageContractError::new(
                    HANDLER_UNAVAILABLE,
                    format!("Channel {:?} is withdrawn", envelope.endpoint),
                ));
            }
            route
                .route
                .sender
                .send(DirectedDelivery {
                    envelope: envelope.clone(),
                    route_generation: table.public.route_generation,
                })
                .await
                .map_err(|_| {
                    MessageContractError::new(
                        HANDLER_UNAVAILABLE,
                        format!("Channel {:?} handler is unavailable", envelope.endpoint),
                    )
                })?;
            Ok(DeliveryReceipt {
                schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
                endpoint: envelope.endpoint.clone(),
                message: envelope.message.clone(),
                route_generation: table.public.route_generation,
            })
        }
        .await;
        match result {
            Ok(receipt) => {
                self.inner.observations.accepted(&envelope.endpoint);
                Ok(receipt)
            }
            Err(error) => {
                self.inner
                    .observations
                    .rejected(&error, &envelope, table.public.route_generation);
                Err(error)
            }
        }
    }

    /// Delivers a scheduler-owned occurrence through a live directed channel.
    ///
    /// The scheduler is a host capability, not a module activation: it never
    /// receives a fabricated [`ModuleMessageAuthority`] or a synthetic grant.
    /// A route opts into this path explicitly with `scheduler_allowed`; the
    /// current route table and its compiled contract are checked immediately
    /// before the bounded delivery is accepted.
    pub(crate) async fn send_from_scheduler(
        &self,
        envelope: MessageEnvelope,
    ) -> Result<DeliveryReceipt, SchedulerDeliveryError> {
        let table = self.inner.routes.borrow().clone();
        let result: Result<DeliveryReceipt, MessageContractError> = async {
            validate_scheduler_target(&table, SchedulerPreflightTargetKind::Channel, &envelope)?;
            let route = table
                .channels
                .get(&envelope.endpoint)
                .expect("validated scheduler channel must exist in its route table");
            if route.registration.is_withdrawn() {
                return Err(MessageContractError::new(
                    HANDLER_UNAVAILABLE,
                    format!("Channel {:?} is withdrawn", envelope.endpoint),
                ));
            }
            route
                .route
                .sender
                .send(DirectedDelivery {
                    envelope: envelope.clone(),
                    route_generation: table.public.route_generation,
                })
                .await
                .map_err(|_| {
                    MessageContractError::new(
                        HANDLER_UNAVAILABLE,
                        format!("Channel {:?} handler is unavailable", envelope.endpoint),
                    )
                })?;
            Ok(DeliveryReceipt {
                schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
                endpoint: envelope.endpoint.clone(),
                message: envelope.message.clone(),
                route_generation: table.public.route_generation,
            })
        }
        .await;
        match result {
            Ok(receipt) => {
                self.inner.observations.accepted(&envelope.endpoint);
                Ok(receipt)
            }
            Err(error) => {
                let error = SchedulerDeliveryError::new(table.public.route_generation, error);
                self.inner.observations.rejected(
                    error.error(),
                    &envelope,
                    error.route_generation(),
                );
                Err(error)
            }
        }
    }

    pub fn subscribe(
        &self,
        authority: &ModuleMessageAuthority,
        endpoint: &str,
    ) -> Result<RuntimeSubscription, MessageContractError> {
        let table = self.inner.routes.borrow().clone();
        let route = table.topics.get(endpoint).ok_or_else(|| {
            MessageContractError::new(
                NO_ACTIVE_CHANNEL_OWNER,
                format!("Topic {endpoint:?} has no active publisher"),
            )
        })?;
        authority.authorize(&format!("message.subscribe.{endpoint}"))?;
        Ok(RuntimeSubscription {
            endpoint: endpoint.to_string(),
            message: route.route.declaration.endpoint.message.clone(),
            route_generation: table.public.route_generation,
            receiver: route.route.sender.subscribe(),
            observations: Arc::clone(&self.inner.observations),
        })
    }

    pub fn publish(
        &self,
        authority: &ModuleMessageAuthority,
        envelope: MessageEnvelope,
    ) -> Result<PublishReceipt, MessageContractError> {
        let table = self.inner.routes.borrow().clone();
        let result = (|| {
            let route = table.topics.get(&envelope.endpoint).ok_or_else(|| {
                MessageContractError::new(
                    NO_ACTIVE_CHANNEL_OWNER,
                    format!("Topic {:?} has no active publisher", envelope.endpoint),
                )
            })?;
            authority.authorize(&route.route.declaration.required_grant)?;
            validate_message(
                &route.registration,
                &route.route.declaration.endpoint.message,
                &envelope,
            )?;
            if route.registration.is_withdrawn() {
                return Err(MessageContractError::new(
                    HANDLER_UNAVAILABLE,
                    format!("Topic {:?} is withdrawn", envelope.endpoint),
                ));
            }
            let subscriber_count = route
                .route
                .sender
                .send(BroadcastDelivery {
                    envelope: envelope.clone(),
                    route_generation: table.public.route_generation,
                })
                .unwrap_or(0) as u32;
            Ok(PublishReceipt {
                schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
                endpoint: envelope.endpoint.clone(),
                message: envelope.message.clone(),
                route_generation: table.public.route_generation,
                subscriber_count,
            })
        })();
        match result {
            Ok(receipt) => {
                self.inner.observations.accepted(&envelope.endpoint);
                Ok(receipt)
            }
            Err(error) => {
                self.inner
                    .observations
                    .rejected(&error, &envelope, table.public.route_generation);
                Err(error)
            }
        }
    }

    /// Publishes a scheduler-owned occurrence through a live broadcast topic.
    ///
    /// This has the same host-only authorization boundary as
    /// [`Self::send_from_scheduler`]: no module grant is synthesized, and the
    /// live route must explicitly permit scheduler delivery.
    pub(crate) fn publish_from_scheduler(
        &self,
        envelope: MessageEnvelope,
    ) -> Result<PublishReceipt, SchedulerDeliveryError> {
        let table = self.inner.routes.borrow().clone();
        let result: Result<PublishReceipt, MessageContractError> = (|| {
            validate_scheduler_target(&table, SchedulerPreflightTargetKind::Topic, &envelope)?;
            let route = table
                .topics
                .get(&envelope.endpoint)
                .expect("validated scheduler topic must exist in its route table");
            if route.registration.is_withdrawn() {
                return Err(MessageContractError::new(
                    HANDLER_UNAVAILABLE,
                    format!("Topic {:?} is withdrawn", envelope.endpoint),
                ));
            }
            let subscriber_count = route
                .route
                .sender
                .send(BroadcastDelivery {
                    envelope: envelope.clone(),
                    route_generation: table.public.route_generation,
                })
                .unwrap_or(0) as u32;
            Ok(PublishReceipt {
                schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
                endpoint: envelope.endpoint.clone(),
                message: envelope.message.clone(),
                route_generation: table.public.route_generation,
                subscriber_count,
            })
        })();
        match result {
            Ok(receipt) => {
                self.inner.observations.accepted(&envelope.endpoint);
                Ok(receipt)
            }
            Err(error) => {
                let error = SchedulerDeliveryError::new(table.public.route_generation, error);
                self.inner.observations.rejected(
                    error.error(),
                    &envelope,
                    error.route_generation(),
                );
                Err(error)
            }
        }
    }

    pub async fn request(
        &self,
        authority: &ModuleMessageAuthority,
        envelope: MessageEnvelope,
    ) -> Result<MessageEnvelope, MessageContractError> {
        let table = self.inner.routes.borrow().clone();
        let result = async {
            let route = table.ports.get(&envelope.endpoint).ok_or_else(|| {
                MessageContractError::new(
                    NO_ACTIVE_CHANNEL_OWNER,
                    format!(
                        "Capability port {:?} has no active owner",
                        envelope.endpoint
                    ),
                )
            })?;
            authority.authorize(&route.route.declaration.required_grant)?;
            validate_message(
                &route.registration,
                &route.route.declaration.request,
                &envelope,
            )?;
            if route.registration.is_withdrawn() {
                return Err(MessageContractError::new(
                    HANDLER_UNAVAILABLE,
                    format!("Capability port {:?} is withdrawn", envelope.endpoint),
                ));
            }
            let (reply, response) = oneshot::channel();
            route
                .route
                .sender
                .send(PortRequest {
                    envelope: envelope.clone(),
                    route_generation: table.public.route_generation,
                    reply,
                })
                .await
                .map_err(|_| {
                    MessageContractError::new(
                        HANDLER_UNAVAILABLE,
                        format!("Capability port {:?} is unavailable", envelope.endpoint),
                    )
                })?;
            let response = response.await.map_err(|_| {
                MessageContractError::new(
                    HANDLER_UNAVAILABLE,
                    format!(
                        "Capability port {:?} reply was cancelled",
                        envelope.endpoint
                    ),
                )
            })??;
            validate_message(
                &route.registration,
                &route.route.declaration.response,
                &response,
            )?;
            Ok(response)
        }
        .await;
        match result {
            Ok(response) => {
                self.inner.observations.accepted(&envelope.endpoint);
                Ok(response)
            }
            Err(error) => {
                self.inner
                    .observations
                    .rejected(&error, &envelope, table.public.route_generation);
                Err(error)
            }
        }
    }

    /// Invoke a capability port after the host's agent-capability boundary has
    /// resolved and authorized it. This deliberately bypasses module grants;
    /// it is crate-private so no generic external message-send surface exists.
    pub(crate) async fn request_from_agent(
        &self,
        envelope: MessageEnvelope,
    ) -> Result<MessageEnvelope, MessageContractError> {
        let table = self.inner.routes.borrow().clone();
        let result = async {
            let route = table.ports.get(&envelope.endpoint).ok_or_else(|| {
                MessageContractError::new(
                    NO_ACTIVE_CHANNEL_OWNER,
                    format!(
                        "Capability port {:?} has no active owner",
                        envelope.endpoint
                    ),
                )
            })?;
            validate_message(
                &route.registration,
                &route.route.declaration.request,
                &envelope,
            )?;
            if route.registration.is_withdrawn() {
                return Err(MessageContractError::new(
                    HANDLER_UNAVAILABLE,
                    format!("Capability port {:?} is withdrawn", envelope.endpoint),
                ));
            }
            let (reply, response) = oneshot::channel();
            route
                .route
                .sender
                .send(PortRequest {
                    envelope: envelope.clone(),
                    route_generation: table.public.route_generation,
                    reply,
                })
                .await
                .map_err(|_| {
                    MessageContractError::new(
                        HANDLER_UNAVAILABLE,
                        format!("Capability port {:?} is unavailable", envelope.endpoint),
                    )
                })?;
            let response = response.await.map_err(|_| {
                MessageContractError::new(
                    HANDLER_UNAVAILABLE,
                    format!(
                        "Capability port {:?} reply was cancelled",
                        envelope.endpoint
                    ),
                )
            })??;
            validate_message(
                &route.registration,
                &route.route.declaration.response,
                &response,
            )?;
            Ok(response)
        }
        .await;
        match result {
            Ok(response) => {
                self.inner.observations.accepted(&envelope.endpoint);
                Ok(response)
            }
            Err(error) => {
                self.inner
                    .observations
                    .rejected(&error, &envelope, table.public.route_generation);
                Err(error)
            }
        }
    }

    pub async fn inspect_endpoints(&self) -> Vec<EndpointRuntimeObservation> {
        let table = self.inner.routes.borrow().clone();
        let counters = self
            .inner
            .observations
            .endpoints
            .lock()
            .expect("message observation lock poisoned");
        let mut endpoints = counters.keys().cloned().collect::<BTreeSet<_>>();
        endpoints.extend(table.channels.keys().cloned());
        endpoints.extend(table.topics.keys().cloned());
        endpoints.extend(table.ports.keys().cloned());
        endpoints
            .into_iter()
            .map(|endpoint| {
                let counters = counters.get(&endpoint);
                let (queued, capacity) = if let Some(route) = table.channels.get(&endpoint) {
                    (
                        (route.route.sender.max_capacity() - route.route.sender.capacity()) as u64,
                        route.route.sender.max_capacity() as u64,
                    )
                } else if let Some(route) = table.ports.get(&endpoint) {
                    (
                        (route.route.sender.max_capacity() - route.route.sender.capacity()) as u64,
                        route.route.sender.max_capacity() as u64,
                    )
                } else if let Some(route) = table.topics.get(&endpoint) {
                    (
                        route.route.sender.len() as u64,
                        route.route.declaration.capacity as u64,
                    )
                } else {
                    (0, 0)
                };
                EndpointRuntimeObservation {
                    endpoint,
                    accepted: counters.map_or(0, |value| value.accepted),
                    delivered: counters.map_or(0, |value| value.delivered),
                    failed: counters.map_or(0, |value| value.failed),
                    lagged: counters.map_or(0, |value| value.lagged),
                    queued,
                    capacity,
                    last_failure: counters.and_then(|value| value.last_failure.clone()),
                }
            })
            .collect()
    }

    pub async fn inspect_activations(&self) -> Vec<ActivationRuntimeObservation> {
        let updates = self.inner.updates.lock().await;
        updates
            .registrations
            .values()
            .chain(updates.retired.iter())
            .map(|registration| ActivationRuntimeObservation {
                activation_id: registration.activation_id().to_string(),
                withdrawn: registration.is_withdrawn(),
                cancelled: registration.is_cancelled(),
                in_flight: registration.in_flight(),
                reply_handles: registration.reply_handles(),
            })
            .collect()
    }
}

fn validate_message(
    registration: &PreparedRegistration,
    expected: &MessageTypeId,
    envelope: &MessageEnvelope,
) -> Result<(), MessageContractError> {
    let contract = registration
        .declarations()
        .contract(expected)
        .expect("route contract was prepared");
    if envelope.message.id != expected.id {
        return Err(MessageContractError::new(
            UNKNOWN_MESSAGE_CONTRACT,
            format!(
                "Message contract {:?} is not installed for this route",
                envelope.message.id
            ),
        ));
    }
    contract.validate_envelope(envelope)
}

fn validate_scheduler_preflight_request(
    routes: &RouteTable,
    request: &SchedulerPreflightRequest,
) -> Result<(), MessageContractError> {
    validate_scheduler_target(routes, request.target_kind, &request.envelope)
}

fn validate_scheduler_target(
    routes: &RouteTable,
    target_kind: SchedulerPreflightTargetKind,
    envelope: &MessageEnvelope,
) -> Result<(), MessageContractError> {
    let (registration, expected, scheduler_allowed) = match target_kind {
        SchedulerPreflightTargetKind::Channel => {
            let route = routes.channels.get(&envelope.endpoint).ok_or_else(|| {
                MessageContractError::new(
                    NO_ACTIVE_CHANNEL_OWNER,
                    format!("Channel {:?} has no active owner", envelope.endpoint),
                )
            })?;
            (
                route.registration.as_ref(),
                &route.route.declaration.endpoint.message,
                route.route.declaration.scheduler_allowed,
            )
        }
        SchedulerPreflightTargetKind::Topic => {
            let route = routes.topics.get(&envelope.endpoint).ok_or_else(|| {
                MessageContractError::new(
                    NO_ACTIVE_CHANNEL_OWNER,
                    format!("Topic {:?} has no active publisher", envelope.endpoint),
                )
            })?;
            (
                route.registration.as_ref(),
                &route.route.declaration.endpoint.message,
                route.route.declaration.scheduler_allowed,
            )
        }
    };

    if envelope.message.id != expected.id {
        return Err(MessageContractError::new(
            UNKNOWN_MESSAGE_CONTRACT,
            format!(
                "Message contract {:?} is not installed for this route",
                envelope.message.id
            ),
        ));
    }
    if envelope.message != *expected {
        return Err(MessageContractError::new(
            INCOMPATIBLE_MESSAGE_VERSION,
            format!(
                "Message version {} does not match the route contract version {}",
                envelope.message.version, expected.version
            ),
        ));
    }
    if !scheduler_allowed {
        return Err(MessageContractError::new(
            UNAUTHORIZED_SENDER,
            "Scheduled delivery is not authorized for this route",
        ));
    }

    let contract = registration
        .declarations()
        .contract(expected)
        .expect("active route contract was prepared");
    if contract
        .contract()
        .schema
        .redacted_fields
        .iter()
        .any(|pointer| envelope.payload.pointer(pointer).is_some())
    {
        return Err(MessageContractError::new(
            SCHEDULER_SECRET_PAYLOAD_FORBIDDEN,
            "Scheduled payload contains a field marked secret by its message contract",
        ));
    }
    contract.validate_envelope(envelope)
}

fn redact_scheduler_delivery_error(error: MessageContractError) -> MessageContractError {
    MessageContractError {
        code: error.code,
        message: "Scheduled delivery failed message-bus validation".to_string(),
    }
}

pub struct RuntimeSubscription {
    endpoint: String,
    message: MessageTypeId,
    route_generation: u64,
    receiver: broadcast::Receiver<BroadcastDelivery>,
    observations: Arc<ObservationStore>,
}

pub struct RuntimeDelivery {
    pub envelope: MessageEnvelope,
    pub route_generation: u64,
}

impl RuntimeSubscription {
    pub async fn recv(&mut self) -> Result<MessageEnvelope, MessageContractError> {
        self.recv_delivery().await.map(|delivery| delivery.envelope)
    }

    pub async fn recv_delivery(&mut self) -> Result<RuntimeDelivery, MessageContractError> {
        match self.receiver.recv().await {
            Ok(delivery) => {
                self.route_generation = delivery.route_generation;
                Ok(RuntimeDelivery {
                    envelope: delivery.envelope,
                    route_generation: delivery.route_generation,
                })
            }
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                self.observations
                    .lagged(&self.endpoint, &self.message, self.route_generation);
                Err(MessageContractError::new(
                    SUBSCRIBER_LAG,
                    format!("Subscriber lagged by {skipped} messages"),
                ))
            }
            Err(broadcast::error::RecvError::Closed) => Err(MessageContractError::new(
                HANDLER_UNAVAILABLE,
                format!("Topic {:?} is closed", self.endpoint),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{mpsc, Arc, Barrier, Mutex};

    use serde_json::json;
    use tokio::sync::Notify;
    use uuid::Uuid;

    use crate::instance::{InstanceBuildIdentity, InstanceContext, LaunchProvenance, RootSource};
    use crate::module_control::ModuleGrant;

    use super::*;
    use crate::message_bus::{
        BroadcastTopicDeclaration, CapabilityPortDeclaration, DirectedChannelDeclaration,
        MessageDeclarations, MessageSchemaDescriptor, MessageTypeContract, RegistrationHandlers,
        RouteEndpointRef, INVALID_PAYLOAD, PAYLOAD_TOO_LARGE, SCHEDULER_SECRET_PAYLOAD_FORBIDDEN,
        UNAUTHORIZED_SENDER,
    };

    const CHANNEL: &str = "fixture.directed";
    const SECOND_CHANNEL: &str = "fixture.secondary";
    const TOPIC: &str = "fixture.events";
    const PORT: &str = "fixture.lookup";
    const MESSAGE: &str = "fixture.value";
    const RESPONSE: &str = "fixture.response";

    fn context(name: &str, root: PathBuf) -> InstanceContext {
        InstanceContext {
            instance_id: Uuid::new_v4(),
            name: name.to_string(),
            state_root: root.join("state"),
            runtime_root: root.join("runtime"),
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

    fn declarations(channels: &[&str], topic: bool, port: bool) -> MessageDeclarations {
        let mut provides = vec![contract(MESSAGE)];
        if port {
            provides.push(contract(RESPONSE));
        }
        MessageDeclarations {
            schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
            provides,
            handles: channels
                .iter()
                .map(|endpoint| DirectedChannelDeclaration {
                    endpoint: RouteEndpointRef {
                        id: (*endpoint).to_string(),
                        message: message(MESSAGE),
                    },
                    capacity: 1,
                    required_grant: format!("message.send.{endpoint}"),
                    scheduler_allowed: true,
                })
                .collect(),
            publishes: topic
                .then(|| BroadcastTopicDeclaration {
                    endpoint: RouteEndpointRef {
                        id: TOPIC.to_string(),
                        message: message(MESSAGE),
                    },
                    capacity: 2,
                    required_grant: format!("message.publish.{TOPIC}"),
                    scheduler_allowed: true,
                })
                .into_iter()
                .collect(),
            subscribes: Vec::new(),
            ports: port
                .then(|| CapabilityPortDeclaration {
                    id: PORT.to_string(),
                    request: message(MESSAGE),
                    response: message(RESPONSE),
                    capacity: 1,
                    required_grant: format!("message.request.{PORT}"),
                    scheduler_allowed: false,
                })
                .into_iter()
                .collect(),
        }
    }

    fn grants(ids: &[String]) -> Vec<ModuleGrant> {
        ids.iter()
            .map(|id| ModuleGrant {
                id: id.clone(),
                effective: true,
            })
            .collect()
    }

    fn authority(activation_id: &str, ids: &[String]) -> ModuleMessageAuthority {
        ModuleMessageAuthority::from_host(activation_id, &grants(ids))
    }

    fn envelope(endpoint: &str, value: u64) -> MessageEnvelope {
        MessageEnvelope {
            schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
            endpoint: endpoint.to_string(),
            message: message(MESSAGE),
            payload: json!({"value": value}),
            correlation_id: None,
        }
    }

    fn registration(
        context: &InstanceContext,
        activation_id: &str,
        declarations: MessageDeclarations,
        handlers: RegistrationHandlers,
    ) -> Arc<PreparedRegistration> {
        Arc::new(
            PreparedRegistration::prepare(context, activation_id, &[], declarations, handlers)
                .unwrap(),
        )
    }

    async fn wait_until(mut predicate: impl FnMut() -> bool) {
        while !predicate() {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn directed_delivery_preserves_order_applies_backpressure_and_contains_failures() {
        let temporary = tempfile::tempdir().unwrap();
        let context = context("directed", temporary.path().to_path_buf());
        let bus = RuntimeMessageBus::new(context.clone());
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let handled = Arc::new(Mutex::new(Vec::new()));
        let registration = registration(
            &context,
            "fixture@a#one",
            declarations(&[CHANNEL, SECOND_CHANNEL], false, false),
            RegistrationHandlers::new()
                .with_directed(CHANNEL, {
                    let entered = Arc::clone(&entered);
                    let release = Arc::clone(&release);
                    let handled = Arc::clone(&handled);
                    move |message| {
                        let entered = Arc::clone(&entered);
                        let release = Arc::clone(&release);
                        let handled = Arc::clone(&handled);
                        async move {
                            let value = message.payload["value"].as_u64().unwrap();
                            if value == 1 {
                                entered.notify_one();
                                release.notified().await;
                            }
                            handled.lock().unwrap().push(value);
                            if value == 2 {
                                Err(MessageContractError::new(HANDLER_FAILED, "fixture failure"))
                            } else {
                                Ok(())
                            }
                        }
                    }
                })
                .with_directed(SECOND_CHANNEL, |_| async { Ok(()) }),
        );
        bus.register(Arc::clone(&registration)).await.unwrap();
        let sender = authority(
            "sender",
            &[
                format!("message.send.{CHANNEL}"),
                format!("message.send.{SECOND_CHANNEL}"),
            ],
        );

        bus.send(&sender, envelope(CHANNEL, 1)).await.unwrap();
        entered.notified().await;
        bus.send(&sender, envelope(CHANNEL, 2)).await.unwrap();
        let third = tokio::spawn({
            let bus = bus.clone();
            let sender = sender.clone();
            async move { bus.send(&sender, envelope(CHANNEL, 3)).await }
        });
        tokio::task::yield_now().await;
        assert!(
            !third.is_finished(),
            "a full queue must backpressure the sender"
        );

        release.notify_one();
        third.await.unwrap().unwrap();
        wait_until(|| handled.lock().unwrap().len() == 3).await;
        bus.send(&sender, envelope(SECOND_CHANNEL, 4))
            .await
            .unwrap();
        assert_eq!(*handled.lock().unwrap(), vec![1, 2, 3]);
        let observation = bus
            .inspect_endpoints()
            .await
            .into_iter()
            .find(|value| value.endpoint == CHANNEL)
            .unwrap();
        assert_eq!(observation.accepted, 3);
        assert_eq!(observation.delivered, 3);
        assert_eq!(observation.failed, 1);
        assert_eq!(observation.last_failure.unwrap().code, HANDLER_FAILED);
        registration.dispose().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn broadcast_reports_lag_then_continues_and_only_reaches_current_subscribers() {
        let temporary = tempfile::tempdir().unwrap();
        let context = context("broadcast", temporary.path().to_path_buf());
        let bus = RuntimeMessageBus::new(context.clone());
        let registration = registration(
            &context,
            "fixture@topic#one",
            declarations(&[], true, false),
            RegistrationHandlers::new(),
        );
        bus.register(Arc::clone(&registration)).await.unwrap();
        let publisher = authority("publisher", &[format!("message.publish.{TOPIC}")]);
        let subscriber = authority("subscriber", &[format!("message.subscribe.{TOPIC}")]);
        let mut slow = bus.subscribe(&subscriber, TOPIC).unwrap();
        for value in 1..=3 {
            bus.publish(&publisher, envelope(TOPIC, value)).unwrap();
        }
        assert_eq!(slow.recv().await.unwrap_err().code, SUBSCRIBER_LAG);
        assert_eq!(slow.recv().await.unwrap().payload["value"], 2);

        let mut current = bus.subscribe(&subscriber, TOPIC).unwrap();
        let receipt = bus.publish(&publisher, envelope(TOPIC, 4)).unwrap();
        assert_eq!(receipt.subscriber_count, 2);
        assert_eq!(current.recv().await.unwrap().payload["value"], 4);
        assert_eq!(slow.recv().await.unwrap().payload["value"], 3);
        assert_eq!(slow.recv().await.unwrap().payload["value"], 4);
        assert_eq!(
            bus.inspect_endpoints()
                .await
                .into_iter()
                .find(|value| value.endpoint == TOPIC)
                .unwrap()
                .lagged,
            1
        );
        registration.dispose().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn registration_and_delivery_fail_closed_without_mutating_the_active_snapshot() {
        let temporary = tempfile::tempdir().unwrap();
        let context = context("fail-closed", temporary.path().to_path_buf());
        let bus = RuntimeMessageBus::new(context.clone());
        let first = registration(
            &context,
            "fixture@a#one",
            declarations(&[CHANNEL], false, false),
            RegistrationHandlers::new().with_directed(CHANNEL, |_| async { Ok(()) }),
        );
        bus.register(Arc::clone(&first)).await.unwrap();
        let generation = bus.snapshot().route_generation;
        let duplicate = registration(
            &context,
            "fixture@b#two",
            declarations(&[CHANNEL], false, false),
            RegistrationHandlers::new().with_directed(CHANNEL, |_| async { Ok(()) }),
        );
        assert_eq!(
            bus.register(duplicate).await.unwrap_err().code,
            DUPLICATE_CHANNEL_OWNER
        );
        assert_eq!(bus.snapshot().route_generation, generation);

        let denied = authority("denied", &[]);
        assert_eq!(
            bus.send(&denied, envelope(CHANNEL, 1))
                .await
                .unwrap_err()
                .code,
            UNAUTHORIZED_SENDER
        );
        let sender = authority("sender", &[format!("message.send.{CHANNEL}")]);
        let mut incompatible = envelope(CHANNEL, 1);
        incompatible.message.version = 2;
        assert_eq!(
            bus.send(&sender, incompatible).await.unwrap_err().code,
            INCOMPATIBLE_MESSAGE_VERSION
        );
        let mut unknown_contract = envelope(CHANNEL, 1);
        unknown_contract.message.id = "fixture.unknown".to_string();
        assert_eq!(
            bus.send(&sender, unknown_contract).await.unwrap_err().code,
            UNKNOWN_MESSAGE_CONTRACT
        );
        assert_eq!(
            bus.send(&sender, envelope("fixture.unknown", 1))
                .await
                .unwrap_err()
                .code,
            NO_ACTIVE_CHANNEL_OWNER
        );
        let withdrawn = bus.withdraw(first.activation_id()).await.unwrap();
        assert_eq!(
            bus.send(&sender, envelope(CHANNEL, 1))
                .await
                .unwrap_err()
                .code,
            NO_ACTIVE_CHANNEL_OWNER
        );
        withdrawn.dispose().await;
        withdrawn.dispose().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn scheduler_preflight_binds_valid_candidates_to_live_routes_without_delivery() {
        let temporary = tempfile::tempdir().unwrap();
        let context = context("scheduler-preflight", temporary.path().to_path_buf());
        let bus = RuntimeMessageBus::new(context.clone());
        let handled = Arc::new(AtomicU64::new(0));
        let registration = registration(
            &context,
            "fixture@scheduler#one",
            declarations(&[CHANNEL], true, false),
            RegistrationHandlers::new().with_directed(CHANNEL, {
                let handled = Arc::clone(&handled);
                move |_| {
                    let handled = Arc::clone(&handled);
                    async move {
                        handled.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    }
                }
            }),
        );
        let routes = bus.register(Arc::clone(&registration)).await.unwrap();
        let requests = vec![
            SchedulerPreflightRequest {
                target_kind: SchedulerPreflightTargetKind::Channel,
                envelope: envelope(CHANNEL, 1),
            },
            SchedulerPreflightRequest {
                target_kind: SchedulerPreflightTargetKind::Topic,
                envelope: envelope(TOPIC, 2),
            },
        ];

        let preflight = bus
            .with_scheduler_preflight(&requests, |preflight| preflight)
            .await
            .unwrap();

        assert_eq!(preflight.instance_id(), routes.instance_id);
        assert_eq!(preflight.incarnation(), routes.incarnation);
        assert_eq!(preflight.route_generation(), routes.route_generation);
        assert_eq!(handled.load(Ordering::SeqCst), 0);
        let endpoint = bus
            .inspect_endpoints()
            .await
            .into_iter()
            .find(|endpoint| endpoint.endpoint == CHANNEL)
            .unwrap();
        assert_eq!(endpoint.accepted, 0);
        assert_eq!(endpoint.delivered, 0);
        registration.dispose().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn scheduler_delivery_uses_live_enabled_routes_without_a_module_authority() {
        let temporary = tempfile::tempdir().unwrap();
        let context = context("scheduler-delivery", temporary.path().to_path_buf());
        let bus = RuntimeMessageBus::new(context.clone());
        let handled = Arc::new(AtomicU64::new(0));
        let registration = registration(
            &context,
            "fixture@scheduler#delivery",
            declarations(&[CHANNEL], true, false),
            RegistrationHandlers::new().with_directed(CHANNEL, {
                let handled = Arc::clone(&handled);
                move |_| {
                    let handled = Arc::clone(&handled);
                    async move {
                        handled.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    }
                }
            }),
        );
        let routes = bus.register(Arc::clone(&registration)).await.unwrap();
        let subscriber = authority("subscriber", &[format!("message.subscribe.{TOPIC}")]);
        let mut subscription = bus.subscribe(&subscriber, TOPIC).unwrap();

        let channel_receipt = bus.send_from_scheduler(envelope(CHANNEL, 1)).await.unwrap();
        assert_eq!(channel_receipt.endpoint, CHANNEL);
        assert_eq!(channel_receipt.message, message(MESSAGE));
        assert_eq!(channel_receipt.route_generation, routes.route_generation);
        wait_until(|| handled.load(Ordering::SeqCst) == 1).await;

        let topic_receipt = bus.publish_from_scheduler(envelope(TOPIC, 2)).unwrap();
        assert_eq!(topic_receipt.endpoint, TOPIC);
        assert_eq!(topic_receipt.message, message(MESSAGE));
        assert_eq!(topic_receipt.route_generation, routes.route_generation);
        assert_eq!(topic_receipt.subscriber_count, 1);
        assert_eq!(subscription.recv().await.unwrap().payload["value"], 2);

        let observations = bus.inspect_endpoints().await;
        let channel = observations
            .iter()
            .find(|observation| observation.endpoint == CHANNEL)
            .unwrap();
        assert_eq!(
            (channel.accepted, channel.delivered, channel.failed),
            (1, 1, 0)
        );
        let topic = observations
            .iter()
            .find(|observation| observation.endpoint == TOPIC)
            .unwrap();
        assert_eq!((topic.accepted, topic.failed), (1, 0));
        registration.dispose().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn scheduler_delivery_rejects_routes_that_do_not_authorize_the_scheduler() {
        let temporary = tempfile::tempdir().unwrap();
        let context = context("scheduler-unauthorized", temporary.path().to_path_buf());
        let bus = RuntimeMessageBus::new(context.clone());
        let mut declarations = declarations(&[CHANNEL], true, false);
        declarations.handles[0].scheduler_allowed = false;
        declarations.publishes[0].scheduler_allowed = false;
        let registration = registration(
            &context,
            "fixture@scheduler#unauthorized",
            declarations,
            RegistrationHandlers::new().with_directed(CHANNEL, |_| async { Ok(()) }),
        );
        let routes = bus.register(Arc::clone(&registration)).await.unwrap();

        let channel_error = bus
            .send_from_scheduler(envelope(CHANNEL, 1))
            .await
            .unwrap_err();
        let topic_error = bus.publish_from_scheduler(envelope(TOPIC, 2)).unwrap_err();
        assert_eq!(channel_error.code(), UNAUTHORIZED_SENDER);
        assert_eq!(topic_error.code(), UNAUTHORIZED_SENDER);
        assert_eq!(channel_error.route_generation(), routes.route_generation);
        assert_eq!(topic_error.route_generation(), routes.route_generation);
        assert_eq!(
            channel_error.error().message,
            "Scheduled delivery failed message-bus validation"
        );
        assert_eq!(topic_error.error().message, channel_error.error().message);

        let observations = bus.inspect_endpoints().await;
        for endpoint in [CHANNEL, TOPIC] {
            let observation = observations
                .iter()
                .find(|observation| observation.endpoint == endpoint)
                .unwrap();
            assert_eq!(observation.accepted, 0);
            assert_eq!(observation.failed, 1);
            assert_eq!(
                observation.last_failure.as_ref().unwrap().code,
                UNAUTHORIZED_SENDER
            );
            assert!(observation
                .last_failure
                .as_ref()
                .unwrap()
                .context
                .fields
                .is_empty());
        }
        registration.dispose().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn scheduler_delivery_rejects_withdrawn_live_routes_without_delivery() {
        let temporary = tempfile::tempdir().unwrap();
        let context = context("scheduler-withdrawn", temporary.path().to_path_buf());
        let bus = RuntimeMessageBus::new(context.clone());
        let handled = Arc::new(AtomicU64::new(0));
        let registration = registration(
            &context,
            "fixture@scheduler#withdrawn",
            declarations(&[CHANNEL], true, false),
            RegistrationHandlers::new().with_directed(CHANNEL, {
                let handled = Arc::clone(&handled);
                move |_| {
                    let handled = Arc::clone(&handled);
                    async move {
                        handled.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    }
                }
            }),
        );
        bus.register(Arc::clone(&registration)).await.unwrap();
        let withdrawn = bus.withdraw(registration.activation_id()).await.unwrap();
        let withdrawn_generation = bus.snapshot().route_generation;

        let channel_error = bus
            .send_from_scheduler(envelope(CHANNEL, 1))
            .await
            .unwrap_err();
        let topic_error = bus.publish_from_scheduler(envelope(TOPIC, 2)).unwrap_err();
        assert_eq!(channel_error.code(), NO_ACTIVE_CHANNEL_OWNER);
        assert_eq!(topic_error.code(), NO_ACTIVE_CHANNEL_OWNER);
        assert_eq!(channel_error.route_generation(), withdrawn_generation);
        assert_eq!(topic_error.route_generation(), withdrawn_generation);
        assert_eq!(
            channel_error.error().message,
            "Scheduled delivery failed message-bus validation"
        );
        assert_eq!(topic_error.error().message, channel_error.error().message);
        assert_eq!(handled.load(Ordering::SeqCst), 0);

        let observations = bus.inspect_endpoints().await;
        for endpoint in [CHANNEL, TOPIC] {
            let observation = observations
                .iter()
                .find(|observation| observation.endpoint == endpoint)
                .unwrap();
            assert_eq!(observation.accepted, 0);
            assert_eq!(observation.failed, 1);
            assert_eq!(
                observation.last_failure.as_ref().unwrap().code,
                NO_ACTIVE_CHANNEL_OWNER
            );
            assert!(observation
                .last_failure
                .as_ref()
                .unwrap()
                .context
                .fields
                .is_empty());
        }
        withdrawn.dispose().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn scheduler_delivery_failure_keeps_the_route_generation_captured_before_withdrawal() {
        let temporary = tempfile::tempdir().unwrap();
        let context = context("scheduler-withdrawal-race", temporary.path().to_path_buf());
        let bus = RuntimeMessageBus::new(context.clone());
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let registration = registration(
            &context,
            "fixture@scheduler#withdrawal-race",
            declarations(&[CHANNEL], false, false),
            RegistrationHandlers::new().with_directed(CHANNEL, {
                let entered = Arc::clone(&entered);
                let release = Arc::clone(&release);
                move |message| {
                    let entered = Arc::clone(&entered);
                    let release = Arc::clone(&release);
                    async move {
                        if message.payload["value"].as_u64() == Some(1) {
                            entered.notify_one();
                            release.notified().await;
                        }
                        Ok(())
                    }
                }
            }),
        );
        let initial_routes = bus.register(Arc::clone(&registration)).await.unwrap();
        let sender = authority("sender", &[format!("message.send.{CHANNEL}")]);
        bus.send(&sender, envelope(CHANNEL, 1)).await.unwrap();
        entered.notified().await;
        bus.send(&sender, envelope(CHANNEL, 2)).await.unwrap();

        let pending = tokio::spawn({
            let bus = bus.clone();
            async move { bus.send_from_scheduler(envelope(CHANNEL, 3)).await }
        });
        tokio::task::yield_now().await;
        assert!(
            !pending.is_finished(),
            "the scheduler send must be waiting on the bounded live channel"
        );

        let withdrawn = bus.withdraw(registration.activation_id()).await.unwrap();
        let current_routes = bus.snapshot();
        assert!(current_routes.route_generation > initial_routes.route_generation);
        release.notify_one();

        let failure = pending.await.unwrap().unwrap_err();
        assert_eq!(failure.code(), HANDLER_UNAVAILABLE);
        assert_eq!(failure.route_generation(), initial_routes.route_generation);
        assert_ne!(failure.route_generation(), current_routes.route_generation);
        assert_eq!(
            failure.error().message,
            "Scheduled delivery failed message-bus validation"
        );
        let observation = bus
            .inspect_endpoints()
            .await
            .into_iter()
            .find(|observation| observation.endpoint == CHANNEL)
            .unwrap();
        assert_eq!(
            observation.last_failure.as_ref().unwrap().route_generation,
            initial_routes.route_generation
        );
        assert_eq!(
            observation.last_failure.as_ref().unwrap().code,
            HANDLER_UNAVAILABLE
        );
        withdrawn.dispose().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn scheduler_preflight_reports_redacted_indexed_route_and_payload_failures() {
        let temporary = tempfile::tempdir().unwrap();
        let context = context("scheduler-preflight-errors", temporary.path().to_path_buf());
        let bus = RuntimeMessageBus::new(context.clone());
        let handled = Arc::new(AtomicU64::new(0));
        let mut route_declarations = declarations(&[CHANNEL], true, false);
        route_declarations.handles[0].scheduler_allowed = false;
        let registration = registration(
            &context,
            "fixture@scheduler#errors",
            route_declarations,
            RegistrationHandlers::new().with_directed(CHANNEL, {
                let handled = Arc::clone(&handled);
                move |_| {
                    let handled = Arc::clone(&handled);
                    async move {
                        handled.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    }
                }
            }),
        );
        bus.register(Arc::clone(&registration)).await.unwrap();

        let denied = bus
            .with_scheduler_preflight(
                &[
                    SchedulerPreflightRequest {
                        target_kind: SchedulerPreflightTargetKind::Topic,
                        envelope: envelope(TOPIC, 1),
                    },
                    SchedulerPreflightRequest {
                        target_kind: SchedulerPreflightTargetKind::Channel,
                        envelope: envelope(CHANNEL, 2),
                    },
                ],
                |_| (),
            )
            .await
            .unwrap_err();
        assert_eq!(denied.request_index(), 1);
        assert_eq!(denied.error().code, UNAUTHORIZED_SENDER);

        let absent = bus
            .with_scheduler_preflight(
                &[SchedulerPreflightRequest {
                    target_kind: SchedulerPreflightTargetKind::Channel,
                    envelope: envelope("fixture.absent", 1),
                }],
                |_| (),
            )
            .await
            .unwrap_err();
        assert_eq!(absent.request_index(), 0);
        assert_eq!(absent.error().code, NO_ACTIVE_CHANNEL_OWNER);

        let wrong_kind = bus
            .with_scheduler_preflight(
                &[SchedulerPreflightRequest {
                    target_kind: SchedulerPreflightTargetKind::Channel,
                    envelope: envelope(TOPIC, 1),
                }],
                |_| (),
            )
            .await
            .unwrap_err();
        assert_eq!(wrong_kind.error().code, NO_ACTIVE_CHANNEL_OWNER);

        let mut invalid_payload = envelope(TOPIC, 1);
        invalid_payload.payload = json!({"value": "not-an-integer"});
        let invalid_payload = bus
            .with_scheduler_preflight(
                &[SchedulerPreflightRequest {
                    target_kind: SchedulerPreflightTargetKind::Topic,
                    envelope: invalid_payload,
                }],
                |_| (),
            )
            .await
            .unwrap_err();
        assert_eq!(invalid_payload.error().code, INVALID_PAYLOAD);

        let mut oversized_payload = envelope(TOPIC, 1);
        oversized_payload.payload = json!({"value": "x".repeat(80)});
        let oversized_payload = bus
            .with_scheduler_preflight(
                &[SchedulerPreflightRequest {
                    target_kind: SchedulerPreflightTargetKind::Topic,
                    envelope: oversized_payload,
                }],
                |_| (),
            )
            .await
            .unwrap_err();
        assert_eq!(oversized_payload.error().code, PAYLOAD_TOO_LARGE);

        let mut incompatible = envelope(TOPIC, 1);
        incompatible.message.version = 2;
        let incompatible = bus
            .with_scheduler_preflight(
                &[SchedulerPreflightRequest {
                    target_kind: SchedulerPreflightTargetKind::Topic,
                    envelope: incompatible,
                }],
                |_| (),
            )
            .await
            .unwrap_err();
        assert_eq!(incompatible.error().code, INCOMPATIBLE_MESSAGE_VERSION);
        assert_eq!(
            invalid_payload.error().message,
            "Scheduled target failed message-bus preflight"
        );
        assert!(!invalid_payload.error().message.contains("not-an-integer"));
        assert_eq!(handled.load(Ordering::SeqCst), 0);
        registration.dispose().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn scheduler_preflight_all_reports_every_indexed_failure_from_one_route_snapshot() {
        let temporary = tempfile::tempdir().unwrap();
        let context = context("scheduler-preflight-all", temporary.path().to_path_buf());
        let bus = RuntimeMessageBus::new(context.clone());
        let mut route_declarations = declarations(&[CHANNEL], true, false);
        route_declarations.handles[0].scheduler_allowed = false;
        let registration = registration(
            &context,
            "fixture@scheduler#all",
            route_declarations,
            RegistrationHandlers::new().with_directed(CHANNEL, |_| async { Ok(()) }),
        );
        let baseline_routes = bus.register(Arc::clone(&registration)).await.unwrap();
        let baseline_wire = serde_json::to_vec(&baseline_routes).unwrap();
        let mut invalid_payload = envelope(TOPIC, 1);
        invalid_payload.payload = json!({"value": "not-an-integer"});
        let callback_ran = Arc::new(AtomicBool::new(false));

        let errors = bus
            .with_scheduler_preflight_all(
                &[
                    SchedulerPreflightRequest {
                        target_kind: SchedulerPreflightTargetKind::Channel,
                        envelope: envelope(CHANNEL, 1),
                    },
                    SchedulerPreflightRequest {
                        target_kind: SchedulerPreflightTargetKind::Channel,
                        envelope: envelope("fixture.absent", 2),
                    },
                    SchedulerPreflightRequest {
                        target_kind: SchedulerPreflightTargetKind::Topic,
                        envelope: invalid_payload,
                    },
                ],
                {
                    let callback_ran = Arc::clone(&callback_ran);
                    move |_| callback_ran.store(true, Ordering::SeqCst)
                },
            )
            .await
            .unwrap_err();

        assert_eq!(
            errors
                .iter()
                .map(|error| (error.request_index(), error.error().code.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (0, UNAUTHORIZED_SENDER),
                (1, NO_ACTIVE_CHANNEL_OWNER),
                (2, INVALID_PAYLOAD),
            ]
        );
        assert!(errors.iter().all(|error| {
            error.error().message == "Scheduled target failed message-bus preflight"
        }));
        assert!(!callback_ran.load(Ordering::SeqCst));
        assert_eq!(bus.snapshot(), baseline_routes);
        assert_eq!(serde_json::to_vec(&bus.snapshot()).unwrap(), baseline_wire);
        registration.dispose().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn scheduler_preflight_all_rejects_secret_marked_payloads_without_leaking_them() {
        let temporary = tempfile::tempdir().unwrap();
        let context = context("scheduler-preflight-secret", temporary.path().to_path_buf());
        let bus = RuntimeMessageBus::new(context.clone());
        let mut route_declarations = declarations(&[], true, false);
        route_declarations.provides[0].schema.redacted_fields = vec!["/secret".to_string()];
        let registration = registration(
            &context,
            "fixture@scheduler#secret",
            route_declarations,
            RegistrationHandlers::new(),
        );
        bus.register(Arc::clone(&registration)).await.unwrap();
        let secret = "not-for-diagnostics";
        let mut envelope = envelope(TOPIC, 1);
        envelope.payload = json!({"value": 1, "secret": secret});
        let callback_ran = Arc::new(AtomicBool::new(false));

        let errors = bus
            .with_scheduler_preflight_all(
                &[SchedulerPreflightRequest {
                    target_kind: SchedulerPreflightTargetKind::Topic,
                    envelope,
                }],
                {
                    let callback_ran = Arc::clone(&callback_ran);
                    move |_| callback_ran.store(true, Ordering::SeqCst)
                },
            )
            .await
            .unwrap_err();

        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].request_index(), 0);
        assert_eq!(errors[0].error().code, SCHEDULER_SECRET_PAYLOAD_FORBIDDEN);
        assert_eq!(
            errors[0].error().message,
            "Scheduled target failed message-bus preflight"
        );
        assert!(!errors[0].error().message.contains(secret));
        assert!(!errors[0].error().message.contains("/secret"));
        assert!(!callback_ran.load(Ordering::SeqCst));
        registration.dispose().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reconcile_many_rejects_stale_generation_without_mutating_the_route_snapshot() {
        let temporary = tempfile::tempdir().unwrap();
        let context = context("reconcile-stale", temporary.path().to_path_buf());
        let bus = RuntimeMessageBus::new(context.clone());
        let first = registration(
            &context,
            "fixture@reconcile#first",
            declarations(&[CHANNEL], false, false),
            RegistrationHandlers::new().with_directed(CHANNEL, |_| async { Ok(()) }),
        );
        let stale_routes = bus.register(Arc::clone(&first)).await.unwrap();
        let second = registration(
            &context,
            "fixture@reconcile#second",
            declarations(&[SECOND_CHANNEL], false, false),
            RegistrationHandlers::new().with_directed(SECOND_CHANNEL, |_| async { Ok(()) }),
        );
        let baseline_routes = bus.register(Arc::clone(&second)).await.unwrap();
        let baseline_wire = serde_json::to_vec(&baseline_routes).unwrap();
        let replacement = registration(
            &context,
            "fixture@reconcile#replacement",
            declarations(&[CHANNEL], false, false),
            RegistrationHandlers::new().with_directed(CHANNEL, |_| async { Ok(()) }),
        );

        let error = bus
            .reconcile_many(
                stale_routes.route_generation,
                &[first.activation_id().to_string()],
                vec![replacement],
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, ROUTE_GENERATION_CHANGED);
        assert_eq!(bus.snapshot(), baseline_routes);
        assert_eq!(serde_json::to_vec(&bus.snapshot()).unwrap(), baseline_wire);
        first.dispose().await;
        second.dispose().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn scheduler_preflight_holds_a_coherent_snapshot_during_route_replacement() {
        let temporary = tempfile::tempdir().unwrap();
        let context = context(
            "scheduler-preflight-coherent",
            temporary.path().to_path_buf(),
        );
        let bus = RuntimeMessageBus::new(context.clone());
        let old = registration(
            &context,
            "fixture@scheduler#old",
            declarations(&[CHANNEL], false, false),
            RegistrationHandlers::new().with_directed(CHANNEL, |_| async { Ok(()) }),
        );
        let initial_routes = bus.register(Arc::clone(&old)).await.unwrap();
        let preflight_gate = Arc::new(Barrier::new(2));
        let (entered_sender, entered_receiver) = mpsc::channel();
        let preflight_bus = bus.clone();
        let snapshot_bus = bus.clone();
        let preflight_thread = std::thread::spawn({
            let preflight_gate = Arc::clone(&preflight_gate);
            move || {
                tokio::runtime::Builder::new_current_thread()
                    .build()
                    .unwrap()
                    .block_on(async move {
                        let requests = vec![SchedulerPreflightRequest {
                            target_kind: SchedulerPreflightTargetKind::Channel,
                            envelope: envelope(CHANNEL, 1),
                        }];
                        preflight_bus
                            .with_scheduler_preflight(&requests, move |preflight| {
                                let observed_routes = snapshot_bus.snapshot();
                                entered_sender
                                    .send((preflight.clone(), observed_routes))
                                    .unwrap();
                                preflight_gate.wait();
                                preflight
                            })
                            .await
                    })
            }
        });
        let (inside_preflight, inside_routes) = entered_receiver.recv().unwrap();

        let replacement = registration(
            &context,
            "fixture@scheduler#new",
            declarations(&[CHANNEL], false, false),
            RegistrationHandlers::new().with_directed(CHANNEL, |_| async { Ok(()) }),
        );
        let old_activation_id = old.activation_id().to_string();
        let (replacement_started_sender, replacement_started_receiver) =
            tokio::sync::oneshot::channel();
        let replacement_task = tokio::spawn({
            let bus = bus.clone();
            let replacement = Arc::clone(&replacement);
            async move {
                replacement_started_sender.send(()).unwrap();
                bus.replace(&old_activation_id, replacement).await
            }
        });
        replacement_started_receiver.await.unwrap();
        tokio::task::yield_now().await;
        assert!(
            !replacement_task.is_finished(),
            "route replacement must wait for the synchronous preflight closure"
        );

        preflight_gate.wait();
        let returned_preflight = preflight_thread.join().unwrap().unwrap();
        let replacement_routes = replacement_task.await.unwrap().unwrap();

        assert_eq!(inside_routes, initial_routes);
        assert_eq!(inside_preflight, returned_preflight);
        assert_eq!(
            inside_preflight.route_generation(),
            initial_routes.route_generation
        );
        assert_eq!(
            inside_preflight.instance_id(),
            initial_routes.instance_id.as_str()
        );
        assert_eq!(
            inside_preflight.incarnation(),
            initial_routes.incarnation.as_str()
        );
        assert!(
            replacement_routes.route_generation > inside_preflight.route_generation(),
            "replacement must publish only after the preflight closure releases the route lock"
        );
        old.dispose().await;
        replacement.dispose().await;
    }

    struct DropSignal {
        dropped: Arc<AtomicBool>,
        notify: Arc<Notify>,
    }

    impl Drop for DropSignal {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
            self.notify.notify_one();
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancelling_a_request_releases_the_reply_handle_and_handler_lease() {
        let temporary = tempfile::tempdir().unwrap();
        let context = context("request", temporary.path().to_path_buf());
        let bus = RuntimeMessageBus::new(context.clone());
        let entered = Arc::new(Notify::new());
        let never_release = Arc::new(Notify::new());
        let dropped = Arc::new(AtomicBool::new(false));
        let dropped_notify = Arc::new(Notify::new());
        let registration = registration(
            &context,
            "fixture@port#one",
            declarations(&[], false, true),
            RegistrationHandlers::new().with_port(PORT, {
                let entered = Arc::clone(&entered);
                let never_release = Arc::clone(&never_release);
                let dropped = Arc::clone(&dropped);
                let dropped_notify = Arc::clone(&dropped_notify);
                move |_| {
                    let entered = Arc::clone(&entered);
                    let never_release = Arc::clone(&never_release);
                    let guard = DropSignal {
                        dropped: Arc::clone(&dropped),
                        notify: Arc::clone(&dropped_notify),
                    };
                    async move {
                        let _guard = guard;
                        entered.notify_one();
                        never_release.notified().await;
                        unreachable!()
                    }
                }
            }),
        );
        bus.register(Arc::clone(&registration)).await.unwrap();
        let requester = authority("requester", &[format!("message.request.{PORT}")]);
        let task = tokio::spawn({
            let bus = bus.clone();
            async move { bus.request(&requester, envelope(PORT, 1)).await }
        });
        entered.notified().await;
        assert_eq!(registration.reply_handles(), 1);
        assert_eq!(registration.in_flight(), 1);
        task.abort();
        let _ = task.await;
        dropped_notify.notified().await;
        wait_until(|| registration.reply_handles() == 0 && registration.in_flight() == 0).await;
        assert!(dropped.load(Ordering::SeqCst));
        registration.dispose().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn replacement_is_atomic_and_withdrawn_leases_remain_inspectable_until_drain() {
        let temporary = tempfile::tempdir().unwrap();
        let context = context("replacement", temporary.path().to_path_buf());
        let bus = RuntimeMessageBus::new(context.clone());
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let old = registration(
            &context,
            "fixture@a#old",
            declarations(&[CHANNEL, SECOND_CHANNEL], false, false),
            RegistrationHandlers::new()
                .with_directed(CHANNEL, {
                    let entered = Arc::clone(&entered);
                    let release = Arc::clone(&release);
                    move |_| {
                        let entered = Arc::clone(&entered);
                        let release = Arc::clone(&release);
                        async move {
                            entered.notify_one();
                            release.notified().await;
                            Ok(())
                        }
                    }
                })
                .with_directed(SECOND_CHANNEL, |_| async { Ok(()) }),
        );
        bus.register(Arc::clone(&old)).await.unwrap();
        let sender = authority(
            "sender",
            &[
                format!("message.send.{CHANNEL}"),
                format!("message.send.{SECOND_CHANNEL}"),
            ],
        );
        bus.send(&sender, envelope(CHANNEL, 1)).await.unwrap();
        entered.notified().await;

        let new = registration(
            &context,
            "fixture@b#new",
            declarations(&[CHANNEL, SECOND_CHANNEL], false, false),
            RegistrationHandlers::new()
                .with_directed(CHANNEL, |_| async { Ok(()) })
                .with_directed(SECOND_CHANNEL, |_| async { Ok(()) }),
        );
        let mut snapshots = bus.subscribe_snapshots();
        let snapshot = bus
            .replace(old.activation_id(), Arc::clone(&new))
            .await
            .unwrap();
        snapshots.changed().await.unwrap();
        let observed = snapshots.borrow().clone();
        assert_eq!(*observed, snapshot);
        assert!(observed
            .channels
            .iter()
            .all(|route| route.owner_activation_id == new.activation_id()));
        assert_eq!(old.in_flight(), 1);
        let retired = bus
            .inspect_activations()
            .await
            .into_iter()
            .find(|activation| activation.activation_id == old.activation_id())
            .unwrap();
        assert!(retired.withdrawn && retired.cancelled);
        assert_eq!(retired.in_flight, 1);
        bus.send(&sender, envelope(CHANNEL, 2)).await.unwrap();
        release.notify_one();
        wait_until(|| old.in_flight() == 0).await;
        old.dispose().await;
        new.dispose().await;
    }

    fn directory_snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        fn visit(root: &Path, path: &Path, entries: &mut Vec<(PathBuf, Vec<u8>)>) {
            let mut children = fs::read_dir(path)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect::<Vec<_>>();
            children.sort();
            for child in children {
                if child.is_dir() {
                    visit(root, &child, entries);
                } else {
                    entries.push((
                        child.strip_prefix(root).unwrap().to_path_buf(),
                        fs::read(child).unwrap(),
                    ));
                }
            }
        }
        let mut entries = Vec::new();
        visit(root, root, &mut entries);
        entries
    }

    #[tokio::test(flavor = "current_thread")]
    async fn instance_buses_are_isolated_and_delivery_does_not_touch_durable_roots() {
        let temporary = tempfile::tempdir().unwrap();
        let shared = temporary.path().join("shared");
        fs::create_dir_all(shared.join("state")).unwrap();
        fs::create_dir_all(shared.join("runtime")).unwrap();
        fs::write(shared.join("state/registry.json"), b"stable registry").unwrap();
        fs::write(shared.join("runtime/source.json"), b"stable source").unwrap();
        let before = directory_snapshot(&shared);

        let first_context = context("first", shared.clone());
        let second_context = context("second", shared.clone());
        let first_bus = RuntimeMessageBus::new(first_context.clone());
        let second_bus = RuntimeMessageBus::new(second_context.clone());
        let handled = Arc::new(AtomicU64::new(0));
        let first_registration = registration(
            &first_context,
            "fixture@first#one",
            declarations(&[CHANNEL], false, false),
            RegistrationHandlers::new().with_directed(CHANNEL, {
                let handled = Arc::clone(&handled);
                move |_| {
                    let handled = Arc::clone(&handled);
                    async move {
                        handled.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    }
                }
            }),
        );
        first_bus
            .register(Arc::clone(&first_registration))
            .await
            .unwrap();
        let sender = authority("sender", &[format!("message.send.{CHANNEL}")]);
        assert_eq!(
            second_bus
                .send(&sender, envelope(CHANNEL, 1))
                .await
                .unwrap_err()
                .code,
            NO_ACTIVE_CHANNEL_OWNER
        );
        let foreign = registration(
            &first_context,
            "fixture@foreign#one",
            declarations(&[SECOND_CHANNEL], false, false),
            RegistrationHandlers::new().with_directed(SECOND_CHANNEL, |_| async { Ok(()) }),
        );
        assert_eq!(
            second_bus.register(foreign).await.unwrap_err().code,
            NO_ACTIVE_CHANNEL_OWNER
        );
        first_bus.send(&sender, envelope(CHANNEL, 2)).await.unwrap();
        wait_until(|| handled.load(Ordering::SeqCst) == 1).await;
        assert_eq!(directory_snapshot(&shared), before);
        first_registration.dispose().await;
    }
}
