//! Atomic in-memory schedule refresh for one running instance.
//!
//! This module owns accepted configuration state only. It deliberately does
//! not create timers, jobs, delivery authority, filesystem watchers, or
//! persistence. Those belong to later scheduler stages.

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use cronexpr::jiff::Timestamp;
use tokio::sync::{watch, Mutex as AsyncMutex};

use crate::instance::InstanceContext;
use crate::message_bus::{
    MessageEnvelope, MessageTypeId, RuntimeMessageBus, SchedulerPreflightError,
    SchedulerPreflightRequest, SchedulerPreflightSnapshot, SchedulerPreflightTargetKind,
    MESSAGE_CONTRACT_SCHEMA_VERSION,
};

use super::contracts::{
    schedule_snapshot, ScheduleDefinition, ScheduleInspection, ScheduleSnapshot,
    ScheduleTargetAvailability, ScheduleTargetKind, SCHEDULE_INSPECTION_SCHEMA_VERSION,
};
use super::diagnostics::{
    CRON_INVALID, NEXT_OCCURRENCE_UNAVAILABLE, PAYLOAD_INVALID, PAYLOAD_TOO_LARGE,
    SECRET_PAYLOAD_FORBIDDEN, TARGET_MESSAGE_INCOMPATIBLE, TARGET_UNAUTHORIZED, TARGET_UNAVAILABLE,
};
use super::loader::{load_schedule_candidate, ScheduleLoadCandidate};
use super::{ScheduleDiagnostic, ScheduleDiagnosticSeverity};

/// The result of one explicit or initial schedule refresh attempt.
///
/// `snapshot` is always the currently accepted snapshot. A rejected candidate
/// therefore leaves both the returned and subsequently inspected snapshot
/// unchanged while exposing its redacted diagnostics.
#[derive(Clone, Debug, PartialEq)]
pub struct ScheduleRefreshResult {
    pub applied: bool,
    pub snapshot: ScheduleSnapshot,
    pub diagnostics: Vec<ScheduleDiagnostic>,
}

/// Construction rejects accidental cross-instance composition before any
/// schedule source is read or published.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SchedulerServiceError {
    MessageBusInstanceMismatch,
    ScheduleRootMismatch,
}

impl fmt::Display for SchedulerServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MessageBusInstanceMismatch => {
                formatter.write_str("scheduler service context does not match its message bus")
            }
            Self::ScheduleRootMismatch => {
                formatter.write_str("scheduler service root does not match its instance state root")
            }
        }
    }
}

impl std::error::Error for SchedulerServiceError {}

/// One accepted scheduler snapshot and the exact message-route identity that
/// validated it. This is the watch value consumed by later job ownership; it
/// cannot observe a new definition set without its matching bus generation.
#[derive(Clone, Debug, PartialEq)]
pub struct AcceptedScheduleSnapshot {
    pub snapshot: ScheduleSnapshot,
    pub instance_id: String,
    pub incarnation: String,
    pub bus_route_generation: u64,
    /// Definitions removed by this atomic transition. S3 consumes this intent
    /// to cancel existing jobs without having to reinterpret a source diff.
    pub removed_schedule_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SchedulerRouteBinding {
    instance_id: String,
    incarnation: String,
    route_generation: u64,
}

impl From<SchedulerPreflightSnapshot> for SchedulerRouteBinding {
    fn from(snapshot: SchedulerPreflightSnapshot) -> Self {
        Self {
            instance_id: snapshot.instance_id().to_string(),
            incarnation: snapshot.incarnation().to_string(),
            route_generation: snapshot.route_generation(),
        }
    }
}

#[derive(Clone, Debug)]
struct SchedulerState {
    snapshot: ScheduleSnapshot,
    binding: Option<SchedulerRouteBinding>,
    diagnostics: Vec<ScheduleDiagnostic>,
    next_occurrences: BTreeMap<String, Option<String>>,
}

#[derive(Debug, Default)]
struct StartupState {
    started: bool,
    candidate: Option<ScheduleLoadCandidate>,
}

struct SchedulerServiceInner {
    context: InstanceContext,
    schedule_root: PathBuf,
    bus: RuntimeMessageBus,
    refresh: AsyncMutex<()>,
    state: Mutex<SchedulerState>,
    snapshots: watch::Sender<Arc<AcceptedScheduleSnapshot>>,
    startup: Mutex<StartupState>,
}

/// Instance-local schedule configuration service.
///
/// Constructing the service reads the schedule directory once without
/// accepting it. The first non-empty bridge route snapshot may then accept
/// that retained candidate. Subsequent source changes require [`Self::refresh`].
#[derive(Clone)]
pub struct SchedulerService {
    inner: Arc<SchedulerServiceInner>,
}

impl SchedulerService {
    pub fn new(
        context: InstanceContext,
        schedule_root: impl Into<PathBuf>,
        bus: RuntimeMessageBus,
    ) -> Result<Self, SchedulerServiceError> {
        let schedule_root = schedule_root.into();
        if bus.context() != &context {
            return Err(SchedulerServiceError::MessageBusInstanceMismatch);
        }
        if schedule_root != context.paths().schedule_root {
            return Err(SchedulerServiceError::ScheduleRootMismatch);
        }
        let initial_snapshot = schedule_snapshot(0, Vec::new())
            .expect("an empty scheduler snapshot is always canonical");
        let initial_binding = SchedulerRouteBinding {
            instance_id: context.name.clone(),
            incarnation: context.instance_id.to_string(),
            route_generation: 0,
        };
        let candidate = load_schedule_candidate(&schedule_root);
        let diagnostics = initial_diagnostics(&candidate);
        let startup_candidate = candidate.is_valid().then_some(candidate);
        let (snapshots, _) = watch::channel(Arc::new(AcceptedScheduleSnapshot {
            snapshot: initial_snapshot.clone(),
            instance_id: initial_binding.instance_id.clone(),
            incarnation: initial_binding.incarnation.clone(),
            bus_route_generation: initial_binding.route_generation,
            removed_schedule_ids: Vec::new(),
        }));

        Ok(Self {
            inner: Arc::new(SchedulerServiceInner {
                context,
                schedule_root,
                bus,
                refresh: AsyncMutex::new(()),
                state: Mutex::new(SchedulerState {
                    snapshot: initial_snapshot,
                    // Generation zero is the immutable empty baseline. It is
                    // not a successful target preflight, but its route
                    // identity must remain explicit so inspection never
                    // claims a later bridge generation for unaccepted state.
                    binding: Some(initial_binding),
                    diagnostics,
                    next_occurrences: BTreeMap::new(),
                }),
                snapshots,
                startup: Mutex::new(StartupState {
                    started: false,
                    candidate: startup_candidate,
                }),
            }),
        })
    }

