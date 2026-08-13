//! Tauri plugin adapter for the semantic-terminal module.
//!
//! Parser, projection, input encoding, and the native terminal driver live in
//! `shipctl-module-semantic-terminal-core`. This crate owns only Tauri command
//! registration and permission generation for the desktop application.

mod tauri_plugin;

pub use tauri_plugin::init;

pub const PLUGIN_NAME: &str = "shipctl-semantic-terminal";
pub const GET_SNAPSHOT_COMMAND: &str =
    "plugin:shipctl-semantic-terminal|get_semantic_terminal_snapshot";
pub const ATTACH_COMMAND: &str = "plugin:shipctl-semantic-terminal|attach_semantic_terminal";
pub const CREDIT_SCREEN_COMMAND: &str =
    "plugin:shipctl-semantic-terminal|credit_semantic_terminal_screen";
pub const DETACH_COMMAND: &str = "plugin:shipctl-semantic-terminal|detach_semantic_terminal";
pub const RESIZE_COMMAND: &str = "plugin:shipctl-semantic-terminal|resize_semantic_terminal";
pub const INPUT_COMMAND: &str = "plugin:shipctl-semantic-terminal|input_semantic_terminal";
pub const HISTORY_COMMAND: &str = "plugin:shipctl-semantic-terminal|history_semantic_terminal";
pub const ANCHOR_COMMAND: &str = "plugin:shipctl-semantic-terminal|anchor_semantic_terminal";
pub const RESOLVE_ANCHOR_COMMAND: &str =
    "plugin:shipctl-semantic-terminal|resolve_semantic_terminal_anchor";
pub const RELEASE_ANCHOR_COMMAND: &str =
    "plugin:shipctl-semantic-terminal|release_semantic_terminal_anchor";
pub const SELECT_COMMAND: &str = "plugin:shipctl-semantic-terminal|select_semantic_terminal";
pub const PASTE_SAFETY_COMMAND: &str =
    "plugin:shipctl-semantic-terminal|is_semantic_terminal_paste_safe";
pub const PUBLICATION_STATS_COMMAND: &str =
    "plugin:shipctl-semantic-terminal|get_semantic_terminal_publication_stats";
pub const APP_MEMORY_COMMAND: &str =
    "plugin:shipctl-semantic-terminal|get_semantic_terminal_app_memory";

#[cfg(test)]
mod tests {
    #[test]
    fn exposes_namespaced_semantic_terminal_commands() {
        assert_eq!(super::PLUGIN_NAME, "shipctl-semantic-terminal");
        assert_eq!(
            super::GET_SNAPSHOT_COMMAND,
            "plugin:shipctl-semantic-terminal|get_semantic_terminal_snapshot"
        );
        assert_eq!(
            super::ATTACH_COMMAND,
            "plugin:shipctl-semantic-terminal|attach_semantic_terminal"
        );
        assert_eq!(
            super::CREDIT_SCREEN_COMMAND,
            "plugin:shipctl-semantic-terminal|credit_semantic_terminal_screen"
        );
        assert_eq!(
            super::DETACH_COMMAND,
            "plugin:shipctl-semantic-terminal|detach_semantic_terminal"
        );
        assert_eq!(
            super::RESIZE_COMMAND,
            "plugin:shipctl-semantic-terminal|resize_semantic_terminal"
        );
        assert_eq!(
            super::INPUT_COMMAND,
            "plugin:shipctl-semantic-terminal|input_semantic_terminal"
        );
        assert_eq!(
            super::PUBLICATION_STATS_COMMAND,
            "plugin:shipctl-semantic-terminal|get_semantic_terminal_publication_stats"
        );
        assert_eq!(
            super::APP_MEMORY_COMMAND,
            "plugin:shipctl-semantic-terminal|get_semantic_terminal_app_memory"
        );
    }
}
