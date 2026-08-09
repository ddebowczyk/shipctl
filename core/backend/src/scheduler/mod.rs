//! Instance-local schedule definitions, inspection, and runtime delivery.
//!
//! This capability owns strict source validation, atomic accepted snapshots,
//! and in-memory cancellable jobs. Control commands arrive in a later stage;
//! source files are never watched or polled.

pub mod contracts;
pub mod diagnostics;
pub mod loader;
pub mod runtime;
pub mod snapshot;

pub use contracts::{
    parse_schedule_source, schedule_snapshot, ScheduleContractCatalog, ScheduleContractError,
    ScheduleDefinition, ScheduleDefinitionInspection, ScheduleInspection, ScheduleMessage,
    ScheduleSnapshot, ScheduleTarget, ScheduleTargetAvailability, ScheduleTargetKind,
    SCHEDULE_INSPECTION_SCHEMA_VERSION, SCHEDULE_SCHEMA_VERSION,
};
pub use diagnostics::{ScheduleDiagnostic, ScheduleDiagnosticSeverity};
pub use loader::{load_schedule_candidate, ScheduleLoadCandidate};
pub use runtime::{
    AcceptedScheduleSnapshot, ScheduleRefreshResult, SchedulerService, SchedulerServiceError,
    SchedulerTriggerError,
};
pub use snapshot::SchedulerSnapshotProvider;
