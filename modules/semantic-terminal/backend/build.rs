const COMMANDS: &[&str] = &[
    "get_semantic_terminal_snapshot",
    "attach_semantic_terminal",
    "credit_semantic_terminal_screen",
    "detach_semantic_terminal",
    "resize_semantic_terminal",
    "input_semantic_terminal",
    "history_semantic_terminal",
    "anchor_semantic_terminal",
    "resolve_semantic_terminal_anchor",
    "release_semantic_terminal_anchor",
    "select_semantic_terminal",
    "is_semantic_terminal_paste_safe",
    "get_semantic_terminal_publication_stats",
    "get_semantic_terminal_app_memory",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
