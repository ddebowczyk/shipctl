//! Atomic, instance-local schedule refresh and cancellable runtime delivery.
//!
//! The service accepts complete source snapshots against live message routes,
//! owns only in-memory jobs, and never polls, watches source files, or writes
//! durable tick state.

use cronexpr::jiff::Timestamp;
use std::collections::{btree_map::Entry, BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::{watch, Mutex as AsyncMutex};
use tokio::task::JoinHandle;
use tokio::time::{sleep_until, Instant};
use uuid::Uuid;

use crate::instance::InstanceContext;
use crate::message_bus::{
    MessageEnvelope, MessageTypeId, RuntimeMessageBus, SchedulerPreflightError,
    SchedulerPreflightRequest, SchedulerPreflightSnapshot, SchedulerPreflightTargetKind,
    MESSAGE_CONTRACT_SCHEMA_VERSION,
};

use super::contracts::{
    schedule_snapshot, ScheduleDefinition, ScheduleDeliveryOutcome, ScheduleDeliverySummary,
    ScheduleDiagnosticReport, ScheduleInspection, ScheduleRefreshReport, ScheduleSnapshot,
    ScheduleTargetAvailability, ScheduleTargetKind, ScheduleTriggerReport, ScheduleVerification,
    SCHEDULE_CONTROL_SCHEMA_VERSION, SCHEDULE_INSPECTION_SCHEMA_VERSION,
};
use super::diagnostics::{
    CRON_INVALID, NEXT_OCCURRENCE_UNAVAILABLE, PAYLOAD_INVALID, PAYLOAD_TOO_LARGE,
    SCHEDULE_DISABLED, SCHEDULE_NOT_FOUND, SECRET_PAYLOAD_FORBIDDEN, SNAPSHOT_SOURCE_DRIFT,
    TARGET_MESSAGE_INCOMPATIBLE, TARGET_UNAUTHORIZED, TARGET_UNAVAILABLE,
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

/// Stable operation codes for machine-facing scheduler control reports. They
/// are outcomes, not diagnostics: failures continue to carry only redacted
/// scheduler diagnostic codes.
pub const SCHEDULE_CONTROL_LISTED: &str = "scheduler.control.listed";
pub const SCHEDULE_CONTROL_INSPECTED: &str = "scheduler.control.inspected";
pub const SCHEDULE_CONTROL_DIAGNOSED: &str = "scheduler.control.diagnosed";
pub const SCHEDULE_CONTROL_VERIFIED: &str = "scheduler.control.verified";
pub const SCHEDULE_CONTROL_REFRESHED: &str = "scheduler.control.refreshed";
pub const SCHEDULE_CONTROL_REFRESH_REJECTED: &str = "scheduler.control.refresh_rejected";
/// Aggregate result emitted by a caller that fans one refresh identity out to
/// several independent instance incarnations. Individual scheduler services
/// never emit this: each service can report only its own accepted snapshot.
pub const SCHEDULE_CONTROL_REFRESH_PARTIAL: &str = "scheduler.control.refresh_partial";
pub const SCHEDULE_CONTROL_TRIGGERED: &str = "scheduler.control.triggered";
pub const SCHEDULE_CONTROL_REQUEST_ID_CONFLICT: &str = "scheduler.control.request_id_conflict";

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

/// A manual trigger always uses the same typed delivery path as a timer job.
/// These errors describe only a schedule selection that cannot enter that
/// path; delivery rejection is represented by a redacted summary instead.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SchedulerTriggerError {
    NotFound(ScheduleDiagnostic),
    Disabled(ScheduleDiagnostic),
    Unavailable(ScheduleDiagnostic),
}

impl SchedulerTriggerError {
    pub fn diagnostic(&self) -> &ScheduleDiagnostic {
        match self {
            Self::NotFound(diagnostic)
            | Self::Disabled(diagnostic)
            | Self::Unavailable(diagnostic) => diagnostic,
        }
    }
}

impl fmt::Display for SchedulerTriggerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.diagnostic().code)
    }
}

impl std::error::Error for SchedulerTriggerError {}

/// A scheduler-local control failure. It deliberately does not retain a
/// request payload or a source document; control adapters can render its
/// stable code or its already-redacted selection diagnostic.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SchedulerControlError {
    NotFound(ScheduleDiagnostic),
    Trigger(SchedulerTriggerError),
    RequestIdConflict,
}

impl SchedulerControlError {
    pub fn code(&self) -> &str {
        match self {
            Self::NotFound(diagnostic) => &diagnostic.code,
            Self::Trigger(error) => &error.diagnostic().code,
            Self::RequestIdConflict => SCHEDULE_CONTROL_REQUEST_ID_CONFLICT,
        }
    }

    pub fn diagnostic(&self) -> Option<&ScheduleDiagnostic> {
        match self {
            Self::NotFound(diagnostic) => Some(diagnostic),
            Self::Trigger(error) => Some(error.diagnostic()),
            Self::RequestIdConflict => None,
        }
    }
}

impl fmt::Display for SchedulerControlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for SchedulerControlError {}

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

/// The clock abstraction keeps calendar time explicit. Tokio's paused test
/// clock intentionally does not alter system wall time, so scheduler tests
/// inject a coupled wall clock without changing production semantics.
trait SchedulerClock: Send + Sync {
    fn now(&self) -> Timestamp;

    /// A clock adjustment means a waiter must discard its old deadline and
    /// calculate a fresh strictly-future occurrence. Production has no
    /// portable adjustment event source, while the test clock uses this to
    /// model wall-clock corrections deterministically.
    fn subscribe_adjustments(&self) -> watch::Receiver<()>;
}

struct SystemSchedulerClock {
    adjustments: watch::Sender<()>,
}

impl Default for SystemSchedulerClock {
    fn default() -> Self {
        let (adjustments, _) = watch::channel(());
        Self { adjustments }
    }
}

impl SchedulerClock for SystemSchedulerClock {
    fn now(&self) -> Timestamp {
        Timestamp::now()
    }

    fn subscribe_adjustments(&self) -> watch::Receiver<()> {
        self.adjustments.subscribe()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SchedulerJobIdentity {
    definition_digest_sha256: String,
}

struct SchedulerJob {
    identity: SchedulerJobIdentity,
    cancel: watch::Sender<bool>,
    task: JoinHandle<()>,
}

/// A pending typed delivery is always raced against scheduler ownership and
/// route changes. This prevents a bounded channel from preserving an obsolete
/// timer or manual action after its accepted definition has changed.
enum ControlledDelivery {
    Completed(Option<ScheduleDeliverySummary>),
    Cancelled,
    Shutdown,
    Accepted(Arc<AcceptedScheduleSnapshot>),
    RouteChanged,
    ClockAdjusted,
}

#[derive(Clone, Debug)]
struct ScheduleRuntimeState {
    next_occurrence_utc: Option<String>,
    last_attempt: Option<ScheduleDeliverySummary>,
    target_availability: ScheduleTargetAvailability,
    diagnostic: Option<ScheduleDiagnostic>,
}

#[derive(Default)]
struct SchedulerJobs {
    shutdown: bool,
    jobs: BTreeMap<String, SchedulerJob>,
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
    runtime: BTreeMap<String, ScheduleRuntimeState>,
}

#[derive(Debug, Default)]
struct StartupState {
    started: bool,
    candidate: Option<ScheduleLoadCandidate>,
}

/// A request identity binds one control-plane mutation to its canonical
/// scheduler operation for this process incarnation. The ledger is memory
/// only, is released with the service, and therefore cannot create a durable
/// scheduler operation journal.
#[derive(Clone, Debug, Eq, PartialEq)]
enum SchedulerMutationFingerprint {
    Refresh,
    Trigger { schedule_id: String },
}

#[derive(Clone, Debug)]
enum SchedulerMutationOutcome {
    Refresh(Result<ScheduleRefreshReport, SchedulerControlError>),
    Trigger(Result<ScheduleTriggerReport, SchedulerControlError>),
}

struct SchedulerMutationEntry {
    fingerprint: SchedulerMutationFingerprint,
    completion: watch::Sender<Option<SchedulerMutationOutcome>>,
}

enum SchedulerMutationReservation {
    Leader(watch::Sender<Option<SchedulerMutationOutcome>>),
    Follower(watch::Receiver<Option<SchedulerMutationOutcome>>),
}

struct SchedulerServiceInner {
    context: InstanceContext,
    schedule_root: PathBuf,
    bus: RuntimeMessageBus,
    refresh: AsyncMutex<()>,
    state: Mutex<SchedulerState>,
    snapshots: watch::Sender<Arc<AcceptedScheduleSnapshot>>,
    startup: Mutex<StartupState>,
    clock: Arc<dyn SchedulerClock>,
    jobs: Mutex<SchedulerJobs>,
    shutdown: watch::Sender<bool>,
    mutations: AsyncMutex<BTreeMap<Uuid, SchedulerMutationEntry>>,
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
        Self::new_with_clock(
            context,
            schedule_root,
            bus,
            Arc::new(SystemSchedulerClock::default()),
        )
    }

    fn new_with_clock(
        context: InstanceContext,
        schedule_root: impl Into<PathBuf>,
        bus: RuntimeMessageBus,
        clock: Arc<dyn SchedulerClock>,
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
        let (shutdown, _) = watch::channel(false);

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
                    runtime: BTreeMap::new(),
                }),
                snapshots,
                startup: Mutex::new(StartupState {
                    started: false,
                    candidate: startup_candidate,
                }),
                clock,
                jobs: Mutex::new(SchedulerJobs::default()),
                shutdown,
                mutations: AsyncMutex::new(BTreeMap::new()),
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

    /// Returns the number of still-running schedule jobs owned by this
    /// instance. Finished route-invalidated jobs are not counted, and no job
    /// from another instance can be present in this service-owned registry.
    pub fn active_job_count(&self) -> usize {
        self.inner
            .jobs
            .lock()
            .expect("scheduler job mutex must not be poisoned")
            .jobs
            .values()
            .filter(|job| !job.task.is_finished())
            .count()
    }

    /// Cancels every scheduler-owned task. It is safe to call repeatedly from
    /// the instance lifecycle; shutdown never writes a tick or waits for a
    /// deadline to elapse.
    pub fn shutdown(&self) {
        let mut jobs = self
            .inner
            .jobs
            .lock()
            .expect("scheduler job mutex must not be poisoned");
        if jobs.shutdown {
            return;
        }
        jobs.shutdown = true;
        self.inner.shutdown.send_replace(true);
        for job in jobs.jobs.values_mut() {
            job.cancel.send_replace(true);
            job.task.abort();
        }
        jobs.jobs.clear();
    }

