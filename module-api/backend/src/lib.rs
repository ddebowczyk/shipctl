//! Narrow native contracts shared by the Shipctl host and internal modules.
//!
//! The public crate surface remains flat for consumers. Internally, each
//! declaration lives in the direction that supplies or implements it:
//! host-owned authorities, module-provided traits, or shared protocol values.

#![forbid(unsafe_code)]

mod host;
mod module;
mod protocol;

pub use host::{DurableWriteBarrier, TerminalAuthority, TerminalDriverRegistry};
pub use module::{
    SnapshotProvider, TerminalDriverFactory, TerminalDriverSession, TerminalObserver,
};
pub use protocol::{
    CapturedSnapshotEntry, ModuleTerminalCloseResult, ModuleTerminalId, ModuleTerminalSpawnRequest,
    SnapshotClassification, SnapshotEntryDeclaration, TerminalByteOccurrence, TerminalColorTheme,
    TerminalDriverDescriptor, TerminalDriverError, TerminalDriverId, TerminalDriverRequestResult,
    TerminalDriverSessionRequest, TerminalDriverUpdate, TerminalObservation,
};
