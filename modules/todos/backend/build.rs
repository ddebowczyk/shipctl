const COMMANDS: &[&str] = &["read_todos", "toggle_todo", "add_todo", "move_todo"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
