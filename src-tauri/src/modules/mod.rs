//! Which module plugins this build carries.
//!
//! Feature flags decide membership. Module-owned host adapters live beside
//! their modules; this shell file is the single explicit composition list.

use std::sync::Arc;

pub mod capability_data;
pub mod inventory;

use tauri::{AppHandle, Builder, Runtime};

use shipctl_core::menu::{NativeMenuContribution, NativeMenuSlot};
use shipctl_core::state::paths::ShipctlPaths;
use shipctl_core::terminal_host::TerminalService;
use shipctl_core::workspace::manager::WorkspaceManager;
use shipctl_module_api::{DurableWriteBarrier, SnapshotProvider};
use shipctl_tauri_adapter::MessageBusBridgeService;

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

/// Compile native-menu declarations from the same static profile that the
/// frontend registers at startup. Runtime artifacts are deliberately absent:
/// their lifecycle currently permits headless capabilities only.
pub fn native_menu_contributions() -> Vec<NativeMenuContribution> {
    native_menu_contributions_for(inventory::frontend_enabled(option_env!(
        "VITE_SHIPCTL_COMMANDS_MODULE"
    )))
}

pub const fn semantic_terminal_available() -> bool {
    cfg!(feature = "semantic-terminal-module")
}

fn native_menu_contributions_for(commands_enabled: bool) -> Vec<NativeMenuContribution> {
    if !commands_enabled {
        return Vec::new();
    }

    vec![NativeMenuContribution::new(
        "shipctl.commands",
        "commands.open-panel",
        "New Commands Panel",
        Some("CmdOrCtrl+Shift+C"),
        NativeMenuSlot::FileNew,
        20,
    )]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_menu_contribution_matches_the_static_frontend_command() {
        let frontend = include_str!("../../../modules/commands/frontend/src/index.ts");
        let contributions = native_menu_contributions_for(true);

        assert_eq!(contributions.len(), 1);
        assert_eq!(contributions[0].module_id, "shipctl.commands");
        assert_eq!(contributions[0].command_id, "commands.open-panel");
        assert!(frontend.contains("id: \"commands.open-panel\""));
    }

    #[test]
    fn disabled_static_profile_has_no_module_native_menu_items() {
        assert!(native_menu_contributions_for(false).is_empty());
    }
}
