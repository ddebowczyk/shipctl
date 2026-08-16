use std::path::PathBuf;

use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ShipctlPaths {
    pub state_root: PathBuf,
    pub runtime_root: PathBuf,
    pub global_config: PathBuf,
    pub old_projects: PathBuf,
    pub ui_state: PathBuf,
    pub workspace_layouts: PathBuf,
    pub plugin_data: PathBuf,
    pub assistant_sessions: PathBuf,
    pub usage_database: PathBuf,
    /// User-authored schedule definitions owned by this instance.
    pub schedule_root: PathBuf,
    /// Immutable, content-addressed module artifacts owned by this instance.
    pub module_artifact_root: PathBuf,
    /// Durable desired-state registry and operation journal for this instance.
    pub module_registry_database: PathBuf,
    /// Redacted module-control evidence emitted for this instance.
    pub module_control_evidence_root: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct DurableSource {
    pub owner: &'static str,
    pub classification: &'static str,
    pub path: PathBuf,
}

impl ShipctlPaths {
    pub fn new(state_root: PathBuf, runtime_root: PathBuf) -> Self {
        Self {
            global_config: state_root.join("config.yml"),
            old_projects: state_root.join("projects"),
            ui_state: state_root.join("ui-state.json"),
            workspace_layouts: state_root.join("workspace-layouts.json"),
            plugin_data: state_root.join("plugin-data.json"),
            assistant_sessions: state_root.join("assistant-sessions.json"),
            usage_database: state_root.join("usage.sqlite3"),
            schedule_root: state_root.join("schedules"),
            module_artifact_root: state_root.join("modules"),
            module_registry_database: state_root.join("module-registry.sqlite3"),
            module_control_evidence_root: state_root.join("module-control").join("evidence"),
            state_root,
            runtime_root,
        }
    }

    pub fn durable_sources(&self) -> Vec<DurableSource> {
        vec![
            DurableSource {
                owner: "host.workspace",
                classification: "instance_owned",
                path: self.global_config.clone(),
            },
            DurableSource {
                owner: "host.ui",
                classification: "instance_owned",
                path: self.ui_state.clone(),
            },
            DurableSource {
                owner: "host.canvas_layout",
                classification: "instance_owned",
                path: self.workspace_layouts.clone(),
            },
            DurableSource {
                owner: "host.plugin_data",
                classification: "instance_owned",
                path: self.plugin_data.clone(),
            },
            DurableSource {
                owner: "assistants.continuity",
                classification: "instance_owned",
                path: self.assistant_sessions.clone(),
            },
            DurableSource {
                owner: "usage.database",
                classification: "instance_owned",
                path: self.usage_database.clone(),
            },
            DurableSource {
                owner: "scheduler.configuration",
                classification: "instance_owned",
                path: self.schedule_root.clone(),
            },
            DurableSource {
                owner: "modules.artifacts",
                classification: "instance_owned",
                path: self.module_artifact_root.clone(),
            },
            DurableSource {
                owner: "modules.registry",
                classification: "instance_owned",
                path: self.module_registry_database.clone(),
            },
            DurableSource {
                owner: "module-control.evidence",
                classification: "instance_owned",
                path: self.module_control_evidence_root.clone(),
            },
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_registered_instance_source_is_below_the_selected_state_root() {
        let paths = ShipctlPaths::new(PathBuf::from("/profiles/test"), PathBuf::from("/run/test"));
        assert!(paths
            .durable_sources()
            .iter()
            .all(|source| source.path.starts_with(&paths.state_root)));
    }

    #[test]
    fn module_control_paths_are_derived_from_the_selected_state_root() {
        let paths = ShipctlPaths::new(PathBuf::from("/profiles/test"), PathBuf::from("/run/test"));

        assert_eq!(paths.module_artifact_root, paths.state_root.join("modules"));
        assert_eq!(
            paths.module_registry_database,
            paths.state_root.join("module-registry.sqlite3")
        );
        assert_eq!(
            paths.module_control_evidence_root,
            paths.state_root.join("module-control/evidence")
        );
        assert!(paths.module_artifact_root.starts_with(&paths.state_root));
        assert!(paths
            .module_registry_database
            .starts_with(&paths.state_root));
        assert!(paths
            .module_control_evidence_root
            .starts_with(&paths.state_root));
        assert!(paths
            .durable_sources()
            .iter()
            .any(|source| source.owner == "modules.artifacts"
                && source.path == paths.module_artifact_root));
        assert!(paths
            .durable_sources()
            .iter()
            .any(|source| source.owner == "modules.registry"
                && source.path == paths.module_registry_database));
        assert!(paths
            .durable_sources()
            .iter()
            .any(|source| source.owner == "module-control.evidence"
                && source.path == paths.module_control_evidence_root));
    }

    #[test]
    fn plugin_data_is_an_instance_owned_durable_source() {
        let paths = ShipctlPaths::new(PathBuf::from("/profiles/test"), PathBuf::from("/run/test"));

        assert_eq!(paths.plugin_data, paths.state_root.join("plugin-data.json"));
        assert!(paths.durable_sources().iter().any(|source| {
            source.owner == "host.plugin_data"
                && source.classification == "instance_owned"
                && source.path == paths.plugin_data
        }));
    }

    #[test]
    fn schedule_root_is_instance_local_and_registered_as_durable_configuration() {
        let first = ShipctlPaths::new(
            PathBuf::from("/profiles/first"),
            PathBuf::from("/run/first"),
        );
        let second = ShipctlPaths::new(
            PathBuf::from("/profiles/second"),
            PathBuf::from("/run/second"),
        );

        assert_eq!(first.schedule_root, first.state_root.join("schedules"));
        assert_eq!(second.schedule_root, second.state_root.join("schedules"));
        assert_ne!(first.schedule_root, second.schedule_root);
        assert!(first.durable_sources().iter().any(|source| {
            source.owner == "scheduler.configuration"
                && source.classification == "instance_owned"
                && source.path == first.schedule_root
        }));
    }

    #[test]
    fn workspace_layout_store_is_instance_local_and_registered_as_durable_configuration() {
        let first = ShipctlPaths::new(
            PathBuf::from("/profiles/first"),
            PathBuf::from("/run/first"),
        );
        let second = ShipctlPaths::new(
            PathBuf::from("/profiles/second"),
            PathBuf::from("/run/second"),
        );

        assert_eq!(
            first.workspace_layouts,
            first.state_root.join("workspace-layouts.json")
        );
        assert_eq!(
            second.workspace_layouts,
            second.state_root.join("workspace-layouts.json")
        );
        assert_ne!(first.workspace_layouts, second.workspace_layouts);
        assert!(first.durable_sources().iter().any(|source| {
            source.owner == "host.canvas_layout"
                && source.classification == "instance_owned"
                && source.path == first.workspace_layouts
        }));
    }

    #[test]
    fn two_instances_have_disjoint_module_control_paths_without_touching_other_roots() {
        let root = std::env::temp_dir().join(format!(
            "shipctl-paths-isolation-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let production_root = root.join("production-default");
        let first_root = root.join("first");
        let second_root = root.join("second");
        std::fs::create_dir_all(&production_root).unwrap();
        let sentinel = production_root.join("untouched");
        std::fs::write(&sentinel, b"sentinel").unwrap();

        let first = ShipctlPaths::new(first_root.clone(), root.join("first-runtime"));
        let second = ShipctlPaths::new(second_root.clone(), root.join("second-runtime"));

        assert_ne!(first.module_artifact_root, second.module_artifact_root);
        assert_ne!(
            first.module_registry_database,
            second.module_registry_database
        );
        assert_ne!(
            first.module_control_evidence_root,
            second.module_control_evidence_root
        );
        for path in [
            &first.module_artifact_root,
            &first.module_registry_database,
            &first.module_control_evidence_root,
        ] {
            assert!(path.starts_with(&first_root));
            assert!(!path.starts_with(&production_root));
        }
        for path in [
            &second.module_artifact_root,
            &second.module_registry_database,
            &second.module_control_evidence_root,
        ] {
            assert!(path.starts_with(&second_root));
            assert!(!path.starts_with(&production_root));
        }
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"sentinel");
        assert!(!first_root.exists());
        assert!(!second_root.exists());

        std::fs::remove_dir_all(root).unwrap();
    }
}