    /// Returns the root whose direct YAML files are read by this instance.
    pub fn schedule_root(&self) -> &Path {
        &self.inner.schedule_root
    }

    /// Returns the immutable accepted snapshot, not the files currently on
    /// disk. This is useful to callers that need a digest without an
    /// inspection projection.
    pub fn accepted_snapshot(&self) -> ScheduleSnapshot {
        self.inner
            .state
            .lock()
            .expect("scheduler state mutex must not be poisoned")
            .snapshot
            .clone()
    }

    /// Subscribes to accepted-snapshot publications. Rejected candidates never
    /// send on this channel.
    pub fn subscribe_snapshots(&self) -> watch::Receiver<Arc<AcceptedScheduleSnapshot>> {
        self.inner.snapshots.subscribe()
    }

    /// Produces an inspection projection of the accepted state plus the most
    /// recent redacted candidate diagnostics.
    pub fn inspect(&self) -> ScheduleInspection {
        let routes = self.inner.bus.snapshot();
        let state = self
            .inner
            .state
            .lock()
            .expect("scheduler state mutex must not be poisoned");
        let binding = state.binding.as_ref();
        let bus_route_generation = binding
            .map(|value| value.route_generation)
            .unwrap_or(routes.route_generation);
        let mut inspection = state.snapshot.inspection(
            self.inner.context.name.clone(),
            self.inner.context.instance_id.to_string(),
            bus_route_generation,
        );
        let binding_is_current = binding.is_some_and(|value| {
            value.instance_id == routes.instance_id
                && value.incarnation == routes.incarnation
                && value.route_generation == routes.route_generation
        });
        for schedule in &mut inspection.schedules {
            schedule.next_occurrence_utc =
                state.next_occurrences.get(&schedule.id).cloned().flatten();
            schedule.target_availability = if binding_is_current {
                ScheduleTargetAvailability::Available
            } else {
                ScheduleTargetAvailability::Unknown
            };
        }
        inspection.diagnostics = state.diagnostics.clone();
        inspection
    }

    /// Begins exactly one initial route-readiness attempt.
    ///
    /// The message bridge is opened by the frontend after Tauri setup, so a
    /// service starts against route generation zero. We retain the startup
    /// candidate and wait for the first nonzero publication rather than
    /// accepting unvalidated source configuration. This is intentionally not
    /// a watcher or a retry loop.
    pub fn start_initial_route_refresh(&self) {
        let should_start = {
            let mut startup = self
                .inner
                .startup
                .lock()
                .expect("scheduler startup mutex must not be poisoned");
            if startup.started {
                false
            } else {
                startup.started = true;
                startup.candidate.is_some()
            }
        };
        if !should_start {
            return;
        }

        let service = self.clone();
        let mut routes = self.inner.bus.subscribe_snapshots();
        tokio::spawn(async move {
            let route_ready = if routes.borrow().route_generation > 0 {
                true
            } else {
                loop {
                    match routes.changed().await {
                        Ok(()) if routes.borrow().route_generation > 0 => break true,
                        Ok(()) => continue,
                        Err(_) => break false,
                    }
                }
            };
            if route_ready {
                service.apply_initial_candidate().await;
            }
        });
    }

    /// Re-reads the complete directory and atomically replaces accepted state
    /// only after a successful whole-candidate route preflight.
    pub async fn refresh(&self) -> ScheduleRefreshResult {
        let _refresh = self.inner.refresh.lock().await;
        // An explicit refresh supersedes a source snapshot retained before the
        // bridge first became ready. It must never be overwritten later.
        self.inner
            .startup
            .lock()
            .expect("scheduler startup mutex must not be poisoned")
            .candidate = None;
        let candidate = load_schedule_candidate(&self.inner.schedule_root);
        self.apply_candidate_locked(candidate).await
    }

