//! Terminals: PTY spawning, I/O and lifecycle, plus the terminal settings the
//! user can change. Keybinding presets live on the frontend side of this
//! capability because their payload is bytes written straight to the PTY.

pub mod commands;
/// Executable evidence that the pinned Ghostty revision can be the sole VT
/// authority. Tests only: it is a compatibility gate, not production code.
#[cfg(test)]
mod compat;
pub mod contract;
pub mod effects;
pub mod input;
/// What one frame of semantic state costs the host, measured rather than
/// argued. Tests only, and ignored by default: it reports numbers and gates on
/// nothing.
#[cfg(test)]
mod measure;
/// Executable evidence that semantic state alone can be presented, which is
/// what area 04 must not fail. Tests only: it is the falsification probe for
/// `painter`, not a painter of its own.
#[cfg(test)]
mod paint_probe;
pub mod painter;
pub mod process;
pub mod projection;
mod publication;
pub mod record;
pub mod replay;
pub mod retention;
pub mod runtime;
pub mod service;
/// The recorded PTY corpus and the state each recording produces. Tests only:
/// it is evidence about production code, not production code.
#[cfg(test)]
mod traces;
pub mod types;
pub mod wire;

pub use runtime::{TerminalEventSink, TerminalRuntimeHandle};
pub use service::TerminalService;
pub use types::*;
