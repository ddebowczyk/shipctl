use tauri::{Builder, Runtime};

use crate::pty::manager::PtyManager;

pub fn install<R: Runtime>(builder: Builder<R>, pty_manager: PtyManager) -> Builder<R> {
    #[cfg(feature = "fixture-module")]
    let builder = builder.plugin(shep_module_fixture::init());

    #[cfg(feature = "todos-module")]
    let builder = builder.plugin(shep_module_todos::init());

    #[cfg(feature = "ports-module")]
    let builder = builder.plugin(shep_module_ports::init(crate::ports_module::host_services()));

    #[cfg(feature = "skills-module")]
    let builder = builder.plugin(shep_module_skills::init(
        crate::skills_module::host_services(),
    ));

    #[cfg(feature = "git-module")]
    let builder = builder.plugin(shep_module_git::init(crate::git_module::host_services()));

    #[cfg(feature = "assistants-module")]
    let builder = builder.plugin(shep_module_assistants::init(
        crate::assistants_module::host_services(pty_manager),
    ));

    #[cfg(feature = "usage-module")]
    let builder = builder.plugin(shep_module_usage::init(
        crate::usage_module::host_services(),
    ));

    #[cfg(not(feature = "assistants-module"))]
    let _ = pty_manager;

    builder
}
