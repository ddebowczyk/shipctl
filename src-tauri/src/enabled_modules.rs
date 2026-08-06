use tauri::{Builder, Runtime};

pub fn install<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    #[cfg(feature = "fixture-module")]
    let builder = builder.plugin(shep_module_fixture::init());

    builder
}
