//! Terminals: PTY spawning, I/O and lifecycle, plus the terminal settings the
//! user can change. Keybinding presets live on the frontend side of this
//! capability because their payload is bytes written straight to the PTY.

pub mod commands;
pub mod manager;
pub mod session;
