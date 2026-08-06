//! Listening-port discovery, enrichment, and process termination policy.

#![forbid(unsafe_code)]

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use tauri::{plugin::TauriPlugin, Manager, Runtime, State};

pub const PLUGIN_NAME: &str = "shep-ports";
pub const LIST_LISTENING_PORTS_COMMAND: &str = "plugin:shep-ports|list_listening_ports";
pub const KILL_PORT_COMMAND: &str = "plugin:shep-ports|kill_port";

/// Read-only access to the host's registered project paths.
pub trait ProjectCatalog: Send + Sync {
    fn registered_project_paths(&self) -> Result<Vec<String>, String>;
}

/// Bounded process observation and control required by this module.
///
/// The raw text is deliberately limited to the output of these fixed
/// observations; this is not a general command-execution interface.
pub trait ProcessAuthority: Send + Sync {
    fn listening_tcp_sockets(&self) -> String;
    fn process_summaries(&self, pids: &[u32]) -> String;
    fn process_working_directories(&self, pids: &[u32]) -> String;
    fn terminate_process(&self, pid: u32) -> Result<(), String>;
}

#[derive(Clone)]
pub struct HostServices {
    projects: Arc<dyn ProjectCatalog>,
    processes: Arc<dyn ProcessAuthority>,
}

impl HostServices {
    pub fn new(projects: Arc<dyn ProjectCatalog>, processes: Arc<dyn ProcessAuthority>) -> Self {
        Self {
            projects,
            processes,
        }
    }
}

#[derive(Debug, serde::Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub port: u16,
    pub pid: u32,
    pub process: String,
    pub cwd: String,
    pub project: String,
    pub framework: String,
    pub uptime: String,
    pub memory_kb: u64,
}

struct ListenerEntry {
    port: u16,
    pid: u32,
    process_name: String,
}

/// Module core used by both the namespaced command and the transitional flat adapter.
pub fn scan_listening_ports(services: &HostServices) -> Result<Vec<PortInfo>, String> {
    let repo_paths = services.projects.registered_project_paths()?;
    let entries = parse_listeners(&services.processes.listening_tcp_sockets());
    if entries.is_empty() {
        return Ok(Vec::new());
    }

    let pids: Vec<u32> = entries.iter().map(|entry| entry.pid).collect();
    let summaries = parse_process_summaries(&services.processes.process_summaries(&pids));
    let working_directories =
        parse_working_directories(&services.processes.process_working_directories(&pids));

    let mut results = Vec::with_capacity(entries.len());
    for entry in entries {
        let (memory_kb, uptime, command) = summaries
            .get(&entry.pid)
            .map(|(rss, uptime, command)| (*rss, uptime.as_str(), command.as_str()))
            .unwrap_or((0, "", ""));
        let raw_cwd = working_directories
            .get(&entry.pid)
            .cloned()
            .unwrap_or_default();
        let project_root = find_project_root(&raw_cwd);

        results.push(PortInfo {
            port: entry.port,
            pid: entry.pid,
            process: entry.process_name.clone(),
            cwd: project_root.clone(),
            project: match_project(&project_root, &repo_paths),
            framework: detect_framework(&entry.process_name, command, &project_root),
            uptime: uptime.to_string(),
            memory_kb,
        });
    }

    results.sort_by_key(|port| port.port);
    Ok(results)
}

/// Module core used by both the namespaced command and the transitional flat adapter.
pub fn terminate_port_process(services: &HostServices, pid: u32) -> Result<(), String> {
    services.processes.terminate_process(pid)
}

#[tauri::command]
async fn list_listening_ports(services: State<'_, HostServices>) -> Result<Vec<PortInfo>, String> {
    scan_listening_ports(&services)
}

#[tauri::command]
async fn kill_port(services: State<'_, HostServices>, pid: u32) -> Result<(), String> {
    terminate_port_process(&services, pid)
}

