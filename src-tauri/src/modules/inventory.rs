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
    vec![membership(
        "shipctl.fixture",
        cfg!(feature = "fixture-module"),
        false,
    )]
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
    fn current_host_inventory_matches_native_features_and_bundled_artifacts() {
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
    }
}
