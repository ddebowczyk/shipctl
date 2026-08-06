use tauri::{Builder, Runtime};

pub fn install<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    #[cfg(feature = "fixture-module")]
    let builder = builder.plugin(shep_module_fixture::init());

    #[cfg(feature = "todos-module")]
    let builder = builder.plugin(shep_module_todos::init());

    #[cfg(feature = "ports-module")]
    let builder = builder.plugin(shep_module_ports::init(crate::ports_module::host_services()));

    builder
}