    /// Test-only seam for proving that a candidate prepared before a route
    /// change is revalidated inside normal instance refresh serialization.
    /// Production callers always use [`Self::refresh`] or startup loading.
    #[cfg(test)]
    async fn apply_prepared_candidate(
        &self,
        candidate: ScheduleLoadCandidate,
    ) -> ScheduleRefreshResult {
        let _refresh = self.inner.refresh.lock().await;
        self.apply_candidate_locked(candidate).await
    }

    async fn apply_initial_candidate(&self) {
        let _refresh = self.inner.refresh.lock().await;
        let candidate = self
            .inner
            .startup
            .lock()
            .expect("scheduler startup mutex must not be poisoned")
            .candidate
            .take();
        if let Some(candidate) = candidate {
            let _ = self.apply_candidate_locked(candidate).await;
        }
    }

    async fn apply_candidate_locked(
        &self,
        candidate: ScheduleLoadCandidate,
    ) -> ScheduleRefreshResult {
        let definitions = match candidate.into_validated_definitions() {
            Ok(definitions) => definitions,
            Err(diagnostics) => return self.reject(diagnostics),
        };
        let requests = definitions
            .iter()
            .map(preflight_request)
            .collect::<Vec<_>>();

        let publication = self
            .inner
            .bus
            .with_scheduler_preflight_all(&requests, |preflight| -> Result<_, Vec<_>> {
                // The bus update lock is held across this synchronous
                // callback. Publishing the scheduler watch value here binds
                // accepted state to exactly the route generation preflighted.
                // Calculate at this publication point so every enabled
                // definition retains a strictly future occurrence even if a
                // refresh waited for a concurrent route update.
                let next_occurrences = next_occurrences(&definitions, Timestamp::now())?;
                let mut state = self
                    .inner
                    .state
                    .lock()
                    .expect("scheduler state mutex must not be poisoned");
                let generation = state
                    .snapshot
                    .generation
                    .checked_add(1)
                    .expect("scheduler generation overflow");
                let removed_schedule_ids = state
                    .snapshot
                    .definitions
                    .iter()
                    .filter(|accepted| {
                        !definitions
                            .iter()
                            .any(|candidate| candidate.id == accepted.id)
                    })
                    .map(|definition| definition.id.clone())
                    .collect::<Vec<_>>();
                let snapshot = schedule_snapshot(generation, definitions.clone())
                    .expect("validated schedule candidates cannot fail canonicalization");
                state.snapshot = snapshot.clone();
                let binding = SchedulerRouteBinding::from(preflight);
                state.binding = Some(binding.clone());
                state.diagnostics.clear();
                state.next_occurrences = next_occurrences.clone();
                self.inner
                    .snapshots
                    .send_replace(Arc::new(AcceptedScheduleSnapshot {
                        snapshot: snapshot.clone(),
                        instance_id: binding.instance_id,
                        incarnation: binding.incarnation,
                        bus_route_generation: binding.route_generation,
                        removed_schedule_ids,
                    }));
                Ok(snapshot)
            })
            .await;

        match publication {
            Ok(Ok(snapshot)) => ScheduleRefreshResult {
                applied: true,
                snapshot,
                diagnostics: Vec::new(),
            },
            Ok(Err(diagnostics)) => self.reject(diagnostics),
            Err(errors) => self.reject(preflight_diagnostics(&definitions, errors)),
        }
    }

