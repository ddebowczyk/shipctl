use std::path::Path;

fn main() {
    println!("cargo:rustc-check-cfg=cfg(shipctl_bundled_modules)");
    let bundled_modules = Path::new("generated/bundled_modules.rs");
    println!("cargo:rerun-if-changed={}", bundled_modules.display());
    if bundled_modules.is_file() {
        println!("cargo:rustc-cfg=shipctl_bundled_modules");
    }

    println!("cargo:rerun-if-env-changed=SHIPCTL_BUILD_ID");
    let build_id = std::env::var("SHIPCTL_BUILD_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "development-unrecorded".to_string());
    println!("cargo:rustc-env=SHIPCTL_BUILD_ID={build_id}");

    let config_path = Path::new("tauri.conf.json");
    println!("cargo:rerun-if-changed={}", config_path.display());
    let config = std::fs::read_to_string(config_path)
        .expect("could not read tauri.conf.json for the app version");
    let config: serde_json::Value =
        serde_json::from_str(&config).expect("tauri.conf.json is not valid JSON");
    let version = config
        .get("version")
        .and_then(serde_json::Value::as_str)
        .expect("tauri.conf.json must contain a string version");
    println!("cargo:rustc-env=SHIPCTL_APP_VERSION={version}");

    // `externalBin` is a packaging input, but tauri-build validates it during
    // ordinary `cargo check` and `cargo test` as well. The Tauri build hook
    // materializes the target-specific CLI before packaging. Keep plain Cargo
    // workflows clean-clone safe by removing only that packaging input when
    // the generated sidecar is absent.
    let target = std::env::var("TARGET").expect("Cargo did not provide TARGET");
    let extension = if target.contains("-windows-") {
        ".exe"
    } else {
        ""
    };
    let sidecar = format!("binaries/shipctl-{target}{extension}");
    println!("cargo:rerun-if-changed={sidecar}");
    if !Path::new(&sidecar).is_file() && std::env::var_os("TAURI_CONFIG").is_none() {
        std::env::set_var("TAURI_CONFIG", r#"{"bundle":{"externalBin":[]}}"#);
        println!("cargo:warning=CLI sidecar omitted from this non-packaging Cargo build");
    }

    tauri_build::build()
}
