//! Instance-owned paths, persistence sources, and portable state archives.

pub mod archive;
pub mod durable_write;
pub mod paths;
pub mod providers;
pub mod snapshot;
mod snapshot_types;
pub mod ui;

pub use durable_write::DurableWriteBarrier;
pub use snapshot::SnapshotProvider;
pub use snapshot_types::{CapturedSnapshotEntry, SnapshotClassification, SnapshotEntryDeclaration};
