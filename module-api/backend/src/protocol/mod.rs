//! Shared immutable identifiers, values, and wire-neutral data contracts.

mod snapshot;
mod terminal;

pub use snapshot::{CapturedSnapshotEntry, SnapshotClassification, SnapshotEntryDeclaration};
pub use terminal::{
    ModuleTerminalCloseResult, ModuleTerminalId, ModuleTerminalSpawnRequest,
    TerminalByteOccurrence, TerminalColorTheme, TerminalDriverDescriptor, TerminalDriverError,
    TerminalDriverId, TerminalDriverRequestResult, TerminalDriverSessionRequest,
    TerminalDriverUpdate, TerminalObservation,
};
