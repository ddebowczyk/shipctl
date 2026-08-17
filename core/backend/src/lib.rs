//! Shipctl's own capabilities, split by capability rather than by file kind — the
//! same layout the frontend uses in `core/frontend/`.
//!
//! Each capability owns its framework-independent logic. The Tauri command,
//! event, and watcher adapters are in `core/tauri/`; the Tauri shell in
//! `src-tauri/` registers them and wires managers into application state.
//!
//! `workspace` is the persistence layer underneath the rest: it owns the
//! on-disk config schema that projects, settings and terminal all read.

pub mod appearance;
pub mod assistant_launch;
pub mod build_info;
pub mod credentials;
pub mod git;
pub mod instance;
pub mod logs;
pub mod menu;
pub mod message_bus;
pub mod module_control;
pub mod platform;
pub mod plugin_data;
pub mod processes;
pub mod project_documents;
pub mod projects;
pub mod scheduler;
pub mod semantic_terminal;
pub mod settings;
pub mod skill_installation;
pub mod state;
pub mod terminal_host;
pub mod usage_sources;
pub mod workspace;
