//! Instance-local schedule definitions and their inspection contracts.
//!
//! This capability owns the strict configuration boundary. Runtime jobs and
//! control commands arrive in later scheduler stages; no timer or watcher is
//! created here.

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
};
pub use snapshot::SchedulerSnapshotProvider;