    fn reject(&self, mut diagnostics: Vec<ScheduleDiagnostic>) -> ScheduleRefreshResult {
        sort_diagnostics(&mut diagnostics);
        let snapshot = {
            let mut state = self
                .inner
                .state
                .lock()
                .expect("scheduler state mutex must not be poisoned");
            state.diagnostics = diagnostics.clone();
            state.snapshot.clone()
        };
        ScheduleRefreshResult {
            applied: false,
            snapshot,
            diagnostics,
        }
    }
}

fn initial_diagnostics(candidate: &ScheduleLoadCandidate) -> Vec<ScheduleDiagnostic> {
    if !candidate.is_valid() {
        return candidate.diagnostics().to_vec();
    }
    let mut diagnostics = candidate
        .validated_definitions()
        .expect("valid schedule candidate must expose definitions")
        .iter()
        .map(|definition| diagnostic_for_definition(TARGET_UNAVAILABLE, definition))
        .collect::<Vec<_>>();
    sort_diagnostics(&mut diagnostics);
    diagnostics
}

fn preflight_request(definition: &ScheduleDefinition) -> SchedulerPreflightRequest {
    SchedulerPreflightRequest {
        target_kind: match definition.target.kind {
            ScheduleTargetKind::Channel => SchedulerPreflightTargetKind::Channel,
            ScheduleTargetKind::Topic => SchedulerPreflightTargetKind::Topic,
        },
        envelope: MessageEnvelope {
            schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
            endpoint: definition.target.id.clone(),
            message: MessageTypeId {
                id: definition.message.type_id.clone(),
                version: definition.message.version,
            },
            payload: definition.message.payload.clone(),
            correlation_id: None,
        },
    }
}

fn next_occurrences(
    definitions: &[ScheduleDefinition],
    now: Timestamp,
) -> Result<BTreeMap<String, Option<String>>, Vec<ScheduleDiagnostic>> {
    let mut next = BTreeMap::new();
    let mut diagnostics = Vec::new();
    for definition in definitions {
        match next_occurrence_utc(definition, now) {
            Ok(occurrence) => {
                next.insert(definition.id.clone(), occurrence);
            }
            Err(diagnostic) => diagnostics.push(diagnostic),
        }
    }
    if diagnostics.is_empty() {
        Ok(next)
    } else {
        sort_diagnostics(&mut diagnostics);
        Err(diagnostics)
    }
}

fn next_occurrence_utc(
    definition: &ScheduleDefinition,
    now: Timestamp,
) -> Result<Option<String>, ScheduleDiagnostic> {
    if !definition.enabled {
        return Ok(None);
    }
    let schedule = cronexpr::parse_crontab(&definition.cron)
        .map_err(|_| diagnostic_for_definition(CRON_INVALID, definition))?;
    let next = schedule
        .find_next(now)
        .map_err(|_| diagnostic_for_definition(NEXT_OCCURRENCE_UNAVAILABLE, definition))?;
    Ok(Some(next.timestamp().to_string()))
}

fn preflight_diagnostics(
    definitions: &[ScheduleDefinition],
    errors: Vec<SchedulerPreflightError>,
) -> Vec<ScheduleDiagnostic> {
    let mut diagnostics = errors
        .into_iter()
        .filter_map(|error| {
            definitions.get(error.request_index()).map(|definition| {
                diagnostic_for_definition(preflight_code(error.error().code.as_str()), definition)
            })
        })
        .collect::<Vec<_>>();
    sort_diagnostics(&mut diagnostics);
    diagnostics
}

fn preflight_code(code: &str) -> &'static str {
    match code {
        crate::message_bus::NO_ACTIVE_CHANNEL_OWNER => TARGET_UNAVAILABLE,
        crate::message_bus::UNKNOWN_MESSAGE_CONTRACT
        | crate::message_bus::INCOMPATIBLE_MESSAGE_VERSION => TARGET_MESSAGE_INCOMPATIBLE,
        crate::message_bus::UNAUTHORIZED_SENDER => TARGET_UNAUTHORIZED,
        crate::message_bus::INVALID_PAYLOAD => PAYLOAD_INVALID,
        crate::message_bus::PAYLOAD_TOO_LARGE => PAYLOAD_TOO_LARGE,
        crate::message_bus::SCHEDULER_SECRET_PAYLOAD_FORBIDDEN => SECRET_PAYLOAD_FORBIDDEN,
        _ => TARGET_MESSAGE_INCOMPATIBLE,
    }
}

fn diagnostic_for_definition(code: &str, definition: &ScheduleDefinition) -> ScheduleDiagnostic {
    ScheduleDiagnostic {
        schema_version: SCHEDULE_INSPECTION_SCHEMA_VERSION,
        code: code.to_string(),
        severity: ScheduleDiagnosticSeverity::Error,
        source_path: Some(definition.source_path.clone()),
        schedule_id: Some(definition.id.clone()),
        context: Default::default(),
    }
}

