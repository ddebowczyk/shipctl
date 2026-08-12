//! Which module plugins this build carries.
//!
//! Feature flags decide membership. Module-owned host adapters live beside
//! their modules; this shell file is the single explicit composition list.

use std::sync::Arc;

pub mod capability_data;
pub mod inventory;

use tauri::{AppHandle, Builder, Runtime};

use shipctl_core::message_bus::MessageBusBridgeService;
use shipctl_core::state::paths::ShipctlPaths;
use shipctl_core::terminal_host::TerminalService;
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

    #[cfg(feature = "semantic-terminal-module")]
    let builder = shipctl_module_semantic_terminal_host::install(builder, terminals.clone());

    #[cfg(feature = "ports-module")]
    let builder = shipctl_module_ports_host::install(builder, workspace.clone());

    #[cfg(feature = "skills-module")]
    let builder = shipctl_module_skills_host::install(builder, workspace.clone());

    #[cfg(feature = "git-module")]
    let builder = shipctl_module_git_host::install(builder, workspace.clone());

    #[cfg(feature = "assistants-module")]
    let builder = shipctl_module_assistants_host::install(
        builder,
        terminals.clone(),
        paths.assistant_sessions.clone(),
        durable_writes.clone(),
    );

    #[cfg(feature = "usage-module")]
    let builder = shipctl_module_usage_host::install(
        builder,
        workspace.clone(),
        message_bridges.clone(),
        paths.usage_database.clone(),
        durable_writes.clone(),
    );

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
    providers.push(shipctl_module_assistants_host::snapshot_provider(
        paths.assistant_sessions.clone(),
    ));

    #[cfg(feature = "usage-module")]
    providers.push(shipctl_module_usage_host::snapshot_provider(
        paths.usage_database.clone(),
    ));

    let _ = (paths, providers);
}

/// Start module-owned work only after the host has published instance
/// readiness. Module-specific references remain confined to this removable
/// composition file.
pub fn start_background_tasks<R: Runtime>(app: &AppHandle<R>, reconcile_external_sources: bool) {
    #[cfg(feature = "usage-module")]
    let _ =
        reconcile_external_sources.then(|| shipctl_module_usage_host::start_background_ingest(app));

    let _ = (app, reconcile_external_sources);
}
