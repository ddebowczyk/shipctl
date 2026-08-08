use std::path::PathBuf;
use std::sync::Arc;

use shipctl_module_git::{HostServices, ProjectRootAuthority};

use shipctl_core::workspace::manager::WorkspaceManager;

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
    let registered = registered_paths
        .iter()
        .find(|registered| registered.as_str() == requested_path)
        .ok_or_else(|| format!("Project is not registered: {requested_path}"))?;
    PathBuf::from(registered)
        .canonicalize()
        .map_err(|error| format!("Could not resolve registered project {registered}: {error}"))
}

pub fn host_services(workspace: WorkspaceManager) -> HostServices {
    HostServices::new(Arc::new(WorkspaceProjectRootAuthority { workspace }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn accepts_only_an_exact_registered_root() {
        let fixture =
            std::env::temp_dir().join(format!("shipctl-git-host-authority-{}", std::process::id()));
        let _ = fs::remove_dir_all(&fixture);
        let alpha = fixture.join("alpha");
        let beta = fixture.join("beta");
        fs::create_dir_all(&alpha).unwrap();
        fs::create_dir_all(&beta).unwrap();
        let roots = vec![
            alpha.to_string_lossy().to_string(),
            beta.to_string_lossy().to_string(),
        ];

        assert_eq!(
            select_registered_project_root(&roots[0], &roots).unwrap(),
            alpha.canonicalize().unwrap()
        );
        assert!(
            select_registered_project_root(&alpha.join("child").to_string_lossy(), &roots,)
                .is_err()
        );
        assert!(
            select_registered_project_root(&fixture.join("missing").to_string_lossy(), &roots,)
                .is_err()
        );

        let _ = fs::remove_dir_all(&fixture);
    }
}
