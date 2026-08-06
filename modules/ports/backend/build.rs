const COMMANDS: &[&str] = &["list_listening_ports", "kill_port"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
