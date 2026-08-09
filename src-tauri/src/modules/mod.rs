//! Which module plugins this build carries, and the adapter that hands each
//! one the host services it needs. Every submodule here is the same shape:
//! one `host_services()` bridging Shipctl's capabilities to that module's API.
//!
//! Feature flags decide membership, so a disabled module compiles out entirely.

use std::sync::Arc;

#[cfg(feature = "assistants-module")]
pub mod assistants;
pub mod capability_data;
#[cfg(feature = "git-module")]
pub mod git;
pub mod inventory;
#[cfg(feature = "ports-module")]
pub mod ports;
#[cfg(feature = "skills-module")]
pub mod skills;
#[cfg(feature = "usage-module")]
pub mod usage;

use tauri::{AppHandle, Builder, Runtime};

use shipctl_core::message_bus::MessageBusBridgeService;
use shipctl_core::state::paths::ShipctlPaths;
use shipctl_core::terminal::TerminalService;
use shipctl_core::workspace::manager::WorkspaceManager;
use shipctl_module_api::{DurableWriteBarrier, SnapshotProvider};

pub fn install<R: Runtime>(
    builder: Builder<R>,
    terminals: TerminalService,
    workspace: WorkspaceManager,
    paths: ShipctlPaths,
    durable_writes: DurableWriteBarrier,
    message_bridges: MessageBusBridgeService,
) -> Builder<R> {
    #[cfg(feature = "fixture-module")]
    let builder = builder.plugin(shipctl_module_fixture::init());

    #[cfg(feature = "todos-module")]
    let builder = builder.plugin(shipctl_module_todos::init());

    #[cfg(feature = "ports-module")]
    let builder = builder.plugin(shipctl_module_ports::init(
        crate::modules::ports::host_services(workspace.clone()),
    ));

    #[cfg(feature = "skills-module")]
    let builder = builder.plugin(shipctl_module_skills::init(
        crate::modules::skills::host_services(workspace.clone()),
    ));

    #[cfg(feature = "git-module")]
    let builder = builder.plugin(shipctl_module_git::init(
        crate::modules::git::host_services(workspace.clone()),
    ));

    #[cfg(feature = "assistants-module")]
    let builder = builder.plugin(shipctl_module_assistants::init(
        crate::modules::assistants::host_services(terminals.clone()),
        paths.assistant_sessions.clone(),
        durable_writes.clone(),
    ));

    #[cfg(feature = "usage-module")]
    let builder = builder.plugin(shipctl_module_usage::init(
        crate::modules::usage::host_services(workspace.clone(), message_bridges.clone()),
        paths.usage_database.clone(),
        durable_writes.clone(),
    ));

    let _ = (terminals, workspace, paths, durable_writes, message_bridges);

    builder
}

/// Add module-owned durable-state providers at the one native composition
/// boundary that the plug-out contract can remove with the module.
pub fn extend_snapshot_providers(
    paths: &ShipctlPaths,
    providers: &mut Vec<Arc<dyn SnapshotProvider>>,
) {
    #[cfg(feature = "assistants-module")]
    providers.push(Arc::new(
        shipctl_module_assistants::AssistantSnapshotProvider::new(paths.assistant_sessions.clone()),
    ));

    #[cfg(feature = "usage-module")]
    providers.push(Arc::new(shipctl_module_usage::UsageSnapshotProvider::new(
        paths.usage_database.clone(),
    )));

    let _ = (paths, providers);
}

/// Start module-owned work only after the host has published instance
/// readiness. Module-specific references remain confined to this removable
/// composition file.
pub fn start_background_tasks<R: Runtime>(app: &AppHandle<R>, reconcile_external_sources: bool) {
    #[cfg(feature = "usage-module")]
    let _ = reconcile_external_sources.then(|| shipctl_module_usage::start_background_ingest(app));

    let _ = (app, reconcile_external_sources);
}
