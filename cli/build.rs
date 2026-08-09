use std::path::Path;

fn main() {
    println!("cargo:rerun-if-env-changed=SHIPCTL_BUILD_ID");
    let build_id = std::env::var("SHIPCTL_BUILD_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "development-unrecorded".to_string());
    println!("cargo:rustc-env=SHIPCTL_BUILD_ID={build_id}");

    let config_path = Path::new("../src-tauri/tauri.conf.json");
    println!("cargo:rerun-if-changed={}", config_path.display());

    let config = std::fs::read_to_string(config_path)
        .expect("could not read src-tauri/tauri.conf.json for the app version");
    let config: serde_json::Value =
        serde_json::from_str(&config).expect("src-tauri/tauri.conf.json is not valid JSON");
    let version = config
        .get("version")
        .and_then(serde_json::Value::as_str)
        .expect("src-tauri/tauri.conf.json must contain a string version");
    println!("cargo:rustc-env=SHIPCTL_APP_VERSION={version}");
}
