const COMMANDS: &[&str] = &[
    "spawn_assistant_session",
    "resume_assistant_session",
    "prepare_assistant_session",
    "confirm_assistant_session_capture",
    "try_capture_codex_assistant_session",
    "fail_assistant_session_capture",
    "update_assistant_session_placement",
    "update_assistant_session_label",
    "discard_assistant_session",
    "rearm_assistant_session",
    "list_restorable_assistant_sessions",
    "take_assistant_session_startup_warning",
    "begin_assistant_session_preserving_shutdown",
    "get_models_for_provider",
    "get_pi_config",
    "save_pi_settings",
    "save_pi_api_key",
    "delete_pi_api_key",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
