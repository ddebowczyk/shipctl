//! Tauri adapters for Shipctl's framework-independent backend core.
//!
//! This crate owns only Tauri command wrappers, IPC channels, event emission,
//! and the Tauri-backed git watcher. Domain state and services remain in
//! `shipctl-core`, so the standalone CLI never links this crate.

pub mod appearance;
pub mod instance;
pub mod message_bridge;
pub mod message_bus;
pub mod module_control;
pub mod platform;
pub mod plugin_data;
pub mod projects;
mod projects_watcher;
pub mod scheduler;
pub mod settings;
pub mod state;
pub mod terminal_host;
pub mod workspace;

pub use message_bridge::MessageBusBridgeService;
pub use projects_watcher::GitWatcher;
