//! Native host integration for the skills module.

use std::path::PathBuf;
use std::sync::Arc;

use shipctl_core::workspace::manager::WorkspaceManager;
use shipctl_module_skills::{HostServices, ProjectRootAuthority};
use tauri::{Builder, Runtime};

struct WorkspaceProjectRootAuthority {
    workspace: WorkspaceManager,
}

impl ProjectRootAuthority for WorkspaceProjectRootAuthority {
    fn authorize_project_root(&self, requested_path: &str) -> Result<PathBuf, String> {
        let registered_paths = self
            .workspace
            .list_repos()?
            .into_iter()
            .map(|repo| repo.path)
            .collect::<Vec<_>>();
        select_registered_project_root(requested_path, &registered_paths)
    }
}

fn select_registered_project_root(
    requested_path: &str,
    registered_paths: &[String],
) -> Result<PathBuf, String> {
    registered_paths
        .iter()
        .find(|registered| registered.as_str() == requested_path)
        .map(PathBuf::from)
        .ok_or_else(|| format!("Project is not registered: {requested_path}"))
}

fn host_services(workspace: WorkspaceManager) -> HostServices {
    HostServices::new(Arc::new(WorkspaceProjectRootAuthority { workspace }))
}

pub fn install<R: Runtime>(builder: Builder<R>, workspace: WorkspaceManager) -> Builder<R> {
    builder.plugin(shipctl_module_skills::init(host_services(workspace)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_an_exact_registered_root() {
        let roots = vec!["/projects/alpha".to_string(), "/projects/beta".to_string()];
        assert_eq!(
            select_registered_project_root("/projects/alpha", &roots).unwrap(),
            PathBuf::from("/projects/alpha")
        );
        assert!(select_registered_project_root("/projects/alpha/child", &roots).is_err());
        assert!(select_registered_project_root("/projects/missing", &roots).is_err());
    }
}
