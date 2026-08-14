//! Contracts implemented by removable modules.

mod snapshot_provider;
mod terminal_driver;

pub use snapshot_provider::SnapshotProvider;
pub use terminal_driver::{TerminalDriverFactory, TerminalDriverSession, TerminalObserver};
