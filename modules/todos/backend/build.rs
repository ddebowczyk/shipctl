const COMMANDS: &[&str] = &[
    "read_todos",
    "toggle_todo",
    "add_todo",
    "move_todo",
    "discover_project_documents",
    "read_project_document",
    "write_project_document",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
