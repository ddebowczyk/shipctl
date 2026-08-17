//! Activation-owned scheduler registrations.
//!
//! This layer converts semantic requests into strict schedule sources. The
//! existing scheduler remains the sole clock, route-admission, and delivery
//! engine. Plugins never receive a filesystem path or timer primitive.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use shipctl_module_api::DurableWriteBarrier;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::message_bus::{
    MessageContractError, MessageRouteSnapshot, MessageTypeId, ModuleMessageAuthority,
    PreparedRegistration,
};

use super::{
    parse_schedule_source, ScheduleDefinition, ScheduleDeliveryObservation, ScheduleTarget,
    ScheduleTargetKind, SchedulerService, SCHEDULE_SCHEMA_VERSION,
};

pub const SCHEDULER_SERVICE_SCHEMA_VERSION: u32 = 1;
pub const SCHEDULER_REGISTER_GRANT: &str = "schedule.register";
pub const SCHEDULER_INVALID_REQUEST: &str = "scheduler.request.invalid";
pub const SCHEDULER_DENIED: &str = "scheduler.activation.denied";
pub const SCHEDULER_CONFLICT: &str = "scheduler.registration.conflict";
pub const SCHEDULER_TRANSPORT_FAILED: &str = "scheduler.transport.failed";

const LEASE_SOURCE_PREFIX: &str = "shipctl-lease-";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchedulerActor {
    pub module_id: String,
    pub activation_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleRegistrationEndpoint {
    pub id: String,
    pub message: MessageTypeId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleRegistrationTarget {
    pub kind: ScheduleTargetKind,
    pub endpoint: ScheduleRegistrationEndpoint,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterScheduleInput {
    pub schedule_id: String,
    pub cron: String,
    pub target: ScheduleRegistrationTarget,
    pub payload: Value,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleLeaseInspection {
    pub schema_version: u32,
    pub lease_id: String,
    pub owner_module_id: String,
    pub owner_activation_id: String,
    pub schedule_id: String,
    pub definition_digest_sha256: String,
    pub registered_at_unix_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledDeliveryEvent {
    pub schedule_id: String,
    pub occurrence_utc: String,
    pub outcome: super::contracts::ScheduleDeliveryOutcome,
    pub route_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<super::ScheduleDiagnostic>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchedulerDeliveryFrame {
    pub sequence: u64,
    pub event: ScheduledDeliveryEvent,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchedulerLeaseError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl SchedulerLeaseError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
        }
    }
}

impl std::fmt::Display for SchedulerLeaseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for SchedulerLeaseError {}

#[derive(Serialize)]
struct ScheduleSource<'a> {
    schema_version: u32,
    id: &'a str,
    enabled: bool,
    cron: &'a str,
    target: ScheduleTarget,
    message: ScheduleSourceMessage<'a>,
}

#[derive(Serialize)]
struct ScheduleSourceMessage<'a> {
    #[serde(rename = "type")]
    type_id: &'a str,
    version: u32,
    payload: &'a Value,
}

#[derive(Clone)]
enum LeaseSource {
    Durable(PathBuf),
    Declared(ScheduleDefinition),
}

#[derive(Clone)]
struct LeaseRecord {
    actor: SchedulerActor,
    inspection: ScheduleLeaseInspection,
    source: LeaseSource,
}

/// A module manifest schedule paired with the exact private bridge authority
/// that admitted its owning activation. This value is internal to the host
/// transaction; plugins never manufacture it or receive a timer primitive.
#[derive(Clone)]
pub struct DeclaredScheduleRegistration {
    pub actor: SchedulerActor,
    pub authority: ModuleMessageAuthority,
    pub input: RegisterScheduleInput,
}

struct Observer {
    activation_id: String,
    sequence: u64,
    send: Arc<dyn Fn(SchedulerDeliveryFrame) + Send + Sync>,
}

#[derive(Default)]
struct SchedulerLeaseState {
    leases: BTreeMap<Uuid, LeaseRecord>,
    schedule_owners: BTreeMap<String, Uuid>,
    observers: BTreeMap<Uuid, Observer>,
}

struct SchedulerLeaseInner {
    schedule_root: PathBuf,
    durable_writes: DurableWriteBarrier,
    state: Mutex<SchedulerLeaseState>,
    mutations: AsyncMutex<()>,
}

#[derive(Clone)]
pub struct SchedulerLeaseService {
    scheduler: SchedulerService,
    inner: Arc<SchedulerLeaseInner>,
}

impl SchedulerLeaseService {
    pub fn new(scheduler: SchedulerService, durable_writes: DurableWriteBarrier) -> Self {
        let inner = Arc::new(SchedulerLeaseInner {
            schedule_root: scheduler.schedule_root().to_path_buf(),
            durable_writes,
            state: Mutex::new(SchedulerLeaseState::default()),
            mutations: AsyncMutex::new(()),
        });
        let weak = Arc::downgrade(&inner);
        scheduler.observe_deliveries(move |observation| {
            publish_delivery(&weak, observation);
        });
        Self { scheduler, inner }
    }

    pub async fn register(
        &self,
        actor: SchedulerActor,
        authority: &ModuleMessageAuthority,
        input: RegisterScheduleInput,
    ) -> Result<ScheduleLeaseInspection, SchedulerLeaseError> {
        authorize_scheduler(&actor, authority)?;
        let _mutation = self.inner.mutations.lock().await;
        if self
            .inner
            .state
            .lock()
            .expect("scheduler lease state mutex must not be poisoned")
            .schedule_owners
            .contains_key(&input.schedule_id)
            || self
                .scheduler
                .accepted_snapshot()
                .definitions
                .iter()
                .any(|definition| definition.id == input.schedule_id)
        {
            return Err(SchedulerLeaseError::new(
                SCHEDULER_CONFLICT,
                "The schedule identity is already registered",
            ));
        }

        let lease_id = Uuid::new_v4();
        let source_name = format!("{LEASE_SOURCE_PREFIX}{lease_id}.yaml");
        let definition = source_definition(&source_name, &input)?;
        self.scheduler
            .preflight_definition(&definition)
            .await
            .map_err(|diagnostics| {
                let code = diagnostics
                    .first()
                    .map(|diagnostic| diagnostic.code.clone())
                    .unwrap_or_else(|| SCHEDULER_INVALID_REQUEST.to_string());
                SchedulerLeaseError::new(code, "The schedule target was rejected")
            })?;

        let source_path = self.inner.schedule_root.join(&source_name);
        write_source(
            &source_path,
            &source_yaml(&input)?,
            &self.inner.durable_writes,
        )?;
        let refresh = self.scheduler.refresh().await;
        if !refresh.applied
            || !refresh.snapshot.definitions.iter().any(|candidate| {
                candidate.id == input.schedule_id
                    && candidate.definition_digest_sha256 == definition.definition_digest_sha256
            })
        {
            let _ = retire_source(&source_path, &self.inner.durable_writes);
            self.scheduler.withdraw_schedule(&input.schedule_id).await;
            let code = refresh
                .diagnostics
                .first()
                .map(|diagnostic| diagnostic.code.clone())
                .unwrap_or_else(|| SCHEDULER_INVALID_REQUEST.to_string());
            return Err(SchedulerLeaseError::new(
                code,
                "The schedule definition was rejected",
            ));
        }

        let inspection = ScheduleLeaseInspection {
            schema_version: SCHEDULER_SERVICE_SCHEMA_VERSION,
            lease_id: lease_id.to_string(),
            owner_module_id: actor.module_id.clone(),
            owner_activation_id: actor.activation_id.clone(),
            schedule_id: input.schedule_id.clone(),
            definition_digest_sha256: definition.definition_digest_sha256,
            registered_at_unix_ms: unix_time_ms()?,
        };
        let mut state = self
            .inner
            .state
            .lock()
            .expect("scheduler lease state mutex must not be poisoned");
        state.schedule_owners.insert(input.schedule_id, lease_id);
        state.leases.insert(
            lease_id,
            LeaseRecord {
                actor,
                inspection: inspection.clone(),
                source: LeaseSource::Durable(source_path),
            },
        );
        Ok(inspection)
    }

    /// Atomically replaces manifest-declared schedules for the bridge
    /// activations being reconciled. These schedules are ephemeral: their
    /// durable source of truth is the admitted module artifact, not a lease
    /// YAML file. The scheduler and message routes therefore commit as one
    /// in-memory graph and restart reconstruction simply declares them again.
    pub async fn reconcile_declared(
        &self,
        expected_route_generation: u64,
        retired_activation_ids: &[String],
        registrations: Vec<Arc<PreparedRegistration>>,
        declarations: Vec<DeclaredScheduleRegistration>,
    ) -> Result<MessageRouteSnapshot, SchedulerLeaseError> {
        let _mutation = self.inner.mutations.lock().await;
        let retired = retired_activation_ids
            .iter()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let (mut leases, mut schedule_owners, retired_declarations) = {
            let state = self
                .inner
                .state
                .lock()
                .expect("scheduler lease state mutex must not be poisoned");
            let retired_declarations = state
                .leases
                .iter()
                .filter_map(|(lease_id, record)| {
                    (retired.contains(&record.actor.activation_id)
                        && matches!(record.source, LeaseSource::Declared(_)))
                    .then_some((*lease_id, record.clone()))
                })
                .collect::<BTreeMap<_, _>>();
            let leases = state
                .leases
                .iter()
                .filter(|(_, record)| {
                    !(retired.contains(&record.actor.activation_id)
                        && matches!(record.source, LeaseSource::Declared(_)))
                })
                .map(|(lease_id, record)| (*lease_id, record.clone()))
                .collect::<BTreeMap<_, _>>();
            let schedule_owners = leases
                .iter()
                .map(|(lease_id, record)| (record.inspection.schedule_id.clone(), *lease_id))
                .collect::<BTreeMap<_, _>>();
            (leases, schedule_owners, retired_declarations)
        };

        for declaration in declarations {
            authorize_scheduler(&declaration.actor, &declaration.authority)?;
            let source_name = format!("shipctl-declared-{}.yaml", Uuid::new_v4());
            let definition = source_definition(&source_name, &declaration.input)?;
            if schedule_owners.contains_key(&declaration.input.schedule_id) {
                return Err(SchedulerLeaseError::new(
                    SCHEDULER_CONFLICT,
                    "The schedule identity is already registered",
                ));
            }
            let retained = retired_declarations.values().find(|record| {
                record.actor == declaration.actor
                    && record.inspection.schedule_id == declaration.input.schedule_id
                    && matches!(
                        &record.source,
                        LeaseSource::Declared(previous)
                            if previous.definition_digest_sha256 == definition.definition_digest_sha256
                    )
            });
            let (lease_id, record) = match retained {
                Some(record) => {
                    let lease_id = Uuid::parse_str(&record.inspection.lease_id).map_err(|_| {
                        SchedulerLeaseError::new(
                            SCHEDULER_INVALID_REQUEST,
                            "The existing declared schedule identity is invalid",
                        )
                    })?;
                    (lease_id, record.clone())
                }
                None => {
                    let lease_id = Uuid::new_v4();
                    let inspection = ScheduleLeaseInspection {
                        schema_version: SCHEDULER_SERVICE_SCHEMA_VERSION,
                        lease_id: lease_id.to_string(),
                        owner_module_id: declaration.actor.module_id.clone(),
                        owner_activation_id: declaration.actor.activation_id.clone(),
                        schedule_id: declaration.input.schedule_id.clone(),
                        definition_digest_sha256: definition.definition_digest_sha256.clone(),
                        registered_at_unix_ms: unix_time_ms()?,
                    };
                    (
                        lease_id,
                        LeaseRecord {
                            actor: declaration.actor,
                            inspection,
                            source: LeaseSource::Declared(definition),
                        },
                    )
                }
            };
            schedule_owners.insert(declaration.input.schedule_id, lease_id);
            leases.insert(lease_id, record);
        }

        let runtime_definitions = runtime_definitions(&leases);
        let snapshot = self
            .scheduler
            .reconcile_runtime_definitions(
                expected_route_generation,
                retired_activation_ids,
                registrations,
                runtime_definitions,
            )
            .await
            .map_err(route_or_schedule_rejection)?;
        let mut state = self
            .inner
            .state
            .lock()
            .expect("scheduler lease state mutex must not be poisoned");
        state.leases = leases;
        state.schedule_owners = schedule_owners;
        Ok(snapshot)
    }

    fn runtime_definitions_without(
        &self,
        removed: &[Uuid],
    ) -> BTreeMap<String, ScheduleDefinition> {
        let removed = removed
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        let state = self
            .inner
            .state
            .lock()
            .expect("scheduler lease state mutex must not be poisoned");
        state
            .leases
            .iter()
            .filter(|(lease_id, _)| !removed.contains(lease_id))
            .filter_map(|(lease_id, record)| match &record.source {
                LeaseSource::Declared(definition) => {
                    Some((lease_id.to_string(), definition.clone()))
                }
                LeaseSource::Durable(_) => None,
            })
            .collect()
    }

    pub fn inspect(
        &self,
        actor: &SchedulerActor,
        authority: &ModuleMessageAuthority,
    ) -> Result<Vec<ScheduleLeaseInspection>, SchedulerLeaseError> {
        authorize_scheduler(actor, authority)?;
        let mut inspections = self
            .inner
            .state
            .lock()
            .expect("scheduler lease state mutex must not be poisoned")
            .leases
            .values()
            .filter(|record| record.actor.activation_id == actor.activation_id)
            .map(|record| record.inspection.clone())
            .collect::<Vec<_>>();
        inspections.sort_by(|left, right| left.schedule_id.cmp(&right.schedule_id));
        Ok(inspections)
    }

    pub async fn cancel(
        &self,
        actor: &SchedulerActor,
        authority: &ModuleMessageAuthority,
        lease_id: Uuid,
    ) -> Result<bool, SchedulerLeaseError> {
        authorize_scheduler(actor, authority)?;
        let _mutation = self.inner.mutations.lock().await;
        let record = {
            let state = self
                .inner
                .state
                .lock()
                .expect("scheduler lease state mutex must not be poisoned");
            let Some(record) = state.leases.get(&lease_id) else {
                return Ok(false);
            };
            if record.actor != *actor {
                return Err(SchedulerLeaseError::new(
                    SCHEDULER_DENIED,
                    "The schedule lease belongs to another activation",
                ));
            }
            (record.inspection.schedule_id.clone(), record.source.clone())
        };
        match &record.1 {
            LeaseSource::Durable(source_path) => {
                retire_source(source_path, &self.inner.durable_writes)?;
                self.scheduler.withdraw_schedule(&record.0).await;
            }
            LeaseSource::Declared(_) => {
                let definitions = self.runtime_definitions_without(&[lease_id]);
                self.scheduler
                    .replace_runtime_definitions(definitions)
                    .await
                    .map_err(schedule_rejection)?;
            }
        }
        let mut state = self
            .inner
            .state
            .lock()
            .expect("scheduler lease state mutex must not be poisoned");
        state.leases.remove(&lease_id);
        state.schedule_owners.remove(&record.0);
        Ok(true)
    }

    /// Releases every scheduler resource owned by one retired activation.
    ///
    /// This is a host lifecycle operation. It does not accept plugin authority:
    /// the caller must already have removed the activation from its admission
    /// boundary before invoking it.
    pub async fn release_activation(
        &self,
        activation_id: &str,
    ) -> Result<usize, SchedulerLeaseError> {
        let _mutation = self.inner.mutations.lock().await;
        let lease_ids = self
            .inner
            .state
            .lock()
            .expect("scheduler lease state mutex must not be poisoned")
            .leases
            .iter()
            .filter_map(|(lease_id, record)| {
                (record.actor.activation_id == activation_id).then_some(*lease_id)
            })
            .collect::<Vec<_>>();
        let declared_ids = {
            let state = self
                .inner
                .state
                .lock()
                .expect("scheduler lease state mutex must not be poisoned");
            lease_ids
                .iter()
                .filter(|lease_id| {
                    matches!(
                        state.leases.get(lease_id).map(|record| &record.source),
                        Some(LeaseSource::Declared(_))
                    )
                })
                .copied()
                .collect::<Vec<_>>()
        };
        if !declared_ids.is_empty() {
            self.scheduler
                .replace_runtime_definitions(self.runtime_definitions_without(&declared_ids))
                .await
                .map_err(schedule_rejection)?;
        }
        let mut released = 0;
        let mut first_error = None;
        for lease_id in lease_ids {
            let record = self
                .inner
                .state
                .lock()
                .expect("scheduler lease state mutex must not be poisoned")
                .leases
                .get(&lease_id)
                .map(|record| (record.inspection.schedule_id.clone(), record.source.clone()));
            let Some((schedule_id, source)) = record else {
                continue;
            };
            if let LeaseSource::Durable(source_path) = source {
                if let Err(error) = retire_source(&source_path, &self.inner.durable_writes) {
                    first_error.get_or_insert(error);
                    continue;
                }
                self.scheduler.withdraw_schedule(&schedule_id).await;
            }
            let mut state = self
                .inner
                .state
                .lock()
                .expect("scheduler lease state mutex must not be poisoned");
            state.leases.remove(&lease_id);
            state.schedule_owners.remove(&schedule_id);
            released += 1;
        }
        self.inner
            .state
            .lock()
            .expect("scheduler lease state mutex must not be poisoned")
            .observers
            .retain(|_, observer| observer.activation_id != activation_id);
        match first_error {
            Some(error) => Err(error),
            None => Ok(released),
        }
    }

    pub fn observe(
        &self,
        actor: &SchedulerActor,
        authority: &ModuleMessageAuthority,
        send: impl Fn(SchedulerDeliveryFrame) + Send + Sync + 'static,
    ) -> Result<Uuid, SchedulerLeaseError> {
        authorize_scheduler(actor, authority)?;
        let observer_id = Uuid::new_v4();
        self.inner
            .state
            .lock()
            .expect("scheduler lease state mutex must not be poisoned")
            .observers
            .insert(
                observer_id,
                Observer {
                    activation_id: actor.activation_id.clone(),
                    sequence: 0,
                    send: Arc::new(send),
                },
            );
        Ok(observer_id)
    }

    pub fn stop_observing(
        &self,
        actor: &SchedulerActor,
        authority: &ModuleMessageAuthority,
        observer_id: Uuid,
    ) -> Result<bool, SchedulerLeaseError> {
        authorize_scheduler(actor, authority)?;
        let mut state = self
            .inner
            .state
            .lock()
            .expect("scheduler lease state mutex must not be poisoned");
        let Some(observer) = state.observers.get(&observer_id) else {
            return Ok(false);
        };
        if observer.activation_id != actor.activation_id {
            return Err(SchedulerLeaseError::new(
                SCHEDULER_DENIED,
                "The scheduler observer belongs to another activation",
            ));
        }
        state.observers.remove(&observer_id);
        Ok(true)
    }
}

pub fn purge_stale_lease_sources(
    schedule_root: &Path,
    durable_writes: &DurableWriteBarrier,
) -> Result<usize, SchedulerLeaseError> {
    let metadata = match fs::symlink_metadata(schedule_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(_) => return Err(storage_error("Could not inspect the schedule directory")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(storage_error("The schedule directory is unsafe"));
    }
    let _update = durable_writes.enter_update().map_err(|_| {
        storage_error("The durable write barrier could not admit scheduler cleanup")
    })?;
    let mut removed = 0;
    for entry in fs::read_dir(schedule_root)
        .map_err(|_| storage_error("Could not read the schedule directory"))?
    {
        let entry = entry.map_err(|_| storage_error("Could not read a schedule entry"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(LEASE_SOURCE_PREFIX) && name.ends_with(".yaml") {
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|_| storage_error("Could not inspect a scheduler lease source"))?;
            if metadata.is_file() && !metadata.file_type().is_symlink() {
                fs::remove_file(entry.path())
                    .map_err(|_| storage_error("Could not remove a stale scheduler lease"))?;
                removed += 1;
            }
        }
    }
    Ok(removed)
}

fn authorize_actor(
    actor: &SchedulerActor,
    authority: &ModuleMessageAuthority,
) -> Result<(), SchedulerLeaseError> {
    if actor.module_id.trim().is_empty()
        || actor.activation_id.trim().is_empty()
        || authority.activation_id() != actor.activation_id
    {
        return Err(SchedulerLeaseError::new(
            SCHEDULER_DENIED,
            "The scheduler actor does not match the bridge activation",
        ));
    }
    Ok(())
}

fn runtime_definitions(
    leases: &BTreeMap<Uuid, LeaseRecord>,
) -> BTreeMap<String, ScheduleDefinition> {
    leases
        .iter()
        .filter_map(|(lease_id, record)| match &record.source {
            LeaseSource::Declared(definition) => Some((lease_id.to_string(), definition.clone())),
            LeaseSource::Durable(_) => None,
        })
        .collect()
}

fn route_or_schedule_rejection(error: MessageContractError) -> SchedulerLeaseError {
    SchedulerLeaseError::new(error.code, "The route-and-schedule candidate was rejected")
}

fn schedule_rejection(diagnostics: Vec<super::ScheduleDiagnostic>) -> SchedulerLeaseError {
    let code = diagnostics
        .first()
        .map(|diagnostic| diagnostic.code.clone())
        .unwrap_or_else(|| SCHEDULER_INVALID_REQUEST.to_string());
    SchedulerLeaseError::new(code, "The schedule candidate was rejected")
}

fn authorize_scheduler(
    actor: &SchedulerActor,
    authority: &ModuleMessageAuthority,
) -> Result<(), SchedulerLeaseError> {
    authorize_actor(actor, authority)?;
    authority.authorize(SCHEDULER_REGISTER_GRANT).map_err(|_| {
        SchedulerLeaseError::new(
            SCHEDULER_DENIED,
            "The activation lacks the schedule registration grant",
        )
    })
}

fn source_definition(
    source_name: &str,
    input: &RegisterScheduleInput,
) -> Result<ScheduleDefinition, SchedulerLeaseError> {
    parse_schedule_source(Path::new(source_name), &source_yaml(input)?)
        .map_err(|error| SchedulerLeaseError::new(error.code, "The schedule definition is invalid"))
}

fn source_yaml(input: &RegisterScheduleInput) -> Result<String, SchedulerLeaseError> {
    serde_yaml::to_string(&ScheduleSource {
        schema_version: SCHEDULE_SCHEMA_VERSION,
        id: &input.schedule_id,
        enabled: true,
        cron: &input.cron,
        target: ScheduleTarget {
            kind: input.target.kind.clone(),
            id: input.target.endpoint.id.clone(),
        },
        message: ScheduleSourceMessage {
            type_id: &input.target.endpoint.message.id,
            version: input.target.endpoint.message.version,
            payload: &input.payload,
        },
    })
    .map_err(|_| storage_error("The schedule definition could not be encoded"))
}

fn write_source(
    path: &Path,
    source: &str,
    durable_writes: &DurableWriteBarrier,
) -> Result<(), SchedulerLeaseError> {
    let root = path
        .parent()
        .ok_or_else(|| storage_error("The schedule source has no parent directory"))?;
    let _update = durable_writes.enter_update().map_err(|_| {
        storage_error("The durable write barrier could not admit schedule registration")
    })?;
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(storage_error("The schedule directory is unsafe"));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(root)
                .map_err(|_| storage_error("Could not create the schedule directory"))?;
        }
        Err(_) => return Err(storage_error("Could not inspect the schedule directory")),
    }
    let temporary = root.join(format!(".schedule-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        fs::write(&temporary, source)
            .map_err(|_| storage_error("Could not stage the schedule definition"))?;
        fs::rename(&temporary, path)
            .map_err(|_| storage_error("Could not publish the schedule definition"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn retire_source(
    path: &Path,
    durable_writes: &DurableWriteBarrier,
) -> Result<(), SchedulerLeaseError> {
    let _update = durable_writes.enter_update().map_err(|_| {
        storage_error("The durable write barrier could not admit schedule cancellation")
    })?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            let retired = path.with_extension(format!("retired-{}", Uuid::new_v4()));
            fs::rename(path, &retired)
                .map_err(|_| storage_error("Could not retire the schedule definition"))?;
            fs::remove_file(retired)
                .map_err(|_| storage_error("Could not remove the retired schedule definition"))?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(storage_error("The schedule definition is unsafe")),
    }
}

fn publish_delivery(inner: &Weak<SchedulerLeaseInner>, observation: ScheduleDeliveryObservation) {
    let Some(inner) = inner.upgrade() else {
        return;
    };
    let event = ScheduledDeliveryEvent {
        schedule_id: observation.schedule_id,
        occurrence_utc: observation.delivery.occurrence_utc,
        outcome: observation.delivery.outcome,
        route_generation: observation.delivery.route_generation,
        diagnostic: observation.delivery.diagnostic,
    };
    let deliveries = {
        let mut state = inner
            .state
            .lock()
            .expect("scheduler lease state mutex must not be poisoned");
        let Some(lease_id) = state.schedule_owners.get(&event.schedule_id).copied() else {
            return;
        };
        let Some(activation_id) = state
            .leases
            .get(&lease_id)
            .map(|record| record.actor.activation_id.clone())
        else {
            return;
        };
        state
            .observers
            .values_mut()
            .filter_map(|observer| {
                if observer.activation_id != activation_id {
                    return None;
                }
                observer.sequence = observer
                    .sequence
                    .checked_add(1)
                    .expect("scheduler delivery sequence overflow");
                Some((
                    Arc::clone(&observer.send),
                    SchedulerDeliveryFrame {
                        sequence: observer.sequence,
                        event: event.clone(),
                    },
                ))
            })
            .collect::<Vec<_>>()
    };
    for (send, frame) in deliveries {
        send(frame);
    }
}

fn unix_time_ms() -> Result<u64, SchedulerLeaseError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|_| storage_error("The system clock is before the Unix epoch"))
}

fn storage_error(message: &'static str) -> SchedulerLeaseError {
    SchedulerLeaseError::new(SCHEDULER_TRANSPORT_FAILED, message)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    use serde_json::json;
    use tempfile::{tempdir, TempDir};

    use crate::instance::{InstanceBuildIdentity, InstanceContext, LaunchProvenance, RootSource};
    use crate::message_bus::{
        DirectedChannelDeclaration, MessageDeclarations, MessageSchemaDescriptor,
        MessageTypeContract, PreparedRegistration, RegistrationHandlers, RouteEndpointRef,
        RuntimeMessageBus, MESSAGE_CONTRACT_SCHEMA_VERSION,
    };
    use crate::module_control::ModuleGrant;
    use crate::scheduler::contracts::{ScheduleDeliveryOutcome, ScheduleDeliverySummary};

    use super::*;

    const MESSAGE_ID: &str = "fixture.schedule-fired";
    const ENDPOINT_ID: &str = "fixture.schedule-target";
    const JSON_SCHEMA_DRAFT: &str = "https://json-schema.org/draft/2020-12/schema";

    struct Fixture {
        _temporary: TempDir,
        scheduler: SchedulerService,
        leases: SchedulerLeaseService,
        schedule_root: PathBuf,
    }

    impl Fixture {
        async fn new() -> Self {
            let temporary = tempdir().unwrap();
            let context = InstanceContext {
                instance_id: Uuid::new_v4(),
                name: "scheduler-leases".to_string(),
                state_root: temporary.path().to_path_buf(),
                runtime_root: temporary.path().join("runtime"),
                state_root_source: RootSource::Explicit,
                runtime_root_source: RootSource::Explicit,
                build: InstanceBuildIdentity {
                    app_version: "test".to_string(),
                    control_protocol_version: 1,
                },
                launch_provenance: LaunchProvenance::DirectUi,
            };
            let schedule_root = context.paths().schedule_root;
            let bus = RuntimeMessageBus::new(context.clone());
            let registration = Arc::new(
                PreparedRegistration::prepare(
                    &context,
                    "fixture@handler#one",
                    &[] as &[ModuleGrant],
                    message_declarations(),
                    RegistrationHandlers::new().with_directed(ENDPOINT_ID, |_| async { Ok(()) }),
                )
                .unwrap(),
            );
            bus.register(registration).await.unwrap();
            let scheduler = SchedulerService::new(context, &schedule_root, bus).unwrap();
            let leases =
                SchedulerLeaseService::new(scheduler.clone(), DurableWriteBarrier::default());
            Self {
                _temporary: temporary,
                scheduler,
                leases,
                schedule_root,
            }
        }
    }

    fn message_declarations() -> MessageDeclarations {
        let message = MessageTypeId {
            id: MESSAGE_ID.to_string(),
            version: 1,
        };
        let root = "schemas/schedule-fired.json".to_string();
        MessageDeclarations {
            schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
            provides: vec![MessageTypeContract {
                message: message.clone(),
                schema: MessageSchemaDescriptor {
                    draft: JSON_SCHEMA_DRAFT.to_string(),
                    root: root.clone(),
                    resources: BTreeMap::from([(
                        root.clone(),
                        json!({
                            "$schema": JSON_SCHEMA_DRAFT,
                            "$id": format!("shipctl-artifact:///{root}"),
                            "type": "object",
                            "additionalProperties": false
                        }),
                    )]),
                    max_encoded_bytes: 256,
                    redacted_fields: Vec::new(),
                    compatible_versions: vec![1],
                },
            }],
            handles: vec![DirectedChannelDeclaration {
                endpoint: RouteEndpointRef {
                    id: ENDPOINT_ID.to_string(),
                    message,
                },
                capacity: 2,
                required_grant: format!("message.send.{ENDPOINT_ID}"),
                scheduler_allowed: true,
            }],
            publishes: Vec::new(),
            subscribes: Vec::new(),
            ports: Vec::new(),
        }
    }

    fn actor(activation_id: &str) -> SchedulerActor {
        SchedulerActor {
            module_id: "shipctl.fixture".to_string(),
            activation_id: activation_id.to_string(),
        }
    }

    fn authority(activation_id: &str, effective: bool) -> ModuleMessageAuthority {
        ModuleMessageAuthority::from_host(
            activation_id,
            &[ModuleGrant {
                id: SCHEDULER_REGISTER_GRANT.to_string(),
                effective,
            }],
        )
    }

    fn registration(schedule_id: &str) -> RegisterScheduleInput {
        RegisterScheduleInput {
            schedule_id: schedule_id.to_string(),
            cron: "* * * * * Etc/UTC".to_string(),
            target: ScheduleRegistrationTarget {
                kind: ScheduleTargetKind::Channel,
                endpoint: ScheduleRegistrationEndpoint {
                    id: ENDPOINT_ID.to_string(),
                    message: MessageTypeId {
                        id: MESSAGE_ID.to_string(),
                        version: 1,
                    },
                },
            },
            payload: json!({}),
        }
    }

    #[tokio::test]
    async fn denied_registration_has_no_persistent_or_accepted_side_effect() {
        let fixture = Fixture::new().await;
        let activation = actor("fixture@activation#denied");
        let error = fixture
            .leases
            .register(
                activation.clone(),
                &authority(&activation.activation_id, false),
                registration("fixture.denied"),
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, SCHEDULER_DENIED);
        assert!(fixture.scheduler.accepted_snapshot().definitions.is_empty());
        assert!(!fixture.schedule_root.exists());
    }

    #[tokio::test]
    async fn registration_is_activation_scoped_conflict_safe_and_cancellable() {
        let fixture = Fixture::new().await;
        let owner = actor("fixture@activation#owner");
        let owner_authority = authority(&owner.activation_id, true);
        let lease = fixture
            .leases
            .register(
                owner.clone(),
                &owner_authority,
                registration("fixture.periodic"),
            )
            .await
            .unwrap();

        assert_eq!(
            fixture.leases.inspect(&owner, &owner_authority).unwrap(),
            vec![lease.clone()]
        );
        let stranger = actor("fixture@activation#stranger");
        let stranger_authority = authority(&stranger.activation_id, true);
        assert!(fixture
            .leases
            .inspect(&stranger, &stranger_authority)
            .unwrap()
            .is_empty());
        let conflict = fixture
            .leases
            .register(
                stranger.clone(),
                &stranger_authority,
                registration("fixture.periodic"),
            )
            .await
            .unwrap_err();
        assert_eq!(conflict.code, SCHEDULER_CONFLICT);
        let denied = fixture
            .leases
            .cancel(
                &stranger,
                &stranger_authority,
                Uuid::parse_str(&lease.lease_id).unwrap(),
            )
            .await
            .unwrap_err();
        assert_eq!(denied.code, SCHEDULER_DENIED);

        fs::write(
            fixture.schedule_root.join("unrelated-invalid.yaml"),
            "not: [yaml",
        )
        .unwrap();
        assert!(fixture
            .leases
            .cancel(
                &owner,
                &owner_authority,
                Uuid::parse_str(&lease.lease_id).unwrap(),
            )
            .await
            .unwrap());
        assert!(fixture.scheduler.accepted_snapshot().definitions.is_empty());
        assert!(fixture
            .schedule_root
            .join("unrelated-invalid.yaml")
            .exists());
        assert!(!fixture
            .leases
            .cancel(
                &owner,
                &owner_authority,
                Uuid::parse_str(&lease.lease_id).unwrap(),
            )
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn delivery_observation_is_ordered_and_stops_with_activation_release() {
        let fixture = Fixture::new().await;
        let owner = actor("fixture@activation#observed");
        let owner_authority = authority(&owner.activation_id, true);
        fixture
            .leases
            .register(
                owner.clone(),
                &owner_authority,
                registration("fixture.observed"),
            )
            .await
            .unwrap();
        let frames = Arc::new(Mutex::new(Vec::new()));
        let received = Arc::clone(&frames);
        fixture
            .leases
            .observe(&owner, &owner_authority, move |frame| {
                received.lock().unwrap().push(frame);
            })
            .unwrap();

        for minute in ["00", "01"] {
            publish_delivery(
                &Arc::downgrade(&fixture.leases.inner),
                ScheduleDeliveryObservation {
                    schedule_id: "fixture.observed".to_string(),
                    delivery: ScheduleDeliverySummary {
                        occurrence_utc: format!("2026-08-16T12:{minute}:00Z"),
                        outcome: ScheduleDeliveryOutcome::Delivered,
                        route_generation: 1,
                        diagnostic: None,
                    },
                },
            );
        }
        assert_eq!(
            frames
                .lock()
                .unwrap()
                .iter()
                .map(|frame| frame.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );

        assert_eq!(
            fixture
                .leases
                .release_activation(&owner.activation_id)
                .await
                .unwrap(),
            1
        );
        publish_delivery(
            &Arc::downgrade(&fixture.leases.inner),
            ScheduleDeliveryObservation {
                schedule_id: "fixture.observed".to_string(),
                delivery: ScheduleDeliverySummary {
                    occurrence_utc: "2026-08-16T12:02:00Z".to_string(),
                    outcome: ScheduleDeliveryOutcome::Delivered,
                    route_generation: 1,
                    diagnostic: None,
                },
            },
        );
        assert_eq!(frames.lock().unwrap().len(), 2);
        assert!(fixture.scheduler.accepted_snapshot().definitions.is_empty());
        assert!(fixture
            .leases
            .inspect(&owner, &owner_authority)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn stale_source_cleanup_removes_only_managed_regular_files() {
        let temporary = tempdir().unwrap();
        let root = temporary.path().join("schedules");
        fs::create_dir(&root).unwrap();
        let stale = root.join(format!("{LEASE_SOURCE_PREFIX}{}.yaml", Uuid::new_v4()));
        let retained = root.join("user-schedule.yaml");
        fs::write(&stale, "stale").unwrap();
        fs::write(&retained, "user").unwrap();

        assert_eq!(
            purge_stale_lease_sources(&root, &DurableWriteBarrier::default()).unwrap(),
            1
        );
        assert!(!stale.exists());
        assert!(retained.exists());
    }
}
