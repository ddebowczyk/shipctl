//! Tauri adapters for Shipctl's framework-independent backend core.
//!
//! This crate owns only Tauri command wrappers, IPC channels, event emission,
//! and the Tauri-backed git watcher. Domain state and services remain in
//! `shipctl-core`, so the standalone CLI never links this crate.

pub mod appearance;
pub mod assistant_launch;
pub mod configuration;
pub mod credentials;
pub mod git;
pub mod instance;
pub mod message_bridge;
pub mod message_bus;
pub mod module_control;
pub mod platform;
pub mod plugin_data;
pub mod processes;
pub mod project_documents;
pub mod projects;
mod projects_watcher;
pub mod scheduler;
pub mod semantic_terminal;
pub mod skill_installation;
pub mod state;
pub mod terminal_host;
pub mod usage_sources;

pub use message_bridge::MessageBusBridgeService;
pub use projects_watcher::GitWatcher;
