//! Shipctl's own capabilities, split by capability rather than by file kind — the
//! same layout the frontend uses in `core/frontend/`.
//!
//! Each capability owns its logic and the `#[tauri::command]` handlers that
//! expose it. The Tauri shell in `src-tauri/` registers those handlers and
//! wires the managers into application state; it holds no capability logic of
//! its own.
//!
//! `workspace` is the persistence layer underneath the rest: it owns the
//! on-disk config schema that projects, settings and terminal all read.

pub mod appearance;
pub mod build_info;
pub mod instance;
pub mod message_bus;
pub mod module_control;
pub mod platform;
pub mod projects;
pub mod scheduler;
pub mod settings;
pub mod state;
pub mod terminal;
pub mod workspace;