fn sort_diagnostics(diagnostics: &mut [ScheduleDiagnostic]) {
    diagnostics.sort_by(|left, right| {
        left.source_path
            .cmp(&right.source_path)
            .then_with(|| left.schedule_id.cmp(&right.schedule_id))
            .then_with(|| left.code.cmp(&right.code))
    });
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::json;
    use tempfile::tempdir;
    use uuid::Uuid;

    use crate::instance::{InstanceBuildIdentity, LaunchProvenance, RootSource};
    use crate::message_bus::{
        DirectedChannelDeclaration, MessageContractError, MessageDeclarations,
        MessageSchemaDescriptor, MessageTypeContract, PreparedRegistration, RegistrationHandlers,
        RouteEndpointRef,
    };
    use crate::module_control::ModuleGrant;

    use super::*;

    const MESSAGE: &str = "fixture.agent-wakeup";
    const JSON_SCHEMA_DRAFT: &str = "https://json-schema.org/draft/2020-12/schema";

    fn context(name: &str, root: &Path) -> InstanceContext {
        InstanceContext {
            instance_id: Uuid::new_v4(),
            name: name.to_string(),
            state_root: root.to_path_buf(),
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

    fn message_for(id: &str) -> MessageTypeId {
        MessageTypeId {
            id: id.to_string(),
            version: 1,
        }
    }

    fn declarations_for(
        message_id: &str,
        endpoints: &[(&str, bool)],
        redacted_fields: Vec<String>,
        max_encoded_bytes: u64,
    ) -> MessageDeclarations {
        let root = format!("schemas/{}.json", message_id.replace('.', "-"));
        MessageDeclarations {
            schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
            provides: vec![MessageTypeContract {
                message: message_for(message_id),
                schema: MessageSchemaDescriptor {
                    draft: JSON_SCHEMA_DRAFT.to_string(),
                    root: root.clone(),
                    resources: BTreeMap::from([(
                        root.clone(),
                        json!({
                            "$schema": JSON_SCHEMA_DRAFT,
                            "$id": format!("shipctl-artifact:///{root}"),
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["reason"],
                            "properties": {"reason": {"type": "string"}}
                        }),
                    )]),
                    max_encoded_bytes,
                    redacted_fields,
                    compatible_versions: vec![1],
                },
            }],
            handles: endpoints
                .iter()
                .map(|(endpoint, scheduler_allowed)| DirectedChannelDeclaration {
                    endpoint: RouteEndpointRef {
                        id: (*endpoint).to_string(),
                        message: message_for(message_id),
                    },
                    capacity: 2,
                    required_grant: format!("message.send.{endpoint}"),
                    scheduler_allowed: *scheduler_allowed,
                })
                .collect(),
            publishes: Vec::new(),
            subscribes: Vec::new(),
            ports: Vec::new(),
        }
    }

    async fn register_channels(
        context: &InstanceContext,
        bus: &RuntimeMessageBus,
        endpoints: &[(&str, bool)],
        redacted_fields: Vec<String>,
        max_encoded_bytes: u64,
    ) -> Arc<AtomicUsize> {
        register_channels_with_contract(
            context,
            bus,
            "fixture@scheduler#one",
            MESSAGE,
            endpoints,
            redacted_fields,
            max_encoded_bytes,
        )
        .await
    }

    async fn register_channels_with_contract(
        context: &InstanceContext,
        bus: &RuntimeMessageBus,
        activation_id: &str,
        message_id: &str,
        endpoints: &[(&str, bool)],
        redacted_fields: Vec<String>,
        max_encoded_bytes: u64,
    ) -> Arc<AtomicUsize> {
        let handled = Arc::new(AtomicUsize::new(0));
        let mut handlers = RegistrationHandlers::new();
        for (endpoint, _) in endpoints {
            let handled = Arc::clone(&handled);
            handlers = handlers.with_directed((*endpoint).to_string(), move |_| {
                let handled = Arc::clone(&handled);
                async move {
                    handled.fetch_add(1, Ordering::SeqCst);
                    Ok::<(), MessageContractError>(())
                }
            });
        }
        let registration = Arc::new(
            PreparedRegistration::prepare(
                context,
                activation_id,
                &[] as &[ModuleGrant],
                declarations_for(message_id, endpoints, redacted_fields, max_encoded_bytes),
                handlers,
            )
            .unwrap(),
        );
        bus.register(registration).await.unwrap();
        handled
    }

    fn write_fixture(root: &Path, fixture: &str) {
        fs::create_dir_all(root).unwrap();
        for entry in fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            fs::remove_file(path).unwrap();
        }
        let contents = match fixture {
            "valid-channel.yaml" => {
                include_str!("../../../../modules/api/fixtures/schedules/valid-channel.yaml")
            }
            "invalid-unknown-field.yaml" => {
                include_str!(
                    "../../../../modules/api/fixtures/schedules/invalid-unknown-field.yaml"
                )
            }
            "secret-payload.yaml" => {
                include_str!("../../../../modules/api/fixtures/schedules/secret-payload.yaml")
            }
            "unavailable-target.yaml" => {
                include_str!("../../../../modules/api/fixtures/schedules/unavailable-target.yaml")
            }
            "unauthorized-target.yaml" => {
                include_str!("../../../../modules/api/fixtures/schedules/unauthorized-target.yaml")
            }
            "disabled.yaml" => {
                include_str!("../../../../modules/api/fixtures/schedules/disabled.yaml")
            }
            "incompatible-target.yaml" => {
                include_str!("../../../../modules/api/fixtures/schedules/incompatible-target.yaml")
            }
            "invalid-payload.yaml" => {
                include_str!("../../../../modules/api/fixtures/schedules/invalid-payload.yaml")
            }
            "oversized-payload.yaml" => {
                include_str!("../../../../modules/api/fixtures/schedules/oversized-payload.yaml")
            }
            other => panic!("unknown scheduler fixture {other}"),
        };
        fs::write(root.join("schedule.yaml"), contents).unwrap();
    }

    #[test]
    fn next_occurrence_is_future_and_disabled_schedules_have_no_deadline() {
        let source = include_str!("../../../../modules/api/fixtures/schedules/valid-channel.yaml");
        let definition =
            super::super::parse_schedule_source(Path::new("wake.yaml"), source).unwrap();
        let now = "2026-08-09T07:00:00Z".parse::<Timestamp>().unwrap();

        let next = next_occurrence_utc(&definition, now).unwrap().unwrap();
        assert!(next.parse::<Timestamp>().unwrap() > now);

        let mut disabled = definition;
        disabled.enabled = false;
        assert_eq!(next_occurrence_utc(&disabled, now).unwrap(), None);
    }

    #[test]
    fn dst_schedule_produces_a_strictly_future_utc_occurrence() {
        let source = include_str!("../../../../modules/api/fixtures/schedules/dst-australia.yaml");
        let definition =
            super::super::parse_schedule_source(Path::new("dst.yaml"), source).unwrap();
        let now = "2026-10-03T15:59:00Z".parse::<Timestamp>().unwrap();

        let next = next_occurrence_utc(&definition, now).unwrap().unwrap();
        assert!(next.parse::<Timestamp>().unwrap() > now);
        assert!(next.ends_with('Z'));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn refresh_publishes_one_valid_snapshot_without_delivery_or_source_writes() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        write_fixture(&schedule_root, "valid-channel.yaml");
        let source_before = fs::read(schedule_root.join("schedule.yaml")).unwrap();
        let context = context("scheduler-refresh", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let service = SchedulerService::new(context, &schedule_root, bus.clone()).unwrap();
        let handled = register_channels(
            &service.inner.context,
            &bus,
            &[("agents.wakeup", true)],
            Vec::new(),
            256,
        )
        .await;
        let mut snapshots = service.subscribe_snapshots();

        let result = service.refresh().await;

        assert!(result.applied);
        assert_eq!(result.snapshot.generation, 1);
        snapshots.changed().await.unwrap();
        let published = snapshots.borrow_and_update().clone();
        assert_eq!(published.snapshot, result.snapshot);
        assert_eq!(
            published.bus_route_generation,
            bus.snapshot().route_generation
        );
        assert!(published.removed_schedule_ids.is_empty());
        assert!(!snapshots.has_changed().unwrap());
        assert_eq!(handled.load(Ordering::SeqCst), 0);
        assert!(bus
            .inspect_endpoints()
            .await
            .iter()
            .all(|endpoint| endpoint.accepted == 0 && endpoint.delivered == 0));
        assert_eq!(
            fs::read(schedule_root.join("schedule.yaml")).unwrap(),
            source_before
        );

        let inspection = service.inspect();
        assert_eq!(inspection.schedule_generation, 1);
        assert_eq!(
            inspection.bus_route_generation,
            bus.snapshot().route_generation
        );
        assert_eq!(inspection.schedules.len(), 1);
        assert_eq!(
            inspection.schedules[0].target_availability,
            ScheduleTargetAvailability::Available
        );
        assert!(inspection.schedules[0].next_occurrence_utc.is_some());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn rejected_source_and_preflight_candidates_preserve_the_accepted_snapshot() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        write_fixture(&schedule_root, "valid-channel.yaml");
        let context = context("scheduler-rejection", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let service = SchedulerService::new(context, &schedule_root, bus.clone()).unwrap();
        register_channels(
            &service.inner.context,
            &bus,
            &[
                ("agents.wakeup", true),
                ("agents.unauthorized", false),
                ("agents.secret", true),
                ("agents.invalid-payload", true),
            ],
            vec!["/apiToken".to_string()],
            256,
        )
        .await;
        register_channels_with_contract(
            &service.inner.context,
            &bus,
            "fixture@scheduler#incompatible",
            "fixture.different",
            &[("agents.incompatible", true)],
            Vec::new(),
            256,
        )
        .await;
        register_channels_with_contract(
            &service.inner.context,
            &bus,
            "fixture@scheduler#oversized",
            MESSAGE,
            &[("agents.oversized", true)],
            Vec::new(),
            16,
        )
        .await;
        assert!(service.refresh().await.applied);
        let baseline = serde_json::to_vec(&service.accepted_snapshot()).unwrap();
        let baseline_generation = service.accepted_snapshot().generation;
        let snapshots = service.subscribe_snapshots();

        for (fixture, code) in [
            (
                "invalid-unknown-field.yaml",
                super::super::diagnostics::SOURCE_UNKNOWN_FIELD,
            ),
            ("unavailable-target.yaml", TARGET_UNAVAILABLE),
            ("unauthorized-target.yaml", TARGET_UNAUTHORIZED),
            ("secret-payload.yaml", SECRET_PAYLOAD_FORBIDDEN),
            ("incompatible-target.yaml", TARGET_MESSAGE_INCOMPATIBLE),
            ("invalid-payload.yaml", PAYLOAD_INVALID),
            ("oversized-payload.yaml", PAYLOAD_TOO_LARGE),
        ] {
            write_fixture(&schedule_root, fixture);
            let result = service.refresh().await;
            assert!(!result.applied, "{fixture} unexpectedly applied");
            assert!(result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == code));
            assert_eq!(
                serde_json::to_vec(&service.accepted_snapshot()).unwrap(),
                baseline,
                "{fixture} changed accepted state"
            );
            assert_eq!(service.accepted_snapshot().generation, baseline_generation);
            assert!(
                !snapshots.has_changed().unwrap(),
                "{fixture} published a snapshot"
            );
            if fixture == "secret-payload.yaml" {
                let diagnostic = result
                    .diagnostics
                    .iter()
                    .find(|diagnostic| diagnostic.code == SECRET_PAYLOAD_FORBIDDEN)
                    .unwrap();
                assert_eq!(diagnostic.source_path.as_deref(), Some("schedule.yaml"));
                assert_eq!(diagnostic.schedule_id.as_deref(), Some("agents.secret"));
                let rendered = serde_json::to_string(&service.inspect()).unwrap();
                assert!(!rendered.contains("fixture-secret"));
                assert!(!rendered.contains("/apiToken"));
                assert!(!rendered.contains("Scheduled target failed message-bus preflight"));
            }
        }

        fs::remove_file(schedule_root.join("schedule.yaml")).unwrap();
        fs::write(
            schedule_root.join("duplicate-a.yaml"),
            include_str!("../../../../modules/api/fixtures/schedules/duplicate-a.yaml"),
        )
        .unwrap();
        fs::write(
            schedule_root.join("duplicate-b.yaml"),
            include_str!("../../../../modules/api/fixtures/schedules/duplicate-b.yaml"),
        )
        .unwrap();
        let duplicate = service.refresh().await;
        assert!(!duplicate.applied);
        assert_eq!(duplicate.diagnostics.len(), 2);
        assert!(duplicate
            .diagnostics
            .iter()
            .all(|diagnostic| { diagnostic.code == super::super::diagnostics::DUPLICATE_ID }));
        assert_eq!(
            serde_json::to_vec(&service.accepted_snapshot()).unwrap(),
            baseline
        );
        assert!(!snapshots.has_changed().unwrap());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;

            for entry in fs::read_dir(&schedule_root).unwrap() {
                fs::remove_file(entry.unwrap().path()).unwrap();
            }
            let outside = temporary.path().join("outside.yaml");
            fs::write(&outside, "schema_version: 1").unwrap();
            symlink(&outside, schedule_root.join("linked.yaml")).unwrap();
            let unsafe_source = service.refresh().await;
            assert!(!unsafe_source.applied);
            assert_eq!(
                unsafe_source.diagnostics[0].code,
                super::super::diagnostics::SOURCE_PATH_UNSAFE
            );
            assert_eq!(
                serde_json::to_vec(&service.accepted_snapshot()).unwrap(),
                baseline
            );
            assert!(!snapshots.has_changed().unwrap());
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn disabled_definitions_preflight_and_empty_refresh_replaces_the_whole_snapshot() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        write_fixture(&schedule_root, "disabled.yaml");
        let context = context("scheduler-empty", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let service = SchedulerService::new(context, &schedule_root, bus.clone()).unwrap();

        let rejected = service.refresh().await;
        assert!(!rejected.applied);
        assert_eq!(rejected.diagnostics[0].code, TARGET_UNAVAILABLE);

        register_channels(
            &service.inner.context,
            &bus,
            &[("agents.disabled", true)],
            Vec::new(),
            256,
        )
        .await;
        let accepted = service.refresh().await;
        assert!(accepted.applied);
        assert_eq!(accepted.snapshot.generation, 1);
        assert_eq!(service.inspect().schedules[0].next_occurrence_utc, None);
        let mut snapshots = service.subscribe_snapshots();

        fs::remove_file(schedule_root.join("schedule.yaml")).unwrap();
        let emptied = service.refresh().await;
        assert!(emptied.applied);
        assert_eq!(emptied.snapshot.generation, 2);
        assert!(emptied.snapshot.definitions.is_empty());
        snapshots.changed().await.unwrap();
        assert_eq!(
            snapshots.borrow_and_update().removed_schedule_ids,
            vec!["agents.disabled".to_string()]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn invalid_startup_stays_degraded_until_an_explicit_valid_refresh() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        write_fixture(&schedule_root, "invalid-unknown-field.yaml");
        let context = context("scheduler-startup-invalid", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let service = SchedulerService::new(context, &schedule_root, bus.clone()).unwrap();

        assert_eq!(service.accepted_snapshot().generation, 0);
        assert!(service
            .inspect()
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == super::super::diagnostics::SOURCE_UNKNOWN_FIELD));
        service.start_initial_route_refresh();

        write_fixture(&schedule_root, "valid-channel.yaml");
        register_channels(
            &service.inner.context,
            &bus,
            &[("agents.wakeup", true)],
            Vec::new(),
            256,
        )
        .await;
        assert_eq!(bus.snapshot().route_generation, 1);
        assert_eq!(service.inspect().bus_route_generation, 0);
        let recovered = service.refresh().await;
        assert!(recovered.applied);
        assert_eq!(recovered.snapshot.generation, 1);
        assert!(service.inspect().diagnostics.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn startup_candidate_waits_for_bridge_routes_then_publishes_once() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        write_fixture(&schedule_root, "valid-channel.yaml");
        let context = context("scheduler-startup", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let service = SchedulerService::new(context, &schedule_root, bus.clone()).unwrap();
        let mut snapshots = service.subscribe_snapshots();

        service.start_initial_route_refresh();
        assert_eq!(service.accepted_snapshot().generation, 0);
        register_channels(
            &service.inner.context,
            &bus,
            &[("agents.wakeup", true)],
            Vec::new(),
            256,
        )
        .await;
        snapshots.changed().await.unwrap();

        let published = snapshots.borrow_and_update().clone();
        assert_eq!(published.snapshot.generation, 1);
        assert_eq!(
            published.bus_route_generation,
            bus.snapshot().route_generation
        );
        assert!(!snapshots.has_changed().unwrap());
    }

    #[test]
    fn construction_rejects_cross_instance_bus_or_schedule_root() {
        let temporary = tempdir().unwrap();
        let first_root = temporary.path().join("first");
        let second_root = temporary.path().join("second");
        let first = context("first", &first_root);
        let second = context("second", &second_root);

        assert!(matches!(
            SchedulerService::new(
                first.clone(),
                first.paths().schedule_root,
                RuntimeMessageBus::new(second),
            ),
            Err(SchedulerServiceError::MessageBusInstanceMismatch)
        ));
        assert!(matches!(
            SchedulerService::new(
                first.clone(),
                second_root.join("schedules"),
                RuntimeMessageBus::new(first),
            ),
            Err(SchedulerServiceError::ScheduleRootMismatch)
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn an_obsolete_prepared_candidate_is_revalidated_before_publication() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        write_fixture(&schedule_root, "valid-channel.yaml");
        let context = context("scheduler-stale", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let service = SchedulerService::new(context, &schedule_root, bus.clone()).unwrap();
        register_channels(
            &service.inner.context,
            &bus,
            &[("agents.wakeup", true)],
            Vec::new(),
            256,
        )
        .await;
        assert!(service.refresh().await.applied);
        let baseline = serde_json::to_vec(&service.accepted_snapshot()).unwrap();
        let candidate = load_schedule_candidate(&schedule_root);
        assert!(candidate.is_valid());
        let snapshots = service.subscribe_snapshots();

        bus.withdraw("fixture@scheduler#one").await.unwrap();
        let rejected = service.apply_prepared_candidate(candidate).await;

        assert!(!rejected.applied);
        assert_eq!(rejected.diagnostics.len(), 1);
        assert_eq!(rejected.diagnostics[0].code, TARGET_UNAVAILABLE);
        assert_eq!(
            serde_json::to_vec(&service.accepted_snapshot()).unwrap(),
            baseline
        );
        assert!(!snapshots.has_changed().unwrap());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn concurrent_candidate_applications_serialize_whole_generations() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        write_fixture(&schedule_root, "valid-channel.yaml");
        let first_candidate = load_schedule_candidate(&schedule_root);
        write_fixture(&schedule_root, "disabled.yaml");
        let second_candidate = load_schedule_candidate(&schedule_root);
        let context = context("scheduler-concurrent", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let service = SchedulerService::new(context, &schedule_root, bus.clone()).unwrap();
        register_channels(
            &service.inner.context,
            &bus,
            &[("agents.wakeup", true), ("agents.disabled", true)],
            Vec::new(),
            256,
        )
        .await;

        let held_refresh = service.inner.refresh.lock().await;
        let first = tokio::spawn({
            let service = service.clone();
            async move { service.apply_prepared_candidate(first_candidate).await }
        });
        tokio::task::yield_now().await;
        let second = tokio::spawn({
            let service = service.clone();
            async move { service.apply_prepared_candidate(second_candidate).await }
        });
        tokio::task::yield_now().await;
        assert!(!first.is_finished());
        assert!(!second.is_finished());
        drop(held_refresh);

        let first = first.await.unwrap();
        let second = second.await.unwrap();
        assert!(first.applied);
        assert!(second.applied);
        let mut generations = [first.snapshot.generation, second.snapshot.generation];
        generations.sort_unstable();
        assert_eq!(generations, [1, 2]);
        for snapshot in [&first.snapshot, &second.snapshot] {
            assert_eq!(snapshot.definitions.len(), 1);
            assert!(matches!(
                snapshot.definitions[0].id.as_str(),
                "agents.wakeup" | "agents.disabled"
            ));
        }
        assert_eq!(service.accepted_snapshot().generation, 2);
        assert_eq!(service.accepted_snapshot().definitions.len(), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn two_instance_scheduler_services_do_not_cross_read_or_refresh_roots() {
        let temporary = tempdir().unwrap();
        let first_root = temporary.path().join("first");
        let second_root = temporary.path().join("second");
        let first_context = context("first", &first_root);
        let second_context = context("second", &second_root);
        let first_paths = first_context.paths();
        let second_paths = second_context.paths();
        write_fixture(&first_paths.schedule_root, "valid-channel.yaml");
        write_fixture(&second_paths.schedule_root, "disabled.yaml");
        let second_source_before =
            fs::read(second_paths.schedule_root.join("schedule.yaml")).unwrap();
        let first_bus = RuntimeMessageBus::new(first_context.clone());
        let second_bus = RuntimeMessageBus::new(second_context.clone());
        let first = SchedulerService::new(
            first_context,
            first_paths.schedule_root.clone(),
            first_bus.clone(),
        )
        .unwrap();
        let second = SchedulerService::new(
            second_context,
            second_paths.schedule_root.clone(),
            second_bus.clone(),
        )
        .unwrap();
        register_channels(
            &first.inner.context,
            &first_bus,
            &[("agents.wakeup", true)],
            Vec::new(),
            256,
        )
        .await;
        register_channels(
            &second.inner.context,
            &second_bus,
            &[("agents.disabled", true)],
            Vec::new(),
            256,
        )
        .await;

        assert!(first.refresh().await.applied);
        assert_eq!(first.accepted_snapshot().generation, 1);
        assert_eq!(second.accepted_snapshot().generation, 0);
        assert_eq!(
            fs::read(second_paths.schedule_root.join("schedule.yaml")).unwrap(),
            second_source_before
        );
        assert_ne!(first.inspect().instance_id, second.inspect().instance_id);
        assert_ne!(first.inspect().incarnation, second.inspect().incarnation);

        assert!(second.refresh().await.applied);
        assert_eq!(second.accepted_snapshot().generation, 1);
        assert_eq!(first.accepted_snapshot().definitions[0].id, "agents.wakeup");
        assert_eq!(
            second.accepted_snapshot().definitions[0].id,
            "agents.disabled"
        );
    }
}
