//! Disposable internal plugin used to verify Shep's native module rail.

#![forbid(unsafe_code)]

use tauri::{plugin::TauriPlugin, Runtime};

pub const PLUGIN_NAME: &str = "shep-fixture";
pub const PING_COMMAND: &str = "plugin:shep-fixture|ping";

#[tauri::command]
fn ping() -> &'static str {
    "fixture:pong"
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new(PLUGIN_NAME)
        .invoke_handler(tauri::generate_handler![ping])
        .build()
}

#[cfg(test)]
mod tests {
    use super::{ping, PING_COMMAND, PLUGIN_NAME};

    #[test]
    fn exposes_an_inert_namespaced_ping_contract() {
        assert_eq!(PLUGIN_NAME, "shep-fixture");
        assert_eq!(PING_COMMAND, "plugin:shep-fixture|ping");
        assert_eq!(ping(), "fixture:pong");
    }
}