    fn shutdown_receiver(&self) -> watch::Receiver<bool> {
        self.inner.shutdown.subscribe()
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
            if let Some(runtime) = state.runtime.get(&schedule.id) {
                schedule.next_occurrence_utc = runtime.next_occurrence_utc.clone();
                schedule.last_attempt = runtime.last_attempt.clone();
                schedule.diagnostic = runtime.diagnostic.clone();
                schedule.target_availability = runtime.target_availability.clone();
            } else {
                schedule.target_availability = if binding_is_current {
                    ScheduleTargetAvailability::Available
                } else {
                    ScheduleTargetAvailability::Unknown
                };
            }
        }
        inspection.diagnostics = state.diagnostics.clone();
        inspection
    }

    /// Returns the accepted snapshot for `schedule_id` while preserving the
    /// enclosing instance, incarnation, generation, digest, and bus evidence.
    /// It never reads source files or changes a task.
    pub fn inspect_schedule(
        &self,
        schedule_id: &str,
    ) -> Result<ScheduleInspection, SchedulerControlError> {
        let mut inspection = self.inspect();
        if !inspection
            .schedules
            .iter()
            .any(|schedule| schedule.id == schedule_id)
        {
            return Err(SchedulerControlError::NotFound(not_found_diagnostic()));
        }
        inspection
            .schedules
            .retain(|schedule| schedule.id == schedule_id);
        Ok(inspection)
    }

    /// Parses the live source directory and compares its complete candidate
    /// digest with the accepted snapshot. This intentionally stops before bus
    /// preflight or publication, so verify cannot change a timer, generation,
    /// job set, or runtime observation.
    pub fn verify(&self) -> ScheduleVerification {
        let accepted = self.inspect();
        let candidate = load_schedule_candidate(&self.inner.schedule_root);
        let (candidate_digest_sha256, mut diagnostics) =
            match candidate.valid_snapshot(accepted.schedule_generation) {
                Ok(snapshot) => (Some(snapshot.digest_sha256), Vec::new()),
                Err(diagnostics) => (None, diagnostics),
            };
        let matches_accepted = candidate_digest_sha256
            .as_deref()
            .is_some_and(|digest| digest == accepted.snapshot_digest_sha256);
        if candidate_digest_sha256.is_some() && !matches_accepted {
            diagnostics.push(source_drift_diagnostic(
                &accepted.snapshot_digest_sha256,
                candidate_digest_sha256
                    .as_deref()
                    .expect("a present candidate digest was checked above"),
            ));
        }
        sort_diagnostics(&mut diagnostics);
        ScheduleVerification {
            schema_version: SCHEDULE_CONTROL_SCHEMA_VERSION,
            code: SCHEDULE_CONTROL_VERIFIED.to_string(),
            matches_accepted,
            accepted,
            candidate_digest_sha256,
            diagnostics,
        }
    }

    /// Builds the health projection from immutable source verification and the
    /// current accepted/runtime observations. It does not revalidate routes,
    /// publish a candidate, or alter scheduler state.
    pub fn diagnose(&self) -> ScheduleDiagnosticReport {
        let verification = self.verify();
        let inspection = verification.accepted;
        let mut diagnostics = verification.diagnostics;
        diagnostics.extend(inspection.diagnostics.clone());
        diagnostics.extend(
            inspection
                .schedules
                .iter()
                .filter_map(|schedule| schedule.diagnostic.clone()),
        );
        sort_diagnostics(&mut diagnostics);
        diagnostics.dedup();
        let healthy = diagnostics
            .iter()
            .all(|diagnostic| diagnostic.severity != ScheduleDiagnosticSeverity::Error);
        ScheduleDiagnosticReport {
            schema_version: SCHEDULE_CONTROL_SCHEMA_VERSION,
            code: SCHEDULE_CONTROL_DIAGNOSED.to_string(),
            healthy,
            inspection,
            diagnostics,
        }
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
            if self
                .inner
                .jobs
                .lock()
                .expect("scheduler job mutex must not be poisoned")
                .shutdown
            {
                return;
            }
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
        let mut shutdown = self.shutdown_receiver();
        tokio::spawn(async move {
            let route_ready = if routes.borrow().route_generation > 0 {
                true
            } else {
                loop {
                    tokio::select! {
                        changed = routes.changed() => match changed {
                            Ok(()) if routes.borrow().route_generation > 0 => break true,
                            Ok(()) => continue,
                            Err(_) => break false,
                        },
                        changed = shutdown.changed() => {
                            if changed.is_err() || *shutdown.borrow_and_update() {
                                break false;
                            }
                        }
                    }
                }
            };
            if route_ready && !*shutdown.borrow() {
                service.apply_initial_candidate().await;
            }
        });
    }

    /// Re-reads the complete directory and atomically replaces accepted state
    /// only after a successful whole-candidate route preflight.
    pub async fn refresh(&self) -> ScheduleRefreshResult {
        let _refresh = self.inner.refresh.lock().await;
        self.refresh_locked().await
    }

    async fn refresh_locked(&self) -> ScheduleRefreshResult {
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

    /// Performs one explicit refresh under an outer request identity. A retry
    /// with the same UUID returns the original redacted report; a different
    /// UUID remains an independent complete-directory operation.
    pub async fn refresh_with_request_id(
        &self,
        request_id: Uuid,
    ) -> Result<ScheduleRefreshReport, SchedulerControlError> {
        match self
            .reserve_mutation(request_id, SchedulerMutationFingerprint::Refresh)
            .await?
        {
            SchedulerMutationReservation::Follower(completion) => {
                match self.await_mutation(completion).await {
                    SchedulerMutationOutcome::Refresh(result) => result,
                    SchedulerMutationOutcome::Trigger(_) => {
                        unreachable!("matching mutation fingerprints cannot change operation kind")
                    }
                }
            }
            SchedulerMutationReservation::Leader(completion) => {
                // The operation is detached from this specific endpoint read.
                // If its response is lost, the same request ID can reconnect
                // and observe the completed outcome instead of performing a
                // second refresh. The task still belongs only to this service
                // incarnation because the ledger and service share ownership.
                let waiter = completion.subscribe();
                let service = self.clone();
                tokio::spawn(async move {
                    let report = service.refresh_control_report().await;
                    completion.send_replace(Some(SchedulerMutationOutcome::Refresh(Ok(report))));
                });
                match self.await_mutation(waiter).await {
                    SchedulerMutationOutcome::Refresh(result) => result,
                    SchedulerMutationOutcome::Trigger(_) => {
                        unreachable!("matching mutation fingerprints cannot change operation kind")
                    }
                }
            }
        }
    }

    async fn refresh_control_report(&self) -> ScheduleRefreshReport {
        let _refresh = self.inner.refresh.lock().await;
        let result = self.refresh_locked().await;
        ScheduleRefreshReport {
            schema_version: SCHEDULE_CONTROL_SCHEMA_VERSION,
            code: if result.applied {
                SCHEDULE_CONTROL_REFRESHED.to_string()
            } else {
                SCHEDULE_CONTROL_REFRESH_REJECTED.to_string()
            },
            applied: result.applied,
            inspection: self.inspect(),
            diagnostics: result.diagnostics,
        }
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
                let binding = SchedulerRouteBinding::from(preflight);
                let next_occurrences = next_occurrences(&definitions, self.inner.clock.now())?;
                let (snapshot, accepted) = {
                    let mut state = self
                        .inner
                        .state
                        .lock()
                        .expect("scheduler state mutex must not be poisoned");
                    let prior_definitions = state.snapshot.definitions.clone();
                    let prior_runtime = std::mem::take(&mut state.runtime);
                    let generation = state
                        .snapshot
                        .generation
                        .checked_add(1)
                        .expect("scheduler generation overflow");
                    let removed_schedule_ids = prior_definitions
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
                    let retained_ids = definitions
                        .iter()
                        .filter(|candidate| {
                            prior_definitions.iter().any(|accepted| {
                                accepted.id == candidate.id
                                    && accepted.definition_digest_sha256
                                        == candidate.definition_digest_sha256
                            })
                        })
                        .map(|definition| definition.id.clone())
                        .collect::<BTreeSet<_>>();
                    let runtime = definitions
                        .iter()
                        .map(|definition| {
                            let mut value = ScheduleRuntimeState {
                                next_occurrence_utc: next_occurrences
                                    .get(&definition.id)
                                    .cloned()
                                    .flatten(),
                                last_attempt: None,
                                target_availability: ScheduleTargetAvailability::Available,
                                diagnostic: None,
                            };
                            if retained_ids.contains(&definition.id) {
                                if let Some(previous) = prior_runtime.get(&definition.id) {
                                    value.next_occurrence_utc =
                                        previous.next_occurrence_utc.clone();
                                    value.last_attempt = previous.last_attempt.clone();
                                    // A definition digest intentionally
                                    // excludes its source filename so a move
                                    // retains the same job. Its inspection
                                    // diagnostics must nevertheless describe
                                    // the newly accepted source, never the
                                    // retired path.
                                    rebind_runtime_provenance(&mut value, definition);
                                }
                            }
                            (definition.id.clone(), value)
                        })
                        .collect::<BTreeMap<_, _>>();

                    state.snapshot = snapshot.clone();
                    state.binding = Some(binding.clone());
                    state.diagnostics.clear();
                    state.runtime = runtime;
                    let accepted = Arc::new(AcceptedScheduleSnapshot {
                        snapshot: snapshot.clone(),
                        instance_id: binding.instance_id.clone(),
                        incarnation: binding.incarnation.clone(),
                        bus_route_generation: binding.route_generation,
                        removed_schedule_ids,
                    });
                    (snapshot, accepted)
                };
                self.inner.snapshots.send_replace(Arc::clone(&accepted));
                self.reconcile_jobs(accepted);
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

    /// Reconciles only this service's owned task controls. The caller has
    /// already atomically published the accepted snapshot, so a spawned job
    /// always begins from a complete definition set and can observe the same
    /// watch value that external inspection uses.
    fn reconcile_jobs(&self, accepted: Arc<AcceptedScheduleSnapshot>) {
        let desired = accepted
            .snapshot
            .definitions
            .iter()
            .filter(|definition| definition.enabled)
            .map(|definition| {
                (
                    definition.id.clone(),
                    (
                        definition.clone(),
                        SchedulerJobIdentity {
                            definition_digest_sha256: definition.definition_digest_sha256.clone(),
                        },
                    ),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let mut jobs = self
            .inner
            .jobs
            .lock()
            .expect("scheduler job mutex must not be poisoned");
        if jobs.shutdown {
            return;
        }

        let obsolete = jobs
            .jobs
            .iter()
            .filter_map(|(id, job)| match desired.get(id) {
                Some((_, identity)) if job.identity == *identity && !job.task.is_finished() => None,
                _ => Some(id.clone()),
            })
            .collect::<Vec<_>>();
        for id in obsolete {
            if let Some(job) = jobs.jobs.remove(&id) {
                job.cancel.send_replace(true);
                job.task.abort();
            }
        }

        for (id, (definition, identity)) in desired {
            if jobs.jobs.contains_key(&id) {
                continue;
            }
            let (cancel, cancellation) = watch::channel(false);
            let service = self.clone();
            let task_identity = identity.clone();
            let task = tokio::spawn(async move {
                service
                    .run_job(definition, task_identity, cancellation)
                    .await;
            });
            jobs.jobs.insert(
                id,
                SchedulerJob {
                    identity,
                    cancel,
                    task,
                },
            );
        }
    }

    async fn run_job(
        &self,
        mut definition: ScheduleDefinition,
        identity: SchedulerJobIdentity,
        mut cancellation: watch::Receiver<bool>,
    ) {
        let mut accepted = self.subscribe_snapshots();
        let mut routes = self.inner.bus.subscribe_snapshots();
        let mut shutdown = self.shutdown_receiver();
        let mut clock_adjustments = self.inner.clock.subscribe_adjustments();
        let mut last_scheduled_occurrence = None;

        loop {
            if *cancellation.borrow() || *shutdown.borrow() {
                return;
            }
            let _ = clock_adjustments.borrow_and_update();
            let now = self.inner.clock.now();
            let floor = last_scheduled_occurrence
                .filter(|previous| *previous > now)
                .unwrap_or(now);
            let due = match next_occurrence_timestamp(&definition, floor) {
                Ok(Some(due)) => due,
                Ok(None) => return,
                Err(diagnostic) => {
                    self.record_runtime_diagnostic(&definition, &identity, diagnostic);
                    return;
                }
            };
            self.set_next_occurrence(&definition, &identity, Some(due.to_string()));
            let deadline = deadline_for(now, due);

            tokio::select! {
                biased;
                changed = cancellation.changed() => {
                    if changed.is_err() || *cancellation.borrow_and_update() {
                        return;
                    }
                }
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow_and_update() {
                        return;
                    }
                }
                changed = accepted.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    let current = accepted.borrow_and_update().clone();
                    let Some(current_definition) =
                        accepted_snapshot_definition(&current, &definition, &identity)
                    else {
                        return;
                    };
                    definition = current_definition;
                }
                changed = routes.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    let _ = routes.borrow_and_update();
                    self.revalidate_route(&definition, &identity).await;
                }
                changed = clock_adjustments.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
                _ = sleep_until(deadline) => {
                    // A wall-clock correction can make a monotonic deadline
                    // arrive before its calendar occurrence. Re-arm from the
                    // corrected clock rather than firing an early replay.
                    let observed_now = self.inner.clock.now();
                    if observed_now < due {
                        continue;
                    }
                    // A wake after at least one whole calendar occurrence has
                    // passed is a suspend/forward-clock miss, not a backlog.
                    // Recompute from wall time and never enumerate the missed
                    // occurrences. Minor timer latency within this occurrence
                    // still executes its one scheduled delivery.
                    match next_occurrence_timestamp(&definition, due) {
                        Ok(Some(following)) if following <= observed_now => continue,
                        Ok(Some(_)) => {}
                        Ok(None) => return,
                        Err(diagnostic) => {
                            self.record_runtime_diagnostic(&definition, &identity, diagnostic);
                            return;
                        }
                    }
                    match self
                        .deliver_with_controls(
                            &definition,
                            &identity,
                            due,
                            &mut cancellation,
                            &mut accepted,
                            &mut routes,
                            &mut shutdown,
                            &mut clock_adjustments,
                        )
                        .await
                    {
                        ControlledDelivery::Completed(Some(_)) => {
                            last_scheduled_occurrence = Some(due);
                        }
                        ControlledDelivery::Completed(None)
                        | ControlledDelivery::Cancelled
                        | ControlledDelivery::Shutdown => return,
                        ControlledDelivery::Accepted(current) => {
                            let Some(current_definition) =
                                accepted_snapshot_definition(&current, &definition, &identity)
                            else {
                                return;
                            };
                            definition = current_definition;
                        }
                        ControlledDelivery::RouteChanged => {
                            self.revalidate_route(&definition, &identity).await;
                        }
                        ControlledDelivery::ClockAdjusted => {}
                    }
                }
            }
        }
    }

    /// Attempts one typed delivery while observing every event that can make
    /// that attempt obsolete. Dropping the pending `send` future on any such
    /// event preserves bounded-channel backpressure without letting stale work
    /// enqueue after refresh, withdrawal, or shutdown.
    async fn deliver_with_controls(
        &self,
        definition: &ScheduleDefinition,
        identity: &SchedulerJobIdentity,
        occurrence: Timestamp,
        cancellation: &mut watch::Receiver<bool>,
        accepted: &mut watch::Receiver<Arc<AcceptedScheduleSnapshot>>,
        routes: &mut watch::Receiver<Arc<crate::message_bus::MessageRouteSnapshot>>,
        shutdown: &mut watch::Receiver<bool>,
        clock_adjustments: &mut watch::Receiver<()>,
    ) -> ControlledDelivery {
        tokio::select! {
            biased;
            changed = cancellation.changed() => {
                if changed.is_err() || *cancellation.borrow_and_update() {
                    ControlledDelivery::Cancelled
                } else {
                    ControlledDelivery::ClockAdjusted
                }
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow_and_update() {
                    ControlledDelivery::Shutdown
                } else {
                    ControlledDelivery::ClockAdjusted
                }
            }
            changed = accepted.changed() => {
                if changed.is_err() {
                    ControlledDelivery::Shutdown
                } else {
                    ControlledDelivery::Accepted(accepted.borrow_and_update().clone())
                }
            }
            changed = routes.changed() => {
                if changed.is_err() {
                    ControlledDelivery::Shutdown
                } else {
                    let _ = routes.borrow_and_update();
                    ControlledDelivery::RouteChanged
                }
            }
            changed = clock_adjustments.changed() => {
                if changed.is_err() {
                    ControlledDelivery::Shutdown
                } else {
                    ControlledDelivery::ClockAdjusted
                }
            }
            summary = self.deliver_occurrence(definition, identity, occurrence) => {
                ControlledDelivery::Completed(summary)
            }
        }
    }

    /// Revalidates a waiting target after a route publication. A temporary
    /// outage does not kill the schedule: it records one current redacted
    /// diagnostic and re-arms for the next future occurrence, with no retry
    /// of an already due occurrence.
    async fn revalidate_route(
        &self,
        definition: &ScheduleDefinition,
        identity: &SchedulerJobIdentity,
    ) {
        let request = preflight_request(definition);
        match self
            .inner
            .bus
            .with_scheduler_preflight_all(&[request], |_| ())
            .await
        {
            Ok(()) => self.mark_route_available(definition, identity),
            Err(errors) => {
                let diagnostic = preflight_diagnostics(std::slice::from_ref(definition), errors)
                    .into_iter()
                    .next()
                    .unwrap_or_else(|| diagnostic_for_definition(TARGET_UNAVAILABLE, definition));
                self.record_runtime_diagnostic(definition, identity, diagnostic);
            }
        }
    }

    /// Runs one timer/manual delivery attempt. The live bus validates target,
    /// contract, scheduler permission, payload bounds, and secret fields at
    /// this final boundary; only a typed/redacted receipt summary remains in
    /// scheduler memory.
    async fn deliver_occurrence(
        &self,
        definition: &ScheduleDefinition,
        identity: &SchedulerJobIdentity,
        occurrence: Timestamp,
    ) -> Option<ScheduleDeliverySummary> {
        // This short check is the occurrence's scheduler linearization point.
        // A refresh that has already replaced this definition prevents the old
        // task from initiating another delivery; a delivery accepted before
        // that replacement can only write its result back when the definition
        // digest still matches.
        if !self.current_definition_matches(definition, identity) {
            return None;
        }

        let envelope = preflight_request(definition).envelope;
        let result = match definition.target.kind {
            ScheduleTargetKind::Channel => self
                .inner
                .bus
                .send_from_scheduler(envelope)
                .await
                .map(|receipt| receipt.route_generation),
            ScheduleTargetKind::Topic => self
                .inner
                .bus
                .publish_from_scheduler(envelope)
                .map(|receipt| receipt.route_generation),
        };
        let summary = match result {
            Ok(route_generation) => ScheduleDeliverySummary {
                occurrence_utc: occurrence.to_string(),
                outcome: ScheduleDeliveryOutcome::Delivered,
                route_generation,
                diagnostic: None,
            },
            Err(error) => ScheduleDeliverySummary {
                occurrence_utc: occurrence.to_string(),
                outcome: ScheduleDeliveryOutcome::Failed,
                route_generation: error.route_generation(),
                diagnostic: Some(diagnostic_for_definition(
                    preflight_code(error.code()),
                    definition,
                )),
            },
        };
        self.record_delivery(definition, identity, summary.clone());
        Some(summary)
    }

    /// Internally triggers one accepted enabled definition through the exact
    /// timer delivery helper. It never changes snapshot generation or next
    /// deadline, so S4 can safely wrap it in request identity later.
    pub async fn trigger(
        &self,
        schedule_id: &str,
    ) -> Result<ScheduleDeliverySummary, SchedulerTriggerError> {
        let (mut definition, mut identity) = self.selected_definition(schedule_id)?;
        let occurrence = self.inner.clock.now();
        // Manual triggers have no owned job control, but they use the exact
        // same watcher-aware delivery boundary as timer jobs. A refresh,
        // withdrawal, or shutdown therefore drops a pending bounded send
        // instead of letting it enqueue stale work later.
        let (_manual_cancellation, mut cancellation) = watch::channel(false);
        let (_manual_adjustments, mut clock_adjustments) = watch::channel(());
        let mut accepted = self.subscribe_snapshots();
        let mut routes = self.inner.bus.subscribe_snapshots();
        let mut shutdown = self.shutdown_receiver();

        loop {
            if *shutdown.borrow() {
                return Err(SchedulerTriggerError::Unavailable(
                    diagnostic_for_definition(TARGET_UNAVAILABLE, &definition),
                ));
            }
            match self
                .deliver_with_controls(
                    &definition,
                    &identity,
                    occurrence,
                    &mut cancellation,
                    &mut accepted,
                    &mut routes,
                    &mut shutdown,
                    &mut clock_adjustments,
                )
                .await
            {
                ControlledDelivery::Completed(Some(summary)) => return Ok(summary),
                ControlledDelivery::Completed(None) | ControlledDelivery::Accepted(_) => {
                    let (current_definition, current_identity) =
                        self.selected_definition(schedule_id)?;
                    definition = current_definition;
                    identity = current_identity;
                }
                ControlledDelivery::RouteChanged | ControlledDelivery::ClockAdjusted => {}
                ControlledDelivery::Cancelled | ControlledDelivery::Shutdown => {
                    return Err(SchedulerTriggerError::Unavailable(
                        diagnostic_for_definition(TARGET_UNAVAILABLE, &definition),
                    ));
                }
            }
        }
    }

    /// Performs one manual trigger under an outer request identity. The
    /// replay ledger is scoped to this `SchedulerService`, and therefore to
    /// exactly one instance incarnation. It caches both successful delivery
    /// receipts and redacted selection failures without creating durable state.
    pub async fn trigger_with_request_id(
        &self,
        schedule_id: &str,
        request_id: Uuid,
    ) -> Result<ScheduleTriggerReport, SchedulerControlError> {
        let fingerprint = SchedulerMutationFingerprint::Trigger {
            schedule_id: schedule_id.to_string(),
        };
        match self.reserve_mutation(request_id, fingerprint).await? {
            SchedulerMutationReservation::Follower(completion) => {
                match self.await_mutation(completion).await {
                    SchedulerMutationOutcome::Trigger(result) => result,
                    SchedulerMutationOutcome::Refresh(_) => {
                        unreachable!("matching mutation fingerprints cannot change operation kind")
                    }
                }
            }
            SchedulerMutationReservation::Leader(completion) => {
                // See `refresh_with_request_id`: retain execution after an
                // endpoint loses its response, so a retry observes this exact
                // redacted receipt or failure instead of sending twice.
                let waiter = completion.subscribe();
                let service = self.clone();
                let schedule_id = schedule_id.to_string();
                tokio::spawn(async move {
                    let outcome = service.trigger_control_report(&schedule_id).await;
                    completion.send_replace(Some(SchedulerMutationOutcome::Trigger(outcome)));
                });
                match self.await_mutation(waiter).await {
                    SchedulerMutationOutcome::Trigger(result) => result,
                    SchedulerMutationOutcome::Refresh(_) => {
                        unreachable!("matching mutation fingerprints cannot change operation kind")
                    }
                }
            }
        }
    }

    async fn trigger_control_report(
        &self,
        schedule_id: &str,
    ) -> Result<ScheduleTriggerReport, SchedulerControlError> {
        self.trigger(schedule_id)
            .await
            .map(|delivery| ScheduleTriggerReport {
                schema_version: SCHEDULE_CONTROL_SCHEMA_VERSION,
                code: SCHEDULE_CONTROL_TRIGGERED.to_string(),
                inspection: self.inspect(),
                schedule_id: schedule_id.to_string(),
                delivery,
            })
            .map_err(SchedulerControlError::Trigger)
    }

    async fn reserve_mutation(
        &self,
        request_id: Uuid,
        fingerprint: SchedulerMutationFingerprint,
    ) -> Result<SchedulerMutationReservation, SchedulerControlError> {
        let mut mutations = self.inner.mutations.lock().await;
        match mutations.entry(request_id) {
            Entry::Occupied(entry) => {
                if entry.get().fingerprint != fingerprint {
                    return Err(SchedulerControlError::RequestIdConflict);
                }
                Ok(SchedulerMutationReservation::Follower(
                    entry.get().completion.subscribe(),
                ))
            }
            Entry::Vacant(entry) => {
                let (completion, _) = watch::channel(None);
                entry.insert(SchedulerMutationEntry {
                    fingerprint,
                    completion: completion.clone(),
                });
                Ok(SchedulerMutationReservation::Leader(completion))
            }
        }
    }

    async fn await_mutation(
        &self,
        mut completion: watch::Receiver<Option<SchedulerMutationOutcome>>,
    ) -> SchedulerMutationOutcome {
        loop {
            if let Some(outcome) = completion.borrow_and_update().clone() {
                return outcome;
            }
            completion
                .changed()
                .await
                .expect("scheduler mutation ledger retains its completion sender");
        }
    }

    fn selected_definition(
        &self,
        schedule_id: &str,
    ) -> Result<(ScheduleDefinition, SchedulerJobIdentity), SchedulerTriggerError> {
        let state = self
            .inner
            .state
            .lock()
            .expect("scheduler state mutex must not be poisoned");
        let definition = state
            .snapshot
            .definitions
            .iter()
            .find(|definition| definition.id == schedule_id)
            .cloned()
            .ok_or_else(|| SchedulerTriggerError::NotFound(not_found_diagnostic()))?;
        if !definition.enabled {
            return Err(SchedulerTriggerError::Disabled(diagnostic_for_definition(
                SCHEDULE_DISABLED,
                &definition,
            )));
        }
        let identity = SchedulerJobIdentity {
            definition_digest_sha256: definition.definition_digest_sha256.clone(),
        };
        Ok((definition, identity))
    }

    fn current_definition_matches(
        &self,
        definition: &ScheduleDefinition,
        identity: &SchedulerJobIdentity,
    ) -> bool {
        let state = self
            .inner
            .state
            .lock()
            .expect("scheduler state mutex must not be poisoned");
        snapshot_definition_matches(&state.snapshot, definition, identity)
    }

    fn set_next_occurrence(
        &self,
        definition: &ScheduleDefinition,
        identity: &SchedulerJobIdentity,
        next_occurrence_utc: Option<String>,
    ) {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("scheduler state mutex must not be poisoned");
        if snapshot_definition_provenance_matches(&state.snapshot, definition, identity) {
            if let Some(runtime) = state.runtime.get_mut(&definition.id) {
                runtime.next_occurrence_utc = next_occurrence_utc;
            }
        }
    }

    fn mark_route_available(
        &self,
        definition: &ScheduleDefinition,
        identity: &SchedulerJobIdentity,
    ) {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("scheduler state mutex must not be poisoned");
        if snapshot_definition_provenance_matches(&state.snapshot, definition, identity) {
            if let Some(runtime) = state.runtime.get_mut(&definition.id) {
                runtime.target_availability = ScheduleTargetAvailability::Available;
                runtime.diagnostic = None;
            }
        }
    }

    fn record_runtime_diagnostic(
        &self,
        definition: &ScheduleDefinition,
        identity: &SchedulerJobIdentity,
        diagnostic: ScheduleDiagnostic,
    ) {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("scheduler state mutex must not be poisoned");
        if snapshot_definition_provenance_matches(&state.snapshot, definition, identity) {
            if let Some(runtime) = state.runtime.get_mut(&definition.id) {
                runtime.target_availability = ScheduleTargetAvailability::Unavailable;
                runtime.diagnostic = Some(diagnostic);
            }
        }
    }

    fn record_delivery(
        &self,
        definition: &ScheduleDefinition,
        identity: &SchedulerJobIdentity,
        summary: ScheduleDeliverySummary,
    ) {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("scheduler state mutex must not be poisoned");
        if snapshot_definition_provenance_matches(&state.snapshot, definition, identity) {
            if let Some(runtime) = state.runtime.get_mut(&definition.id) {
                runtime.target_availability = match &summary.outcome {
                    ScheduleDeliveryOutcome::Delivered => ScheduleTargetAvailability::Available,
                    ScheduleDeliveryOutcome::Failed => ScheduleTargetAvailability::Unavailable,
                };
                runtime.diagnostic = summary.diagnostic.clone();
                runtime.last_attempt = Some(summary);
            }
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

fn accepted_snapshot_definition(
    accepted: &AcceptedScheduleSnapshot,
    definition: &ScheduleDefinition,
    identity: &SchedulerJobIdentity,
) -> Option<ScheduleDefinition> {
    accepted
        .snapshot
        .definitions
        .iter()
        .find(|current| definition_matches(current, definition, identity))
        .cloned()
}

fn snapshot_definition_matches(
    snapshot: &ScheduleSnapshot,
    definition: &ScheduleDefinition,
    identity: &SchedulerJobIdentity,
) -> bool {
    snapshot
        .definitions
        .iter()
        .any(|current| definition_matches(current, definition, identity))
}

fn snapshot_definition_provenance_matches(
    snapshot: &ScheduleSnapshot,
    definition: &ScheduleDefinition,
    identity: &SchedulerJobIdentity,
) -> bool {
    snapshot.definitions.iter().any(|current| {
        definition_matches(current, definition, identity)
            && current.source_path == definition.source_path
    })
}

fn definition_matches(
    current: &ScheduleDefinition,
    definition: &ScheduleDefinition,
    identity: &SchedulerJobIdentity,
) -> bool {
    current.id == definition.id
        && current.enabled
        && current.definition_digest_sha256 == identity.definition_digest_sha256
}

fn rebind_runtime_provenance(runtime: &mut ScheduleRuntimeState, definition: &ScheduleDefinition) {
    if let Some(summary) = &mut runtime.last_attempt {
        rebind_diagnostic_provenance(summary.diagnostic.as_mut(), definition);
    }
    rebind_diagnostic_provenance(runtime.diagnostic.as_mut(), definition);
}

fn rebind_diagnostic_provenance(
    diagnostic: Option<&mut ScheduleDiagnostic>,
    definition: &ScheduleDefinition,
) {
    if let Some(diagnostic) = diagnostic {
        diagnostic.source_path = Some(definition.source_path.clone());
        diagnostic.schedule_id = Some(definition.id.clone());
    }
}

fn deadline_for(now: Timestamp, due: Timestamp) -> Instant {
    let wait = now.duration_until(due);
    if wait.is_positive() {
        Instant::now()
            .checked_add(wait.unsigned_abs())
            .expect("cron deadline must fit Tokio instant")
    } else {
        Instant::now()
    }
}

fn not_found_diagnostic() -> ScheduleDiagnostic {
    ScheduleDiagnostic {
        schema_version: SCHEDULE_INSPECTION_SCHEMA_VERSION,
        code: SCHEDULE_NOT_FOUND.to_string(),
        severity: ScheduleDiagnosticSeverity::Error,
        source_path: None,
        schedule_id: None,
        context: Default::default(),
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
    Ok(next_occurrence_timestamp(definition, now)?.map(|occurrence| occurrence.to_string()))
}

fn next_occurrence_timestamp(
    definition: &ScheduleDefinition,
    now: Timestamp,
) -> Result<Option<Timestamp>, ScheduleDiagnostic> {
    if !definition.enabled {
        return Ok(None);
    }
    let schedule = cronexpr::parse_crontab(&definition.cron)
        .map_err(|_| diagnostic_for_definition(CRON_INVALID, definition))?;
    let next = schedule
        .find_next(now)
        .map_err(|_| diagnostic_for_definition(NEXT_OCCURRENCE_UNAVAILABLE, definition))?;
    Ok(Some(next.timestamp()))
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
        crate::message_bus::HANDLER_UNAVAILABLE => TARGET_UNAVAILABLE,
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

fn source_drift_diagnostic(
    accepted_snapshot_digest_sha256: &str,
    candidate_snapshot_digest_sha256: &str,
) -> ScheduleDiagnostic {
    ScheduleDiagnostic {
        schema_version: SCHEDULE_INSPECTION_SCHEMA_VERSION,
        code: SNAPSHOT_SOURCE_DRIFT.to_string(),
        severity: ScheduleDiagnosticSeverity::Warning,
        source_path: None,
        schedule_id: None,
        context: super::diagnostics::RedactedScheduleContext {
            fields: BTreeMap::from([
                (
                    "acceptedSnapshotDigestSha256".to_string(),
                    accepted_snapshot_digest_sha256.to_string(),
                ),
                (
                    "candidateSnapshotDigestSha256".to_string(),
                    candidate_snapshot_digest_sha256.to_string(),
                ),
            ]),
        },
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
    use std::time::Duration;

    use serde_json::json;
    use sha2::{Digest, Sha256};
    use tempfile::{tempdir, TempDir};
    use tokio::sync::Notify;
    use tokio::time::advance;
    use uuid::Uuid;

    use crate::instance::{InstanceBuildIdentity, LaunchProvenance, RootSource};
    use crate::message_bus::{
        BroadcastTopicDeclaration, DirectedChannelDeclaration, MessageContractError,
        MessageDeclarations, MessageSchemaDescriptor, MessageTypeContract, ModuleMessageAuthority,
        PreparedRegistration, RegistrationHandlers, RouteEndpointRef,
    };
    use crate::module_control::registry::ModuleRegistry;
    use crate::module_control::ModuleGrant;

    use super::*;

    const MESSAGE: &str = "fixture.agent-wakeup";
    const JSON_SCHEMA_DRAFT: &str = "https://json-schema.org/draft/2020-12/schema";

    #[derive(Clone)]
    struct TestSchedulerClock {
        inner: Arc<TestSchedulerClockInner>,
    }

    struct TestSchedulerClockInner {
        state: Mutex<TestClockState>,
        adjustments: watch::Sender<()>,
    }

    struct TestClockState {
        wall_at_anchor: Timestamp,
        anchor: Instant,
    }

    impl TestSchedulerClock {
        fn new(wall: Timestamp) -> Self {
            let (adjustments, _) = watch::channel(());
            Self {
                inner: Arc::new(TestSchedulerClockInner {
                    state: Mutex::new(TestClockState {
                        wall_at_anchor: wall,
                        anchor: Instant::now(),
                    }),
                    adjustments,
                }),
            }
        }

        fn set(&self, wall: Timestamp) {
            let mut state = self
                .inner
                .state
                .lock()
                .expect("test scheduler clock mutex must not be poisoned");
            state.wall_at_anchor = wall;
            state.anchor = Instant::now();
            drop(state);
            self.inner.adjustments.send_replace(());
        }
    }

    impl SchedulerClock for TestSchedulerClock {
        fn now(&self) -> Timestamp {
            let state = self
                .inner
                .state
                .lock()
                .expect("test scheduler clock mutex must not be poisoned");
            state
                .wall_at_anchor
                .checked_add(Instant::now().duration_since(state.anchor))
                .expect("test scheduler clock remains in timestamp range")
        }

        fn subscribe_adjustments(&self) -> watch::Receiver<()> {
            self.inner.adjustments.subscribe()
        }
    }

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

    async fn register_notifying_channel(
        context: &InstanceContext,
        bus: &RuntimeMessageBus,
        endpoint: &str,
    ) -> (Arc<AtomicUsize>, Arc<Notify>) {
        register_notifying_channel_as(context, bus, "fixture@scheduler#notifying", endpoint).await
    }

    async fn register_notifying_channel_as(
        context: &InstanceContext,
        bus: &RuntimeMessageBus,
        activation_id: &str,
        endpoint: &str,
    ) -> (Arc<AtomicUsize>, Arc<Notify>) {
        let handled = Arc::new(AtomicUsize::new(0));
        let delivered = Arc::new(Notify::new());
        let handler_count = Arc::clone(&handled);
        let handler_delivered = Arc::clone(&delivered);
        let registration = Arc::new(
            PreparedRegistration::prepare(
                context,
                activation_id,
                &[] as &[ModuleGrant],
                declarations_for(MESSAGE, &[(endpoint, true)], Vec::new(), 256),
                RegistrationHandlers::new().with_directed(endpoint.to_string(), move |_| {
                    let handler_count = Arc::clone(&handler_count);
                    let handler_delivered = Arc::clone(&handler_delivered);
                    async move {
                        handler_count.fetch_add(1, Ordering::SeqCst);
                        handler_delivered.notify_one();
                        Ok::<(), MessageContractError>(())
                    }
                }),
            )
            .unwrap(),
        );
        bus.register(registration).await.unwrap();
        (handled, delivered)
    }

    async fn register_blocking_channel(
        context: &InstanceContext,
        bus: &RuntimeMessageBus,
        endpoint: &str,
    ) -> (
        Arc<PreparedRegistration>,
        Arc<AtomicUsize>,
        Arc<Notify>,
        Arc<Notify>,
    ) {
        let handled = Arc::new(AtomicUsize::new(0));
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let handler_count = Arc::clone(&handled);
        let handler_entered = Arc::clone(&entered);
        let handler_release = Arc::clone(&release);
        let registration = Arc::new(
            PreparedRegistration::prepare(
                context,
                "fixture@scheduler#blocked",
                &[] as &[ModuleGrant],
                declarations_for(MESSAGE, &[(endpoint, true)], Vec::new(), 256),
                RegistrationHandlers::new().with_directed(endpoint.to_string(), move |_| {
                    let handler_count = Arc::clone(&handler_count);
                    let handler_entered = Arc::clone(&handler_entered);
                    let handler_release = Arc::clone(&handler_release);
                    async move {
                        if handler_count.fetch_add(1, Ordering::SeqCst) == 0 {
                            handler_entered.notify_one();
                            handler_release.notified().await;
                        }
                        Ok::<(), MessageContractError>(())
                    }
                }),
            )
            .unwrap(),
        );
        bus.register(Arc::clone(&registration)).await.unwrap();
        (registration, handled, entered, release)
    }

    async fn register_failing_channel(
        context: &InstanceContext,
        bus: &RuntimeMessageBus,
        activation_id: &str,
        endpoint: &str,
    ) -> Arc<AtomicUsize> {
        let handled = Arc::new(AtomicUsize::new(0));
        let handler_count = Arc::clone(&handled);
        let registration = Arc::new(
            PreparedRegistration::prepare(
                context,
                activation_id,
                &[] as &[ModuleGrant],
                declarations_for(MESSAGE, &[(endpoint, true)], Vec::new(), 256),
                RegistrationHandlers::new().with_directed(endpoint.to_string(), move |_| {
                    let handler_count = Arc::clone(&handler_count);
                    async move {
                        handler_count.fetch_add(1, Ordering::SeqCst);
                        Err(MessageContractError::new(
                            crate::message_bus::HANDLER_FAILED,
                            "fixture handler failure",
                        ))
                    }
                }),
            )
            .unwrap(),
        );
        bus.register(registration).await.unwrap();
        handled
    }

    async fn prepare_backpressured_manual_trigger(
        temporary: &TempDir,
        instance_name: &str,
    ) -> (
        SchedulerService,
        RuntimeMessageBus,
        PathBuf,
        Arc<PreparedRegistration>,
        Arc<Notify>,
        JoinHandle<Result<ScheduleDeliverySummary, SchedulerTriggerError>>,
    ) {
        let schedule_root = temporary.path().join("schedules");
        replace_schedule(
            &schedule_root,
            "agents.manual",
            true,
            "* * * * * Etc/UTC",
            "channel",
            "agents.manual",
        );
        let context = context(instance_name, temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let clock = TestSchedulerClock::new("2026-08-09T07:00:00Z".parse().unwrap());
        let service =
            SchedulerService::new_with_clock(context, &schedule_root, bus.clone(), Arc::new(clock))
                .unwrap();
        let (blocked, _count, entered, release) =
            register_blocking_channel(&service.inner.context, &bus, "agents.manual").await;
        assert!(service.refresh().await.applied);
        tokio::task::yield_now().await;
        service.trigger("agents.manual").await.unwrap();
        entered.notified().await;
        service.trigger("agents.manual").await.unwrap();
        service.trigger("agents.manual").await.unwrap();

        let trigger = tokio::spawn({
            let service = service.clone();
            async move { service.trigger("agents.manual").await }
        });
        tokio::task::yield_now().await;
        assert!(
            !trigger.is_finished(),
            "a full channel queue must leave the manual send pending"
        );
        (service, bus, schedule_root, blocked, release, trigger)
    }

    async fn register_topic(
        context: &InstanceContext,
        bus: &RuntimeMessageBus,
        endpoint: &str,
        scheduler_allowed: bool,
    ) {
        let mut declarations = declarations_for(MESSAGE, &[], Vec::new(), 256);
        declarations.publishes = vec![BroadcastTopicDeclaration {
            endpoint: RouteEndpointRef {
                id: endpoint.to_string(),
                message: message_for(MESSAGE),
            },
            capacity: 2,
            required_grant: format!("message.publish.{endpoint}"),
            scheduler_allowed,
        }];
        let registration = Arc::new(
            PreparedRegistration::prepare(
                context,
                "fixture@scheduler#topic",
                &[] as &[ModuleGrant],
                declarations,
                RegistrationHandlers::new(),
            )
            .unwrap(),
        );
        bus.register(registration).await.unwrap();
    }

    fn topic_subscriber(endpoint: &str) -> ModuleMessageAuthority {
        ModuleMessageAuthority::from_host(
            "fixture@scheduler#subscriber",
            &[ModuleGrant {
                id: format!("message.subscribe.{endpoint}"),
                effective: true,
            }],
        )
    }

    fn clear_schedule_root(root: &Path) {
        fs::create_dir_all(root).unwrap();
        for entry in fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            fs::remove_file(path).unwrap();
        }
    }

    fn write_schedule(
        root: &Path,
        filename: &str,
        id: &str,
        enabled: bool,
        cron: &str,
        target_kind: &str,
        endpoint: &str,
        payload: serde_json::Value,
    ) {
        fs::create_dir_all(root).unwrap();
        fs::write(
            root.join(filename),
            format!(
                "schema_version: 1\nid: {id}\nenabled: {enabled}\ncron: {cron:?}\ntarget:\n  kind: {target_kind}\n  id: {endpoint}\nmessage:\n  type: {MESSAGE}\n  version: 1\n  payload: {}\n",
                serde_json::to_string(&payload).unwrap(),
            ),
        )
        .unwrap();
    }

    fn replace_schedule(
        root: &Path,
        id: &str,
        enabled: bool,
        cron: &str,
        target_kind: &str,
        endpoint: &str,
    ) {
        clear_schedule_root(root);
        write_schedule(
            root,
            "schedule.yaml",
            id,
            enabled,
            cron,
            target_kind,
            endpoint,
            json!({"reason": "scheduled"}),
        );
    }

    fn durable_tree_digest(root: &Path) -> String {
        fn collect(root: &Path, path: &Path, files: &mut BTreeMap<String, Vec<u8>>) {
            if !path.exists() {
                return;
            }
            if path.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .expect("durable path must stay under its root")
                    .to_string_lossy()
                    .replace('\\', "/");
                files.insert(relative, fs::read(path).unwrap());
                return;
            }
            let mut entries = fs::read_dir(path)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect::<Vec<_>>();
            entries.sort();
            for entry in entries {
                collect(root, &entry, files);
            }
        }

        let mut files = BTreeMap::new();
        collect(root, root, &mut files);
        format!("{:x}", Sha256::digest(serde_json::to_vec(&files).unwrap()))
    }

    fn write_fixture(root: &Path, fixture: &str) {
        clear_schedule_root(root);
        let contents = match fixture {
            "valid-channel.yaml" => {
                include_str!("../../fixtures/scheduler/sources/valid-channel.yaml")
            }
            "invalid-unknown-field.yaml" => {
                include_str!("../../fixtures/scheduler/sources/invalid-unknown-field.yaml")
            }
            "secret-payload.yaml" => {
                include_str!("../../fixtures/scheduler/sources/secret-payload.yaml")
            }
            "unavailable-target.yaml" => {
                include_str!("../../fixtures/scheduler/sources/unavailable-target.yaml")
            }
            "unauthorized-target.yaml" => {
                include_str!("../../fixtures/scheduler/sources/unauthorized-target.yaml")
            }
            "disabled.yaml" => {
                include_str!("../../fixtures/scheduler/sources/disabled.yaml")
            }
            "incompatible-target.yaml" => {
                include_str!("../../fixtures/scheduler/sources/incompatible-target.yaml")
            }
            "invalid-payload.yaml" => {
                include_str!("../../fixtures/scheduler/sources/invalid-payload.yaml")
            }
            "oversized-payload.yaml" => {
                include_str!("../../fixtures/scheduler/sources/oversized-payload.yaml")
            }
            other => panic!("unknown scheduler fixture {other}"),
        };
        fs::write(root.join("schedule.yaml"), contents).unwrap();
    }

    #[test]
    fn next_occurrence_is_future_and_disabled_schedules_have_no_deadline() {
        let source = include_str!("../../fixtures/scheduler/sources/valid-channel.yaml");
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
        let source = include_str!("../../fixtures/scheduler/sources/dst-australia.yaml");
        let definition =
            super::super::parse_schedule_source(Path::new("dst.yaml"), source).unwrap();
        let now = "2026-10-03T15:59:00Z".parse::<Timestamp>().unwrap();

        let next = next_occurrence_utc(&definition, now).unwrap().unwrap();
        assert!(next.parse::<Timestamp>().unwrap() > now);
        assert!(next.ends_with('Z'));
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn due_channel_and_manual_trigger_share_typed_delivery_without_durable_writes() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        replace_schedule(
            &schedule_root,
            "agents.timer",
            true,
            "* * * * * Etc/UTC",
            "channel",
            "agents.timer",
        );
        let context = context("scheduler-timer", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let clock = TestSchedulerClock::new("2026-08-09T07:00:00Z".parse().unwrap());
        let service = SchedulerService::new_with_clock(
            context,
            &schedule_root,
            bus.clone(),
            Arc::new(clock.clone()),
        )
        .unwrap();
        let (handled, delivered) =
            register_notifying_channel(&service.inner.context, &bus, "agents.timer").await;
        let paths = service.inner.context.paths();
        drop(ModuleRegistry::open_writable(&paths).unwrap());
        let durable_before = durable_tree_digest(&paths.state_root);
        let source_before = fs::read(schedule_root.join("schedule.yaml")).unwrap();

        let refresh = service.refresh().await;
        assert!(refresh.applied, "{:?}", refresh.diagnostics);
        tokio::task::yield_now().await;
        assert_eq!(service.active_job_count(), 1);
        let before_manual = service.inspect();
        let next_before_manual = before_manual.schedules[0].next_occurrence_utc.clone();
        let generation_before_manual = before_manual.schedule_generation;

        let manual = service.trigger("agents.timer").await.unwrap();
        delivered.notified().await;
        assert_eq!(manual.outcome, ScheduleDeliveryOutcome::Delivered);
        assert_eq!(handled.load(Ordering::SeqCst), 1);
        let after_manual = service.inspect();
        assert_eq!(after_manual.schedule_generation, generation_before_manual);
        assert_eq!(
            after_manual.schedules[0].next_occurrence_utc,
            next_before_manual
        );

        advance(Duration::from_secs(60)).await;
        delivered.notified().await;
        assert_eq!(handled.load(Ordering::SeqCst), 2);
        let after_due = service.inspect();
        let schedule = &after_due.schedules[0];
        assert_eq!(
            schedule
                .last_attempt
                .as_ref()
                .map(|attempt| &attempt.outcome),
            Some(&ScheduleDeliveryOutcome::Delivered)
        );
        assert!(schedule
            .next_occurrence_utc
            .as_deref()
            .and_then(|value| value.parse::<Timestamp>().ok())
            .is_some_and(|next| next > clock.now()));
        assert_eq!(
            fs::read(schedule_root.join("schedule.yaml")).unwrap(),
            source_before
        );
        assert_eq!(durable_tree_digest(&paths.state_root), durable_before);

        service.shutdown();
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn due_topic_schedule_publishes_once_to_current_subscribers() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        replace_schedule(
            &schedule_root,
            "agents.status.timer",
            true,
            "* * * * * Etc/UTC",
            "topic",
            "agents.status",
        );
        let context = context("scheduler-topic", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let clock = TestSchedulerClock::new("2026-08-09T07:00:00Z".parse().unwrap());
        let service =
            SchedulerService::new_with_clock(context, &schedule_root, bus.clone(), Arc::new(clock))
                .unwrap();
        register_topic(&service.inner.context, &bus, "agents.status", true).await;
        let mut subscriber = bus
            .subscribe(&topic_subscriber("agents.status"), "agents.status")
            .unwrap();

        assert!(service.refresh().await.applied);
        tokio::task::yield_now().await;
        advance(Duration::from_secs(60)).await;
        let delivered = subscriber.recv_delivery().await.unwrap();
        assert_eq!(delivered.envelope.endpoint, "agents.status");
        assert_eq!(delivered.envelope.payload, json!({"reason": "scheduled"}));
        assert_eq!(delivered.route_generation, bus.snapshot().route_generation);
        let endpoint = bus
            .inspect_endpoints()
            .await
            .into_iter()
            .find(|endpoint| endpoint.endpoint == "agents.status")
            .unwrap();
        assert_eq!(endpoint.accepted, 1);

        service.shutdown();
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn changed_refresh_cancels_the_old_deadline_before_cross_generation_delivery() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        replace_schedule(
            &schedule_root,
            "agents.work",
            true,
            "* * * * * Etc/UTC",
            "channel",
            "agents.old",
        );
        let context = context("scheduler-change", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let clock = TestSchedulerClock::new("2026-08-09T07:00:00Z".parse().unwrap());
        let service =
            SchedulerService::new_with_clock(context, &schedule_root, bus.clone(), Arc::new(clock))
                .unwrap();
        let (old_count, _) = register_notifying_channel_as(
            &service.inner.context,
            &bus,
            "fixture@scheduler#old",
            "agents.old",
        )
        .await;
        let (new_count, new_delivery) = register_notifying_channel_as(
            &service.inner.context,
            &bus,
            "fixture@scheduler#new",
            "agents.new",
        )
        .await;

        assert!(service.refresh().await.applied);
        tokio::task::yield_now().await;
        replace_schedule(
            &schedule_root,
            "agents.work",
            true,
            "* * * * * Etc/UTC",
            "channel",
            "agents.new",
        );
        assert!(service.refresh().await.applied);
        assert_eq!(service.active_job_count(), 1);

        advance(Duration::from_secs(60)).await;
        new_delivery.notified().await;
        assert_eq!(old_count.load(Ordering::SeqCst), 0);
        assert_eq!(new_count.load(Ordering::SeqCst), 1);
        assert_eq!(service.inspect().schedules[0].target.id, "agents.new");

        service.shutdown();
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn route_withdrawal_cancels_a_backpressured_delivery_before_rearming() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        replace_schedule(
            &schedule_root,
            "agents.blocked",
            true,
            "* * * * * Etc/UTC",
            "channel",
            "agents.blocked",
        );
        let context = context("scheduler-backpressure", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let clock = TestSchedulerClock::new("2026-08-09T07:00:00Z".parse().unwrap());
        let service =
            SchedulerService::new_with_clock(context, &schedule_root, bus.clone(), Arc::new(clock))
                .unwrap();
        let (blocked, _blocked_count, entered, release) =
            register_blocking_channel(&service.inner.context, &bus, "agents.blocked").await;

        assert!(service.refresh().await.applied);
        tokio::task::yield_now().await;
        // One handler is held and the two-slot route queue is full. The due
        // timer's fourth send must remain pending until the route update
        // cancels its future, rather than pinning this job to the old route.
        service.trigger("agents.blocked").await.unwrap();
        entered.notified().await;
        service.trigger("agents.blocked").await.unwrap();
        service.trigger("agents.blocked").await.unwrap();
        advance(Duration::from_secs(60)).await;
        tokio::task::yield_now().await;

        bus.withdraw(blocked.activation_id()).await.unwrap();
        let (replacement_count, replacement_delivery) = register_notifying_channel_as(
            &service.inner.context,
            &bus,
            "fixture@scheduler#replacement",
            "agents.blocked",
        )
        .await;

        loop {
            if service.inspect().schedules[0]
                .next_occurrence_utc
                .as_deref()
                == Some("2026-08-09T07:02:00Z")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        advance(Duration::from_secs(60)).await;
        replacement_delivery.notified().await;
        assert_eq!(replacement_count.load(Ordering::SeqCst), 1);

        release.notify_one();
        blocked.dispose().await;
        service.shutdown();
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn manual_trigger_drops_a_backpressured_send_when_disabled() {
        let temporary = tempdir().unwrap();
        let (service, bus, schedule_root, blocked, release, trigger) =
            prepare_backpressured_manual_trigger(&temporary, "scheduler-manual-disable").await;

        replace_schedule(
            &schedule_root,
            "agents.manual",
            false,
            "* * * * * Etc/UTC",
            "channel",
            "agents.manual",
        );
        assert!(service.refresh().await.applied);
        let error = trigger.await.unwrap().unwrap_err();
        assert_eq!(error.diagnostic().code, SCHEDULE_DISABLED);

        bus.withdraw(blocked.activation_id()).await.unwrap();
        release.notify_one();
        blocked.dispose().await;
        service.shutdown();
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn manual_trigger_drops_a_backpressured_send_when_its_route_is_withdrawn() {
        let temporary = tempdir().unwrap();
        let (service, bus, _schedule_root, blocked, release, trigger) =
            prepare_backpressured_manual_trigger(&temporary, "scheduler-manual-withdrawal").await;

        bus.withdraw(blocked.activation_id()).await.unwrap();
        let summary = trigger.await.unwrap().unwrap();
        assert_eq!(summary.outcome, ScheduleDeliveryOutcome::Failed);
        assert_eq!(
            summary
                .diagnostic
                .as_ref()
                .map(|diagnostic| diagnostic.code.as_str()),
            Some(TARGET_UNAVAILABLE)
        );

        release.notify_one();
        blocked.dispose().await;
        service.shutdown();
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn manual_trigger_drops_a_backpressured_send_during_shutdown() {
        let temporary = tempdir().unwrap();
        let (service, bus, _schedule_root, blocked, release, trigger) =
            prepare_backpressured_manual_trigger(&temporary, "scheduler-manual-shutdown").await;

        service.shutdown();
        let error = trigger.await.unwrap().unwrap_err();
        assert_eq!(error.diagnostic().code, TARGET_UNAVAILABLE);

        bus.withdraw(blocked.activation_id()).await.unwrap();
        release.notify_one();
        blocked.dispose().await;
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn disabled_and_removed_schedules_cancel_waits_and_manual_trigger_rejects_disabled() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        replace_schedule(
            &schedule_root,
            "agents.cancel",
            true,
            "* * * * * Etc/UTC",
            "channel",
            "agents.cancel",
        );
        let context = context("scheduler-cancel", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let clock = TestSchedulerClock::new("2026-08-09T07:00:00Z".parse().unwrap());
        let service =
            SchedulerService::new_with_clock(context, &schedule_root, bus.clone(), Arc::new(clock))
                .unwrap();
        let (handled, _) =
            register_notifying_channel(&service.inner.context, &bus, "agents.cancel").await;

        assert!(service.refresh().await.applied);
        tokio::task::yield_now().await;
        assert_eq!(service.active_job_count(), 1);
        replace_schedule(
            &schedule_root,
            "agents.cancel",
            false,
            "* * * * * Etc/UTC",
            "channel",
            "agents.cancel",
        );
        assert!(service.refresh().await.applied);
        assert_eq!(service.active_job_count(), 0);
        let disabled = service.trigger("agents.cancel").await.unwrap_err();
        assert_eq!(disabled.diagnostic().code, SCHEDULE_DISABLED);
        advance(Duration::from_secs(60)).await;
        assert_eq!(handled.load(Ordering::SeqCst), 0);

        replace_schedule(
            &schedule_root,
            "agents.cancel",
            true,
            "* * * * * Etc/UTC",
            "channel",
            "agents.cancel",
        );
        assert!(service.refresh().await.applied);
        tokio::task::yield_now().await;
        assert_eq!(service.active_job_count(), 1);
        clear_schedule_root(&schedule_root);
        assert!(service.refresh().await.applied);
        assert_eq!(service.active_job_count(), 0);
        advance(Duration::from_secs(60)).await;
        assert_eq!(handled.load(Ordering::SeqCst), 0);

        service.shutdown();
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn withdrawn_target_is_redacted_and_does_not_stop_an_unrelated_schedule() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        clear_schedule_root(&schedule_root);
        write_schedule(
            &schedule_root,
            "bad.yaml",
            "agents.bad",
            true,
            "* * * * * Etc/UTC",
            "channel",
            "agents.bad",
            json!({"reason": "scheduled"}),
        );
        write_schedule(
            &schedule_root,
            "good.yaml",
            "agents.good",
            true,
            "* * * * * Etc/UTC",
            "channel",
            "agents.good",
            json!({"reason": "scheduled"}),
        );
        let context = context("scheduler-withdrawal", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let clock = TestSchedulerClock::new("2026-08-09T07:00:00Z".parse().unwrap());
        let service =
            SchedulerService::new_with_clock(context, &schedule_root, bus.clone(), Arc::new(clock))
                .unwrap();
        let (withdrawn_count, _) = register_notifying_channel_as(
            &service.inner.context,
            &bus,
            "fixture@scheduler#bad",
            "agents.bad",
        )
        .await;
        let (healthy_count, healthy_delivery) = register_notifying_channel_as(
            &service.inner.context,
            &bus,
            "fixture@scheduler#good",
            "agents.good",
        )
        .await;
        assert!(service.refresh().await.applied);
        tokio::task::yield_now().await;
        assert_eq!(service.active_job_count(), 2);

        bus.withdraw("fixture@scheduler#bad").await.unwrap();
        tokio::task::yield_now().await;
        advance(Duration::from_secs(60)).await;
        healthy_delivery.notified().await;
        tokio::task::yield_now().await;
        assert_eq!(withdrawn_count.load(Ordering::SeqCst), 0);
        assert_eq!(healthy_count.load(Ordering::SeqCst), 1);
        let failed = service
            .inspect()
            .schedules
            .into_iter()
            .find(|schedule| schedule.id == "agents.bad")
            .unwrap();
        assert_eq!(
            failed.last_attempt.as_ref().map(|attempt| &attempt.outcome),
            Some(&ScheduleDeliveryOutcome::Failed)
        );
        assert_eq!(
            failed
                .last_attempt
                .as_ref()
                .and_then(|attempt| attempt.diagnostic.as_ref())
                .map(|diagnostic| diagnostic.code.as_str()),
            Some(TARGET_UNAVAILABLE)
        );
        assert_eq!(
            failed
                .last_attempt
                .as_ref()
                .map(|attempt| attempt.route_generation),
            Some(bus.snapshot().route_generation)
        );
        assert_eq!(
            failed.target_availability,
            ScheduleTargetAvailability::Unavailable
        );
        let rendered = serde_json::to_string(&failed).unwrap();
        assert!(!rendered.contains("scheduled"));
        assert!(!rendered.contains("message-bus validation"));
        assert_eq!(service.active_job_count(), 2);

        let (recovered_count, recovered_delivery) = register_notifying_channel_as(
            &service.inner.context,
            &bus,
            "fixture@scheduler#bad",
            "agents.bad",
        )
        .await;
        tokio::task::yield_now().await;
        advance(Duration::from_secs(60)).await;
        recovered_delivery.notified().await;
        assert_eq!(recovered_count.load(Ordering::SeqCst), 1);
        let recovered = service
            .inspect()
            .schedules
            .into_iter()
            .find(|schedule| schedule.id == "agents.bad")
            .unwrap();
        assert_eq!(
            recovered
                .last_attempt
                .as_ref()
                .map(|attempt| &attempt.outcome),
            Some(&ScheduleDeliveryOutcome::Delivered)
        );
        assert_eq!(
            recovered.target_availability,
            ScheduleTargetAvailability::Available
        );
        assert!(recovered.diagnostic.is_none());

        service.shutdown();
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn retained_jobs_rebind_diagnostics_when_their_source_is_renamed() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        write_schedule(
            &schedule_root,
            "original.yaml",
            "agents.rename",
            true,
            "* * * * * Etc/UTC",
            "channel",
            "agents.rename",
            json!({"reason": "scheduled"}),
        );
        let context = context("scheduler-source-rename", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let clock = TestSchedulerClock::new("2026-08-09T07:00:00Z".parse().unwrap());
        let service =
            SchedulerService::new_with_clock(context, &schedule_root, bus.clone(), Arc::new(clock))
                .unwrap();
        let (_old_count, _) = register_notifying_channel_as(
            &service.inner.context,
            &bus,
            "fixture@scheduler#original",
            "agents.rename",
        )
        .await;

        assert!(service.refresh().await.applied);
        tokio::task::yield_now().await;
        bus.withdraw("fixture@scheduler#original").await.unwrap();
        let failed = service.trigger("agents.rename").await.unwrap();
        assert_eq!(failed.outcome, ScheduleDeliveryOutcome::Failed);
        assert_eq!(
            failed
                .diagnostic
                .as_ref()
                .and_then(|diagnostic| diagnostic.source_path.as_deref()),
            Some("original.yaml")
        );

        let (_replacement_count, _) = register_notifying_channel_as(
            &service.inner.context,
            &bus,
            "fixture@scheduler#renamed",
            "agents.rename",
        )
        .await;
        fs::rename(
            schedule_root.join("original.yaml"),
            schedule_root.join("renamed.yaml"),
        )
        .unwrap();
        assert!(service.refresh().await.applied);
        assert_eq!(service.active_job_count(), 1);
        let retained = service.inspect().schedules.remove(0);
        assert_eq!(retained.source_path, "renamed.yaml");
        assert_eq!(
            retained
                .last_attempt
                .as_ref()
                .and_then(|attempt| attempt.diagnostic.as_ref())
                .and_then(|diagnostic| diagnostic.source_path.as_deref()),
            Some("renamed.yaml")
        );

        bus.withdraw("fixture@scheduler#renamed").await.unwrap();
        loop {
            let schedule = service.inspect().schedules.remove(0);
            if schedule
                .diagnostic
                .as_ref()
                .is_some_and(|diagnostic| diagnostic.code == TARGET_UNAVAILABLE)
            {
                assert_eq!(schedule.source_path, "renamed.yaml");
                assert_eq!(
                    schedule
                        .diagnostic
                        .as_ref()
                        .and_then(|diagnostic| diagnostic.source_path.as_deref()),
                    Some("renamed.yaml")
                );
                break;
            }
            tokio::task::yield_now().await;
        }

        service.shutdown();
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn incompatible_live_route_is_redacted_then_recovers_without_recreating_the_job() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        replace_schedule(
            &schedule_root,
            "agents.incompatible",
            true,
            "* * * * * Etc/UTC",
            "channel",
            "agents.incompatible",
        );
        let context = context("scheduler-incompatible", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let clock = TestSchedulerClock::new("2026-08-09T07:00:00Z".parse().unwrap());
        let service =
            SchedulerService::new_with_clock(context, &schedule_root, bus.clone(), Arc::new(clock))
                .unwrap();
        let (_initial_count, _) = register_notifying_channel_as(
            &service.inner.context,
            &bus,
            "fixture@scheduler#compatible",
            "agents.incompatible",
        )
        .await;
        assert!(service.refresh().await.applied);
        tokio::task::yield_now().await;
        assert_eq!(service.active_job_count(), 1);

        bus.withdraw("fixture@scheduler#compatible").await.unwrap();
        register_channels_with_contract(
            &service.inner.context,
            &bus,
            "fixture@scheduler#incompatible",
            "fixture.incompatible-message",
            &[("agents.incompatible", true)],
            Vec::new(),
            256,
        )
        .await;
        loop {
            let schedule = service.inspect().schedules.remove(0);
            if schedule
                .diagnostic
                .as_ref()
                .is_some_and(|diagnostic| diagnostic.code == TARGET_MESSAGE_INCOMPATIBLE)
            {
                assert_eq!(
                    schedule.target_availability,
                    ScheduleTargetAvailability::Unavailable
                );
                assert_eq!(service.active_job_count(), 1);
                break;
            }
            tokio::task::yield_now().await;
        }

        bus.withdraw("fixture@scheduler#incompatible")
            .await
            .unwrap();
        let (recovered_count, recovered_delivery) = register_notifying_channel_as(
            &service.inner.context,
            &bus,
            "fixture@scheduler#recovered",
            "agents.incompatible",
        )
        .await;
        loop {
            let schedule = service.inspect().schedules.remove(0);
            if schedule.target_availability == ScheduleTargetAvailability::Available {
                assert!(schedule.diagnostic.is_none());
                break;
            }
            tokio::task::yield_now().await;
        }
        advance(Duration::from_secs(60)).await;
        recovered_delivery.notified().await;
        assert_eq!(recovered_count.load(Ordering::SeqCst), 1);
        service.shutdown();
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn handler_failure_is_redacted_in_bus_observation_and_does_not_delay_a_healthy_job() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        clear_schedule_root(&schedule_root);
        write_schedule(
            &schedule_root,
            "failing.yaml",
            "agents.failing",
            true,
            "* * * * * Etc/UTC",
            "channel",
            "agents.failing",
            json!({"reason": "scheduled"}),
        );
        write_schedule(
            &schedule_root,
            "healthy.yaml",
            "agents.healthy",
            true,
            "* * * * * Etc/UTC",
            "channel",
            "agents.healthy",
            json!({"reason": "scheduled"}),
        );
        let context = context("scheduler-handler-failure", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let clock = TestSchedulerClock::new("2026-08-09T07:00:00Z".parse().unwrap());
        let service =
            SchedulerService::new_with_clock(context, &schedule_root, bus.clone(), Arc::new(clock))
                .unwrap();
        let failing_count = register_failing_channel(
            &service.inner.context,
            &bus,
            "fixture@scheduler#failing",
            "agents.failing",
        )
        .await;
        let (healthy_count, healthy_delivery) = register_notifying_channel_as(
            &service.inner.context,
            &bus,
            "fixture@scheduler#healthy",
            "agents.healthy",
        )
        .await;

        assert!(service.refresh().await.applied);
        tokio::task::yield_now().await;
        advance(Duration::from_secs(60)).await;
        healthy_delivery.notified().await;
        loop {
            let observation = bus
                .inspect_endpoints()
                .await
                .into_iter()
                .find(|endpoint| endpoint.endpoint == "agents.failing")
                .unwrap();
            if observation.failed == 1 {
                assert_eq!(
                    observation
                        .last_failure
                        .as_ref()
                        .map(|failure| failure.code.as_str()),
                    Some(crate::message_bus::HANDLER_FAILED)
                );
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(failing_count.load(Ordering::SeqCst), 1);
        assert_eq!(healthy_count.load(Ordering::SeqCst), 1);
        let failing_schedule = service
            .inspect()
            .schedules
            .into_iter()
            .find(|schedule| schedule.id == "agents.failing")
            .unwrap();
        assert_eq!(
            failing_schedule.last_attempt.as_ref().map(|attempt| &attempt.outcome),
            Some(&ScheduleDeliveryOutcome::Delivered),
            "the scheduler receipt is an accepted typed delivery; handler failure remains bus-owned"
        );
        advance(Duration::from_secs(30)).await;
        assert_eq!(failing_count.load(Ordering::SeqCst), 1);
        assert_eq!(healthy_count.load(Ordering::SeqCst), 1);
        service.shutdown();
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn suspended_and_backward_clock_time_never_replays_missed_occurrences() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        replace_schedule(
            &schedule_root,
            "agents.clock",
            true,
            "* * * * * Etc/UTC",
            "channel",
            "agents.clock",
        );
        let context = context("scheduler-clock", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let clock = TestSchedulerClock::new("2026-08-09T07:00:00Z".parse().unwrap());
        let service = SchedulerService::new_with_clock(
            context,
            &schedule_root,
            bus.clone(),
            Arc::new(clock.clone()),
        )
        .unwrap();
        let (handled, delivered) =
            register_notifying_channel(&service.inner.context, &bus, "agents.clock").await;

        assert!(service.refresh().await.applied);
        tokio::task::yield_now().await;
        advance(Duration::from_secs(10 * 60)).await;
        tokio::task::yield_now().await;
        assert_eq!(handled.load(Ordering::SeqCst), 0);
        assert_eq!(
            service.inspect().schedules[0]
                .next_occurrence_utc
                .as_deref(),
            Some("2026-08-09T07:11:00Z")
        );

        advance(Duration::from_secs(60)).await;
        delivered.notified().await;
        assert_eq!(handled.load(Ordering::SeqCst), 1);

        clock.set("2026-08-09T07:05:00Z".parse().unwrap());
        tokio::task::yield_now().await;
        assert_eq!(
            service.inspect().schedules[0]
                .next_occurrence_utc
                .as_deref(),
            Some("2026-08-09T07:12:00Z")
        );
        advance(Duration::from_secs(6 * 60)).await;
        assert_eq!(handled.load(Ordering::SeqCst), 1);
        advance(Duration::from_secs(60)).await;
        delivered.notified().await;
        assert_eq!(handled.load(Ordering::SeqCst), 2);

        service.shutdown();
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn restarted_service_arms_only_the_next_future_occurrence() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        replace_schedule(
            &schedule_root,
            "agents.restart",
            true,
            "* * * * * Etc/UTC",
            "channel",
            "agents.restart",
        );
        let context = context("scheduler-restart", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let clock = TestSchedulerClock::new("2026-08-09T07:00:00Z".parse().unwrap());
        let first = SchedulerService::new_with_clock(
            context.clone(),
            &schedule_root,
            bus.clone(),
            Arc::new(clock.clone()),
        )
        .unwrap();
        let (handled, delivered) =
            register_notifying_channel(&first.inner.context, &bus, "agents.restart").await;
        assert!(first.refresh().await.applied);
        tokio::task::yield_now().await;
        first.shutdown();

        advance(Duration::from_secs(10 * 60)).await;
        let restarted =
            SchedulerService::new_with_clock(context, &schedule_root, bus, Arc::new(clock))
                .unwrap();
        assert!(restarted.refresh().await.applied);
        tokio::task::yield_now().await;
        assert_eq!(handled.load(Ordering::SeqCst), 0);
        assert_eq!(
            restarted.inspect().schedules[0]
                .next_occurrence_utc
                .as_deref(),
            Some("2026-08-09T07:11:00Z")
        );
        advance(Duration::from_secs(60)).await;
        delivered.notified().await;
        assert_eq!(handled.load(Ordering::SeqCst), 1);

        restarted.shutdown();
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn shutdown_is_idempotent_and_cancels_every_future_delivery() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        replace_schedule(
            &schedule_root,
            "agents.shutdown",
            true,
            "* * * * * Etc/UTC",
            "channel",
            "agents.shutdown",
        );
        let context = context("scheduler-shutdown", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let clock = TestSchedulerClock::new("2026-08-09T07:00:00Z".parse().unwrap());
        let service =
            SchedulerService::new_with_clock(context, &schedule_root, bus.clone(), Arc::new(clock))
                .unwrap();
        let (handled, _) =
            register_notifying_channel(&service.inner.context, &bus, "agents.shutdown").await;
        assert!(service.refresh().await.applied);
        tokio::task::yield_now().await;
        assert_eq!(service.active_job_count(), 1);

        service.shutdown();
        service.shutdown();
        assert_eq!(service.active_job_count(), 0);
        advance(Duration::from_secs(3 * 60)).await;
        assert_eq!(handled.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn named_instances_cannot_deliver_trigger_or_observe_each_others_schedules() {
        let temporary = tempdir().unwrap();
        let first_root = temporary.path().join("first");
        let second_root = temporary.path().join("second");
        let first_context = context("first", &first_root);
        let second_context = context("second", &second_root);
        let first_paths = first_context.paths();
        let second_paths = second_context.paths();
        replace_schedule(
            &first_paths.schedule_root,
            "agents.first",
            true,
            "* * * * * Etc/UTC",
            "channel",
            "agents.shared",
        );
        replace_schedule(
            &second_paths.schedule_root,
            "agents.second",
            true,
            "30 * * * * Etc/UTC",
            "channel",
            "agents.shared",
        );
        let first_bus = RuntimeMessageBus::new(first_context.clone());
        let second_bus = RuntimeMessageBus::new(second_context.clone());
        let first_clock = TestSchedulerClock::new("2026-08-09T07:00:00Z".parse().unwrap());
        let second_clock = TestSchedulerClock::new("2026-08-09T07:00:00Z".parse().unwrap());
        let first = SchedulerService::new_with_clock(
            first_context,
            first_paths.schedule_root,
            first_bus.clone(),
            Arc::new(first_clock),
        )
        .unwrap();
        let second = SchedulerService::new_with_clock(
            second_context,
            second_paths.schedule_root,
            second_bus.clone(),
            Arc::new(second_clock),
        )
        .unwrap();
        let (first_count, first_delivery) =
            register_notifying_channel(&first.inner.context, &first_bus, "agents.shared").await;
        let (second_count, _) =
            register_notifying_channel(&second.inner.context, &second_bus, "agents.shared").await;
        assert!(first.refresh().await.applied);
        assert!(second.refresh().await.applied);
        tokio::task::yield_now().await;

        advance(Duration::from_secs(60)).await;
        first_delivery.notified().await;
        assert_eq!(first_count.load(Ordering::SeqCst), 1);
        assert_eq!(second_count.load(Ordering::SeqCst), 0);
        assert!(matches!(
            first.trigger("agents.second").await,
            Err(SchedulerTriggerError::NotFound(_))
        ));
        first.trigger("agents.first").await.unwrap();
        first_delivery.notified().await;
        assert_eq!(first_count.load(Ordering::SeqCst), 2);
        assert_eq!(second_count.load(Ordering::SeqCst), 0);
        assert_eq!(first.inspect().schedules[0].id, "agents.first");
        assert_eq!(second.inspect().schedules[0].id, "agents.second");

        first.shutdown();
        second.shutdown();
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
    async fn read_only_control_detects_source_drift_without_changing_accepted_state_or_jobs() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        write_schedule(
            &schedule_root,
            "schedule.yaml",
            "agents.readonly",
            true,
            "*/5 * * * * Europe/Warsaw",
            "channel",
            "agents.readonly",
            json!({"reason": "accepted"}),
        );
        let context = context("scheduler-read-only", temporary.path());
        let paths = context.paths();
        let bus = RuntimeMessageBus::new(context.clone());
        let service = SchedulerService::new(context, &schedule_root, bus.clone()).unwrap();
        register_channels(
            &service.inner.context,
            &bus,
            &[("agents.readonly", true)],
            Vec::new(),
            256,
        )
        .await;
        assert!(service.refresh().await.applied);
        tokio::task::yield_now().await;

        let accepted_before = serde_json::to_vec(&service.accepted_snapshot()).unwrap();
        let inspection_before = service.inspect();
        let jobs_before = service.active_job_count();
        let snapshots = service.subscribe_snapshots();

        write_schedule(
            &schedule_root,
            "schedule.yaml",
            "agents.readonly",
            true,
            "*/10 * * * * Europe/Warsaw",
            "channel",
            "agents.readonly",
            json!({"reason": "candidate-drift"}),
        );
        let source_before = fs::read(schedule_root.join("schedule.yaml")).unwrap();
        let durable_before = durable_tree_digest(&paths.state_root);

        let verification = service.verify();
        assert_eq!(verification.code, SCHEDULE_CONTROL_VERIFIED);
        assert!(!verification.matches_accepted);
        assert_eq!(verification.accepted, inspection_before);
        assert!(verification.candidate_digest_sha256.is_some());
        assert!(verification.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == super::super::diagnostics::SNAPSHOT_SOURCE_DRIFT
        }));

        let diagnosis = service.diagnose();
        assert_eq!(diagnosis.code, SCHEDULE_CONTROL_DIAGNOSED);
        assert!(
            diagnosis.healthy,
            "source drift is observational warning only"
        );
        assert_eq!(diagnosis.inspection, inspection_before);
        assert!(diagnosis.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == super::super::diagnostics::SNAPSHOT_SOURCE_DRIFT
        }));

        let filtered = service.inspect_schedule("agents.readonly").unwrap();
        assert_eq!(filtered.instance_id, inspection_before.instance_id);
        assert_eq!(filtered.incarnation, inspection_before.incarnation);
        assert_eq!(
            filtered.schedule_generation,
            inspection_before.schedule_generation
        );
        assert_eq!(
            filtered.snapshot_digest_sha256,
            inspection_before.snapshot_digest_sha256
        );
        assert_eq!(
            filtered.bus_route_generation,
            inspection_before.bus_route_generation
        );
        assert_eq!(filtered.schedules.len(), 1);
        assert_eq!(filtered.schedules[0].id, "agents.readonly");
        assert!(matches!(
            service.inspect_schedule("agents.missing"),
            Err(SchedulerControlError::NotFound(diagnostic))
                if diagnostic.code == SCHEDULE_NOT_FOUND
        ));

        assert_eq!(
            serde_json::to_vec(&service.accepted_snapshot()).unwrap(),
            accepted_before
        );
        assert_eq!(service.inspect(), inspection_before);
        assert_eq!(service.active_job_count(), jobs_before);
        assert_eq!(durable_tree_digest(&paths.state_root), durable_before);
        assert_eq!(
            fs::read(schedule_root.join("schedule.yaml")).unwrap(),
            source_before
        );
        assert!(!snapshots.has_changed().unwrap());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn rejected_request_id_refresh_is_replayed_without_replacing_accepted_state() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        write_schedule(
            &schedule_root,
            "schedule.yaml",
            "agents.rejected-refresh",
            true,
            "*/5 * * * * Europe/Warsaw",
            "channel",
            "agents.rejected-refresh",
            json!({"reason": "accepted"}),
        );
        let context = context("scheduler-rejected-request", temporary.path());
        let paths = context.paths();
        let bus = RuntimeMessageBus::new(context.clone());
        let service = SchedulerService::new(context, &schedule_root, bus.clone()).unwrap();
        register_channels(
            &service.inner.context,
            &bus,
            &[("agents.rejected-refresh", true)],
            Vec::new(),
            256,
        )
        .await;
        assert!(service.refresh().await.applied);
        tokio::task::yield_now().await;
        let accepted_before = serde_json::to_vec(&service.accepted_snapshot()).unwrap();
        let jobs_before = service.active_job_count();

        write_fixture(&schedule_root, "invalid-unknown-field.yaml");
        let durable_after_invalid_source = durable_tree_digest(&paths.state_root);
        let request_id = Uuid::new_v4();
        let rejected = service.refresh_with_request_id(request_id).await.unwrap();
        assert_eq!(rejected.code, SCHEDULE_CONTROL_REFRESH_REJECTED);
        assert!(!rejected.applied);
        assert!(rejected.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == super::super::diagnostics::SOURCE_UNKNOWN_FIELD
        }));
        assert_eq!(
            serde_json::to_vec(&service.accepted_snapshot()).unwrap(),
            accepted_before
        );
        assert_eq!(service.active_job_count(), jobs_before);
        assert_eq!(
            durable_tree_digest(&paths.state_root),
            durable_after_invalid_source
        );

        write_schedule(
            &schedule_root,
            "schedule.yaml",
            "agents.rejected-refresh",
            true,
            "*/10 * * * * Europe/Warsaw",
            "channel",
            "agents.rejected-refresh",
            json!({"reason": "would-apply-with-a-new-request-id"}),
        );
        let durable_after_valid_source = durable_tree_digest(&paths.state_root);
        let replay = service.refresh_with_request_id(request_id).await.unwrap();
        assert_eq!(replay, rejected);
        assert_eq!(
            serde_json::to_vec(&service.accepted_snapshot()).unwrap(),
            accepted_before
        );
        assert_eq!(service.active_job_count(), jobs_before);
        assert_eq!(
            durable_tree_digest(&paths.state_root),
            durable_after_valid_source
        );

        let applied = service
            .refresh_with_request_id(Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(applied.code, SCHEDULE_CONTROL_REFRESHED);
        assert!(applied.applied);
        assert_eq!(
            applied.inspection.schedule_generation,
            rejected.inspection.schedule_generation + 1
        );
        assert_eq!(
            durable_tree_digest(&paths.state_root),
            durable_after_valid_source
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn request_identity_replays_concurrent_refresh_and_trigger_without_duplicate_work() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        replace_schedule(
            &schedule_root,
            "agents.replay",
            true,
            "*/5 * * * * Europe/Warsaw",
            "channel",
            "agents.replay",
        );
        let context = context("scheduler-request-replay", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let service = SchedulerService::new(context, &schedule_root, bus.clone()).unwrap();
        let (handled, delivered) =
            register_notifying_channel(&service.inner.context, &bus, "agents.replay").await;

        let refresh_request_id = Uuid::new_v4();
        let held_refresh = service.inner.refresh.lock().await;
        let first = tokio::spawn({
            let service = service.clone();
            async move { service.refresh_with_request_id(refresh_request_id).await }
        });
        tokio::task::yield_now().await;
        let second = tokio::spawn({
            let service = service.clone();
            async move { service.refresh_with_request_id(refresh_request_id).await }
        });
        tokio::task::yield_now().await;
        assert!(!first.is_finished());
        assert!(!second.is_finished());
        drop(held_refresh);

        let first = first.await.unwrap().unwrap();
        let second = second.await.unwrap().unwrap();
        assert_eq!(first, second);
        assert!(first.applied);
        assert_eq!(first.inspection.schedule_generation, 1);
        assert_eq!(service.accepted_snapshot().generation, 1);

        let trigger_request_id = Uuid::new_v4();
        // `join!` polls both requests before either replay waiter can return,
        // proving the follower observes an in-flight same-ID delivery rather
        // than merely a response already cached by a sequential retry.
        let (triggered, replayed) = tokio::join!(
            service.trigger_with_request_id("agents.replay", trigger_request_id),
            service.trigger_with_request_id("agents.replay", trigger_request_id),
        );
        let triggered = triggered.unwrap();
        let replayed = replayed.unwrap();
        assert_eq!(triggered, replayed);
        delivered.notified().await;
        tokio::task::yield_now().await;
        assert_eq!(handled.load(Ordering::SeqCst), 1);

        service
            .trigger_with_request_id("agents.replay", Uuid::new_v4())
            .await
            .unwrap();
        delivered.notified().await;
        assert_eq!(handled.load(Ordering::SeqCst), 2);

        assert!(matches!(
            service
                .trigger_with_request_id("agents.replay", refresh_request_id)
                .await,
            Err(SchedulerControlError::RequestIdConflict)
        ));
        let failed_request_id = Uuid::new_v4();
        let failed = service
            .trigger_with_request_id("agents.missing", failed_request_id)
            .await
            .unwrap_err();
        assert_eq!(failed.code(), SCHEDULE_NOT_FOUND);
        assert_eq!(
            service
                .trigger_with_request_id("agents.missing", failed_request_id)
                .await
                .unwrap_err(),
            failed
        );
        assert!(matches!(
            service
                .trigger_with_request_id("agents.other", failed_request_id)
                .await,
            Err(SchedulerControlError::RequestIdConflict)
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn control_reports_are_versioned_and_never_serialize_schedule_payloads() {
        let temporary = tempdir().unwrap();
        let schedule_root = temporary.path().join("schedules");
        write_schedule(
            &schedule_root,
            "schedule.yaml",
            "agents.redacted",
            true,
            "*/5 * * * * Europe/Warsaw",
            "channel",
            "agents.redacted",
            json!({"reason": "control-report-private-payload"}),
        );
        let context = context("scheduler-redaction", temporary.path());
        let bus = RuntimeMessageBus::new(context.clone());
        let service = SchedulerService::new(context, &schedule_root, bus.clone()).unwrap();
        let (_handled, delivered) =
            register_notifying_channel(&service.inner.context, &bus, "agents.redacted").await;
        assert!(service.refresh().await.applied);

        let inspection = service.inspect();
        let verification = service.verify();
        let diagnosis = service.diagnose();
        let refresh = service
            .refresh_with_request_id(Uuid::new_v4())
            .await
            .unwrap();
        let trigger = service
            .trigger_with_request_id("agents.redacted", Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(
            inspection.schema_version,
            SCHEDULE_INSPECTION_SCHEMA_VERSION
        );
        for schema_version in [
            verification.schema_version,
            diagnosis.schema_version,
            refresh.schema_version,
            trigger.schema_version,
        ] {
            assert_eq!(schema_version, SCHEDULE_CONTROL_SCHEMA_VERSION);
        }
        let reports = [
            serde_json::to_string(&inspection).unwrap(),
            serde_json::to_string(&verification).unwrap(),
            serde_json::to_string(&diagnosis).unwrap(),
            serde_json::to_string(&refresh).unwrap(),
            serde_json::to_string(&trigger).unwrap(),
        ];
        delivered.notified().await;

        for report in reports {
            assert!(!report.contains("control-report-private-payload"));
            assert!(!report.contains("\"payload\""));
        }
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
            include_str!("../../fixtures/scheduler/sources/duplicate-a.yaml"),
        )
        .unwrap();
        fs::write(
            schedule_root.join("duplicate-b.yaml"),
            include_str!("../../fixtures/scheduler/sources/duplicate-b.yaml"),
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
