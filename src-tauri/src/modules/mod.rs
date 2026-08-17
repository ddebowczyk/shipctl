//! Which module plugins this build carries.
//!
//! Feature flags decide membership. Module-owned host adapters live beside
//! their modules; this shell file is the single explicit composition list.

mod bundled;
pub mod inventory;

pub use bundled::seed_bundled_artifacts;

use tauri::{Builder, Runtime};

use shipctl_core::menu::{NativeMenuContribution, NativeMenuSlot};

pub fn install<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    #[cfg(feature = "fixture-module")]
    let builder = builder.plugin(shipctl_module_fixture::init());

    builder
}

/// Compile the native-menu declaration for the bundled commands artifact.
///
/// Runtime activation remains authoritative for dispatch. The native shell
/// publishes this stable entry because the artifact is part of every build.
pub fn native_menu_contributions() -> Vec<NativeMenuContribution> {
    commands_native_menu_contributions()
}

pub const fn semantic_terminal_available() -> bool {
    true
}

fn commands_native_menu_contributions() -> Vec<NativeMenuContribution> {
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
    fn commands_menu_contribution_matches_the_bundled_artifact_declaration() {
        let manifest = include_str!("../../../modules/commands/artifact/module.template.json");
        let contributions = commands_native_menu_contributions();

        assert_eq!(contributions.len(), 1);
        assert_eq!(contributions[0].module_id, "shipctl.commands");
        assert_eq!(contributions[0].command_id, "commands.open-panel");
        assert!(manifest.contains("\"id\": \"commands.open-panel\""));
    }
}
