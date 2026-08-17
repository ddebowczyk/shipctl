//! Terminals: PTY spawning, I/O and lifecycle, plus the terminal settings the
//! user can change. Keybinding presets live on the frontend side of this
//! capability because their payload is bytes written straight to the PTY.

pub mod driver;
mod driver_registry;
mod driver_session;
pub mod process;
mod publication;
pub mod record;
pub mod retention;
pub mod runtime;
pub mod service;
pub mod types;

pub use driver::{
    TerminalByteOccurrence, TerminalColorTheme, TerminalDriverDescriptor, TerminalDriverError,
    TerminalDriverId, TerminalDriverRequestResult, TerminalDriverSessionRequest,
    TerminalDriverUpdate, TerminalObservation,
};
pub use driver_registry::TerminalDriverRegistry;
pub use driver_session::{TerminalDriverFactory, TerminalDriverSession};
pub use runtime::{TerminalDriverEventSink, TerminalEventSink, TerminalRuntimeHandle};
pub use service::TerminalService;
pub use types::*;
