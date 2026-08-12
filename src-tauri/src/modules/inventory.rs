use shipctl_core::build_info::CONTROL_PROTOCOL_VERSION;
use shipctl_core::module_control::registry::{
    BuildModuleMembership, ModuleRegistry, StaticBuildInventory,
};
use shipctl_core::state::paths::ShipctlPaths;

use crate::build_info::APP_VERSION;

pub fn seed_current_build(paths: &ShipctlPaths) -> Result<(), String> {
    let inventory = current_build_inventory()?;
    let mut registry = ModuleRegistry::open_writable(paths).map_err(|error| error.to_string())?;
    registry
        .seed_static_inventory(&inventory)
        .map_err(|error| error.to_string())?;
    let diagnostics = registry.static_inventory_diagnostics(&inventory);
    if let Some(diagnostic) = diagnostics.first() {
        return Err(format!("{}: {}", diagnostic.code, diagnostic.summary));
    }
    Ok(())
}

pub fn current_build_inventory() -> Result<StaticBuildInventory, String> {
    inventory_from_membership(current_membership())
}

fn inventory_from_membership(
    membership: Vec<BuildModuleMembership>,
) -> Result<StaticBuildInventory, String> {
    StaticBuildInventory::from_build_composition(
        &format!("shipctl-ui:{APP_VERSION}:control-protocol:{CONTROL_PROTOCOL_VERSION}"),
        APP_VERSION,
        membership,
    )
    .map_err(|error| error.to_string())
}

fn current_membership() -> Vec<BuildModuleMembership> {
    vec![
        membership("shipctl.fixture", cfg!(feature = "fixture-module"), false),
        membership("shipctl.todos", cfg!(feature = "todos-module"), true),
        membership("shipctl.ports", cfg!(feature = "ports-module"), true),
        membership("shipctl.skills", cfg!(feature = "skills-module"), true),
        membership(
            "shipctl.git",
            cfg!(feature = "git-module"),
            frontend_enabled(option_env!("VITE_SHIPCTL_GIT_MODULE")),
        ),
        membership(
            "shipctl.assistants",
            cfg!(feature = "assistants-module"),
            frontend_enabled(option_env!("VITE_SHIPCTL_ASSISTANTS_MODULE")),
        ),
        membership(
            "shipctl.usage",
            cfg!(feature = "usage-module"),
            frontend_enabled(option_env!("VITE_SHIPCTL_USAGE_MODULE")),
        ),
        membership(
            "shipctl.commands",
            false,
            frontend_enabled(option_env!("VITE_SHIPCTL_COMMANDS_MODULE")),
        ),
        membership(
            "shipctl.semantic-terminal",
            cfg!(feature = "semantic-terminal-module"),
            true,
        ),
        membership("shipctl.thin-terminal", false, true),
    ]
}

fn membership(
    module_id: &str,
    native_compiled: bool,
    frontend_shipped: bool,
) -> BuildModuleMembership {
    BuildModuleMembership {
        module_id: module_id.to_string(),
        native_compiled,
        frontend_shipped,
    }
}

fn frontend_enabled(value: Option<&str>) -> bool {
    !matches!(value, Some("disabled"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use shipctl_core::module_control::{ModuleLifecycleState, ModuleRuntimeKind, ModuleSource};

    #[test]
    fn representative_composition_is_data_only_and_omits_absent_members() {
        let inventory = inventory_from_membership(vec![
            membership("shipctl.enabled", true, true),
            membership("shipctl.frontend", false, true),
            membership("shipctl.absent", false, false),
        ])
        .unwrap();

        assert_eq!(
            inventory
                .modules
                .iter()
                .map(|record| record.identity.id.as_str())
                .collect::<Vec<_>>(),
            vec!["shipctl.enabled", "shipctl.frontend"]
        );
        assert!(inventory.modules.iter().all(|record| {
            record.source == ModuleSource::Bundled
                && record.identity.runtime_kind == ModuleRuntimeKind::StaticBuiltin
                && record.lifecycle == ModuleLifecycleState::RestartRequired
                && !record.live_loadable
        }));
    }

    #[test]
    fn current_host_inventory_matches_native_features_and_frontend_profile() {
        let inventory = current_build_inventory().unwrap();
        let membership = current_membership()
            .into_iter()
            .filter(|module| module.native_compiled || module.frontend_shipped)
            .collect::<Vec<_>>();
        assert_eq!(inventory.modules.len(), membership.len());
        for expected in membership {
            let record = inventory
                .modules
                .iter()
                .find(|record| record.identity.id == expected.module_id)
                .unwrap();
            assert_eq!(record.native_compiled, expected.native_compiled);
            assert_eq!(record.frontend_shipped, expected.frontend_shipped);
        }

        let frontend_profile = include_str!("../../../core/frontend/host/enabledModules.ts");
        for module_id in [
            "shipctl.assistants",
            "shipctl.commands",
            "shipctl.git",
            "shipctl.ports",
            "shipctl.skills",
            "shipctl.todos",
            "shipctl.usage",
        ] {
            let short_id = module_id.strip_prefix("shipctl.").unwrap();
            assert!(
                frontend_profile.contains(&format!("{short_id}Module")),
                "frontend static profile omitted {module_id}"
            );
        }
        for module_name in ["semanticTerminalModule", "thinTerminalModule"] {
            assert!(
                frontend_profile.contains(module_name),
                "frontend static profile omitted {module_name}"
            );
        }
    }
}
