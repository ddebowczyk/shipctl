const COMMANDS: &[&str] = &["list_skills", "setup_skill", "remove_skill"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