pub fn init<R: Runtime>(services: HostServices) -> TauriPlugin<R> {
    tauri::plugin::Builder::new(PLUGIN_NAME)
        .setup(move |app, _api| {
            app.manage(services.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![list_listening_ports, kill_port])
        .build()
}

fn parse_listeners(output: &str) -> Vec<ListenerEntry> {
    let mut ports = HashSet::new();
    let mut entries = Vec::new();

    for line in output.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 9 {
            continue;
        }
        let process_name = parts[0].to_string();
        let Some(pid) = parts[1].parse().ok() else {
            continue;
        };
        let Some(port) = extract_port(parts[8]) else {
            continue;
        };
        if !ports.insert(port) || !is_dev_process(&process_name) {
            continue;
        }
        entries.push(ListenerEntry {
            port,
            pid,
            process_name,
        });
    }

    entries
}

fn parse_process_summaries(output: &str) -> HashMap<u32, (u64, String, String)> {
    let mut summaries = HashMap::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut parts = trimmed.splitn(4, char::is_whitespace);
        let Some(pid) = parts.next().and_then(|part| part.parse().ok()) else {
            continue;
        };
        let memory_kb = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
        let uptime = parts.next().unwrap_or("").to_string();
        let command = parts.next().unwrap_or("").to_string();
        summaries.insert(pid, (memory_kb, uptime, command));
    }
    summaries
}

fn parse_working_directories(output: &str) -> HashMap<u32, String> {
    let mut directories = HashMap::new();
    for line in output.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 9 {
            continue;
        }
        let Ok(pid) = parts[1].parse() else {
            continue;
        };
        let path = parts[8..].join(" ");
        if path.starts_with('/') {
            directories.insert(pid, path);
        }
    }
    directories
}

fn extract_port(name_field: &str) -> Option<u16> {
    name_field.rsplit(':').next()?.parse().ok()
}

fn is_dev_process(process_name: &str) -> bool {
    let name = process_name.to_lowercase();
    let system_apps = [
        "spotify",
        "raycast",
        "tableplus",
        "postman",
        "linear",
        "controlce",
        "rapportd",
        "superhuma",
        "setappage",
        "slack",
        "discord",
        "firefox",
        "chrome",
        "google",
        "safari",
        "figma",
        "notion",
        "zoom",
        "teams",
        "iterm2",
        "warp",
        "arc",
        "loginwindow",
        "windowserver",
        "systemuise",
        "kernel_tas",
        "launchd",
        "mdworker",
        "mds_store",
        "cfprefsd",
        "coreaudio",
        "corebrigh",
        "airportd",
        "bluetoothd",
        "sharingd",
        "usernoted",
        "notificat",
        "cloudd",
    ];
    !system_apps.iter().any(|app| name.starts_with(app))
}

fn find_project_root(cwd: &str) -> String {
    if cwd.is_empty() {
        return String::new();
    }
    let markers = [
        "package.json",
        "Cargo.toml",
        "go.mod",
        "pyproject.toml",
        "Gemfile",
        "pom.xml",
        "build.gradle",
    ];
    let mut current = std::path::PathBuf::from(cwd);
    for _ in 0..15 {
        if markers.iter().any(|marker| current.join(marker).exists()) {
            return current.to_string_lossy().to_string();
        }
        if !current.pop() {
            break;
        }
    }
    cwd.to_string()
}

fn detect_framework(process: &str, command: &str, project_root: &str) -> String {
    let command = command.to_lowercase();
    let command_frameworks = [
        ("next", "Next.js"),
        ("vite", "Vite"),
        ("nuxt", "Nuxt"),
        ("webpack", "Webpack"),
        ("remix", "Remix"),
        ("astro", "Astro"),
        ("gatsby", "Gatsby"),
        ("flask", "Flask"),
        ("uvicorn", "FastAPI"),
        ("rails", "Rails"),
        ("storybook", "Storybook"),
    ];
    for (needle, framework) in command_frameworks {
        if command.contains(needle) {
            return framework.to_string();
        }
    }
    if command.contains("angular") || command.contains("ng serve") {
        return "Angular".to_string();
    }
    if command.contains("django") || command.contains("manage.py") {
        return "Django".to_string();
    }
    if command.contains("cargo") || command.contains("rustc") {
        return "Rust".to_string();
    }

    let name = process.to_lowercase();
    let process_framework = if name == "node" {
        "Node.js"
    } else if name.starts_with("python") {
        "Python"
    } else if name.starts_with("ruby") {
        "Ruby"
    } else if name.starts_with("java") {
        "Java"
    } else if name == "go" {
        "Go"
    } else if name.contains("postgres") || name == "postmaster" {
        "PostgreSQL"
    } else if name.contains("redis") {
        "Redis"
    } else if name.contains("mongod") {
        "MongoDB"
    } else if name.contains("mysqld") {
        "MySQL"
    } else if name.contains("docker") || name.starts_with("com.docke") {
        "Docker"
    } else if name.contains("nginx") {
        "nginx"
    } else {
        ""
    };
    if !process_framework.is_empty() {
        return process_framework.to_string();
    }

    if !project_root.is_empty() {
        let root = Path::new(project_root);
        let file_frameworks = [
            (&["vite.config.ts", "vite.config.js"][..], "Vite"),
            (&["next.config.js", "next.config.mjs"][..], "Next.js"),
            (&["angular.json"][..], "Angular"),
            (&["Cargo.toml"][..], "Rust"),
            (&["go.mod"][..], "Go"),
            (&["manage.py"][..], "Django"),
            (&["Gemfile"][..], "Ruby"),
        ];
        for (files, framework) in file_frameworks {
            if files.iter().any(|file| root.join(file).exists()) {
                return framework.to_string();
            }
        }
    }

    String::new()
}

