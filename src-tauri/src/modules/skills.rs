use std::path::PathBuf;
use std::sync::Arc;

use shipctl_module_skills::{HostServices, ProjectRootAuthority};

use shipctl_core::workspace::manager::WorkspaceManager;

struct WorkspaceProjectRootAuthority;

impl ProjectRootAuthority for WorkspaceProjectRootAuthority {
    fn authorize_project_root(&self, requested_path: &str) -> Result<PathBuf, String> {
        let registered_paths = WorkspaceManager::new()
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

pub fn host_services() -> HostServices {
    HostServices::new(Arc::new(WorkspaceProjectRootAuthority))
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
