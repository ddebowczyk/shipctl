//! Which module plugins this build carries, and the adapter that hands each
//! one the host services it needs. Every submodule here is the same shape:
//! one `host_services()` bridging Shipctl's capabilities to that module's API.
//!
//! Feature flags decide membership, so a disabled module compiles out entirely.

#[cfg(feature = "assistants-module")]
pub mod assistants;
pub mod capability_data;
#[cfg(feature = "git-module")]
pub mod git;
#[cfg(feature = "ports-module")]
pub mod ports;
#[cfg(feature = "skills-module")]
pub mod skills;
#[cfg(feature = "usage-module")]
pub mod usage;

use tauri::{Builder, Runtime};

use shipctl_core::terminal::manager::PtyManager;

pub fn install<R: Runtime>(builder: Builder<R>, pty_manager: PtyManager) -> Builder<R> {
    #[cfg(feature = "fixture-module")]
    let builder = builder.plugin(shipctl_module_fixture::init());

    #[cfg(feature = "todos-module")]
    let builder = builder.plugin(shipctl_module_todos::init());

    #[cfg(feature = "ports-module")]
    let builder = builder.plugin(shipctl_module_ports::init(
        crate::modules::ports::host_services(),
    ));

    #[cfg(feature = "skills-module")]
    let builder = builder.plugin(shipctl_module_skills::init(
        crate::modules::skills::host_services(),
    ));

    #[cfg(feature = "git-module")]
    let builder = builder.plugin(shipctl_module_git::init(
        crate::modules::git::host_services(),
    ));

    #[cfg(feature = "assistants-module")]
    let builder = builder.plugin(shipctl_module_assistants::init(
        crate::modules::assistants::host_services(pty_manager),
    ));

    #[cfg(feature = "usage-module")]
    let builder = builder.plugin(shipctl_module_usage::init(
        crate::modules::usage::host_services(),
    ));

    #[cfg(not(feature = "assistants-module"))]
    let _ = pty_manager;

    builder
}