fn match_project(cwd: &str, repo_paths: &[String]) -> String {
    if cwd.is_empty() {
        return String::new();
    }
    repo_paths
        .iter()
        .filter(|repo| cwd.starts_with(repo.as_str()))
        .max_by_key(|repo| repo.len())
        .and_then(|repo| repo.rsplit('/').next())
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    struct FakeProjects(Vec<String>);

    impl ProjectCatalog for FakeProjects {
        fn registered_project_paths(&self) -> Result<Vec<String>, String> {
            Ok(self.0.clone())
        }
    }

    struct FakeProcesses {
        listeners: String,
        summaries: String,
        directories: String,
        terminated: Mutex<Vec<u32>>,
    }

    impl ProcessAuthority for FakeProcesses {
        fn listening_tcp_sockets(&self) -> String {
            self.listeners.clone()
        }

        fn process_summaries(&self, _pids: &[u32]) -> String {
            self.summaries.clone()
        }

        fn process_working_directories(&self, _pids: &[u32]) -> String {
            self.directories.clone()
        }

        fn terminate_process(&self, pid: u32) -> Result<(), String> {
            self.terminated.lock().unwrap().push(pid);
            Ok(())
        }
    }

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
    fn missing_observation_is_a_bounded_empty_result() {
        let services = HostServices::new(
            Arc::new(FakeProjects(Vec::new())),
            Arc::new(FakeProcesses {
                listeners: String::new(),
                summaries: String::new(),
                directories: String::new(),
                terminated: Mutex::new(Vec::new()),
            }),
        );
        assert!(scan_listening_ports(&services).unwrap().is_empty());
    }

    #[test]
    fn project_root_walks_up_to_a_supported_marker() {
        let root = synthetic_project();
        assert_eq!(
            find_project_root(root.join("apps/web/src").to_str().unwrap()),
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

    #[test]
    fn module_core_enriches_and_sorts_observed_listeners() {
        let root = synthetic_project();
        let root_text = root.to_string_lossy();
        let processes = Arc::new(FakeProcesses {
            listeners: "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 22 user 1u IPv4 0 0t0 TCP *:5173\npython3 11 user 1u IPv4 0 0t0 TCP *:3000\n".to_string(),
            summaries: "22 2048 00:02 vite dev\n11 1024 00:01 uvicorn app\n".to_string(),
            directories: format!("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 22 user cwd DIR 0 0 0 {root_text}\npython3 11 user cwd DIR 0 0 0 {root_text}\n"),
            terminated: Mutex::new(Vec::new()),
        });
        let services = HostServices::new(
            Arc::new(FakeProjects(vec![root_text.to_string()])),
            processes.clone(),
        );

        let ports = scan_listening_ports(&services).unwrap();
        assert_eq!(
            ports.iter().map(|port| port.port).collect::<Vec<_>>(),
            vec![3000, 5173]
        );
        assert_eq!(ports[0].framework, "FastAPI");
        assert_eq!(ports[1].framework, "Vite");
        assert_eq!(ports[1].memory_kb, 2048);

        terminate_port_process(&services, 22).unwrap();
        assert_eq!(*processes.terminated.lock().unwrap(), vec![22]);
        fs::remove_dir_all(root).unwrap();
    }
}
