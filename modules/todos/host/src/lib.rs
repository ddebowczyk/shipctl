//! Native host integration for the transitional Todos document adapter.

use std::sync::Arc;

use shipctl_core::workspace::manager::WorkspaceManager;
use shipctl_module_todos::{HostServices, ProjectCatalog};
use tauri::{Builder, Runtime};

struct WorkspaceProjectCatalog {
    workspace: WorkspaceManager,
}

impl ProjectCatalog for WorkspaceProjectCatalog {
    fn registered_project_paths(&self) -> Result<Vec<String>, String> {
        self.workspace
            .list_repos()
            .map(|repos| repos.into_iter().map(|repo| repo.path).collect())
    }
}

fn host_services(workspace: WorkspaceManager) -> HostServices {
    HostServices::new(Arc::new(WorkspaceProjectCatalog { workspace }))
}

pub fn install<R: Runtime>(builder: Builder<R>, workspace: WorkspaceManager) -> Builder<R> {
    builder.plugin(shipctl_module_todos::init(host_services(workspace)))
}
