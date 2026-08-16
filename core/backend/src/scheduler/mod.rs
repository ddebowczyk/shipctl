//! Instance-local schedule definitions, inspection, and runtime delivery.
//!
//! This capability owns strict source validation, atomic accepted snapshots,
//! in-memory cancellable jobs, and redacted control projections. Source files
//! are never watched or polled.

pub mod contracts;
pub mod diagnostics;
pub mod leases;
pub mod loader;
pub mod runtime;
pub mod snapshot;

pub use contracts::{
    parse_schedule_source, schedule_snapshot, ScheduleContractCatalog, ScheduleContractError,
    ScheduleDefinition, ScheduleDefinitionInspection, ScheduleDeliveryObservation,
    ScheduleDiagnosticReport, ScheduleInspection, ScheduleMessage, ScheduleRefreshReport,
    ScheduleSnapshot, ScheduleTarget, ScheduleTargetAvailability, ScheduleTargetKind,
    ScheduleTriggerReport, ScheduleVerification, SCHEDULE_CONTROL_SCHEMA_VERSION,
    SCHEDULE_INSPECTION_SCHEMA_VERSION, SCHEDULE_SCHEMA_VERSION,
};
pub use diagnostics::{ScheduleDiagnostic, ScheduleDiagnosticSeverity};
pub use leases::{
    purge_stale_lease_sources, RegisterScheduleInput, ScheduleLeaseInspection, SchedulerActor,
    SchedulerDeliveryFrame, SchedulerLeaseError, SchedulerLeaseService, SCHEDULER_INVALID_REQUEST,
    SCHEDULER_REGISTER_GRANT, SCHEDULER_SERVICE_SCHEMA_VERSION,
};
pub use loader::{load_schedule_candidate, ScheduleLoadCandidate};
pub use runtime::{
    AcceptedScheduleSnapshot, ScheduleRefreshResult, SchedulerControlError, SchedulerService,
    SchedulerServiceError, SchedulerTriggerError, SCHEDULE_CONTROL_DIAGNOSED,
    SCHEDULE_CONTROL_INSPECTED, SCHEDULE_CONTROL_LISTED, SCHEDULE_CONTROL_REFRESHED,
    SCHEDULE_CONTROL_REFRESH_PARTIAL, SCHEDULE_CONTROL_REFRESH_REJECTED,
    SCHEDULE_CONTROL_REQUEST_ID_CONFLICT, SCHEDULE_CONTROL_TRIGGERED, SCHEDULE_CONTROL_VERIFIED,
};
pub use snapshot::SchedulerSnapshotProvider;
