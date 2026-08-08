use std::path::PathBuf;

use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ShipctlPaths {
    pub state_root: PathBuf,
    pub runtime_root: PathBuf,
    pub global_config: PathBuf,
    pub old_projects: PathBuf,
    pub ui_state: PathBuf,
    pub assistant_sessions: PathBuf,
    pub usage_database: PathBuf,
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
            assistant_sessions: state_root.join("assistant-sessions.json"),
            usage_database: state_root.join("usage.sqlite3"),
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
                owner: "assistants.continuity",
                classification: "instance_owned",
                path: self.assistant_sessions.clone(),
            },
            DurableSource {
                owner: "usage.database",
                classification: "instance_owned",
                path: self.usage_database.clone(),
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
}
