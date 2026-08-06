use std::fs;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::{
    detect_framework, extract_port, find_project_root, is_dev_process, match_project,
    run_with_timeout,
};

fn synthetic_project() -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "shep-ports-characterization-{}-{nonce}",
        std::process::id(),
    ));
    fs::create_dir_all(root.join("apps/web/src")).unwrap();
    fs::write(root.join("package.json"), "{}").unwrap();
    root
}

#[test]
fn parses_ipv4_ipv6_and_wildcard_listener_names() {
    assert_eq!(extract_port("*:3000"), Some(3000));
    assert_eq!(extract_port("127.0.0.1:8080"), Some(8080));
    assert_eq!(extract_port("[::1]:5173"), Some(5173));
    assert_eq!(extract_port("localhost:http"), None);
}

#[test]
fn excludes_known_desktop_processes_but_keeps_dev_runtimes() {
    assert!(!is_dev_process("Google Chrome"));
    assert!(!is_dev_process("Slack Helper"));
    assert!(is_dev_process("node"));
    assert!(is_dev_process("python3"));
}

#[test]
fn missing_observation_tool_is_a_bounded_empty_result() {
    let output = run_with_timeout(
        "__shep_missing_port_observer__",
        &[],
        Duration::from_millis(10),
    );
    assert!(output.is_empty());
}

#[test]
fn project_root_walks_up_to_a_supported_marker() {
    let root = synthetic_project();
    let nested = root.join("apps/web/src");

    assert_eq!(
        find_project_root(nested.to_str().unwrap()),
        root.to_string_lossy()
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn framework_detection_prioritizes_command_then_process_then_files() {
    let root = synthetic_project();
    fs::write(root.join("vite.config.ts"), "export default {}").unwrap();

    assert_eq!(
        detect_framework("node", "next dev", root.to_str().unwrap()),
        "Next.js"
    );
    assert_eq!(detect_framework("python3", "server.py", ""), "Python");
    assert_eq!(
        detect_framework("custom", "serve", root.to_str().unwrap()),
        "Vite"
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn project_matching_uses_the_longest_registered_path_and_basename() {
    let repos = vec![
        "/work/acme".to_string(),
        "/work/acme/services/api".to_string(),
        "/work/other".to_string(),
    ];

    assert_eq!(match_project("/work/acme/services/api/src", &repos), "api");
    assert_eq!(match_project("/unregistered/project", &repos), "");
    assert_eq!(match_project("", &repos), "");
}
