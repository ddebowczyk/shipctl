//! Scoped process observation and control.
//!
//! This provider owns operating-system authority and activation-scoped
//! inspection identities. It contains no Ports workflow or presentation
//! policy. Callers supply the file names that identify their project roots and
//! interpret the resulting process facts in TypeScript.

#![forbid(unsafe_code)]

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use uuid::Uuid;

pub const PROCESSES_DENIED: &str = "processes.denied";
pub const PROCESSES_STALE_INSPECTION: &str = "processes.stale-inspection";
pub const PROCESSES_ACTIVATION_DISPOSED: &str = "processes.activation-disposed";
pub const PROCESSES_INVALID_REQUEST: &str = "processes.invalid-request";
pub const PROCESSES_TRANSPORT_FAILED: &str = "processes.transport-failed";

// Preserve the bounded observation behavior of the extracted Ports provider.
const OBSERVATION_TIMEOUT: Duration = Duration::from_secs(5);
const PROJECT_ROOT_ANCESTORS: usize = 15;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessesActor {
    pub module_id: String,
    pub activation_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectListeningProcessesInput {
    #[serde(default)]
    pub project_root_markers: Vec<String>,
    #[serde(default)]
    pub observed_project_file_names: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningProcessInspection {
    pub inspection_id: String,
    pub port: u16,
    pub process_id: u32,
    pub name: String,
    pub working_directory: String,
    pub command_line: String,
    pub observed_project_files: Vec<String>,
    pub uptime: String,
    pub memory_kilobytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminateInspectedProcessInput {
    pub inspection_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminatedProcess {
    pub inspection_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectCommandInput {
    pub command: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandInspection {
    pub command: String,
    pub available: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessesError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

/// The fixed, bounded OS observations required by the process capability.
/// This is not a general command-execution interface.
pub trait ProcessAuthority: Send + Sync {
    fn listening_tcp_sockets(&self) -> String;
    fn process_summaries(&self, process_ids: &[u32]) -> String;
    fn process_working_directories(&self, process_ids: &[u32]) -> String;
    fn process_start_time(&self, process_id: u32) -> Option<u64>;
    fn terminate_process(&self, process_id: u32) -> Result<(), String>;
    fn command_available(&self, command: &str) -> bool;
    fn file_exists(&self, path: &Path) -> bool;
}

#[derive(Default)]
pub struct SystemProcessAuthority;

impl ProcessAuthority for SystemProcessAuthority {
    fn listening_tcp_sockets(&self) -> String {
        run_with_timeout(
            "lsof",
            &["-iTCP", "-sTCP:LISTEN", "-P", "-n"],
            OBSERVATION_TIMEOUT,
        )
    }

    fn process_summaries(&self, process_ids: &[u32]) -> String {
        let process_ids = joined_process_ids(process_ids);
        run_with_timeout(
            "ps",
            &["-p", &process_ids, "-o", "pid=,rss=,etime=,command="],
            OBSERVATION_TIMEOUT,
        )
    }

    fn process_working_directories(&self, process_ids: &[u32]) -> String {
        let process_ids = joined_process_ids(process_ids);
        run_with_timeout(
            "lsof",
            &["-a", "-d", "cwd", "-p", &process_ids],
            OBSERVATION_TIMEOUT,
        )
    }

    fn process_start_time(&self, process_id: u32) -> Option<u64> {
        let pid = Pid::from_u32(process_id);
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing(),
        );
        system.process(pid).map(sysinfo::Process::start_time)
    }

    fn terminate_process(&self, process_id: u32) -> Result<(), String> {
        let process_id_text = process_id.to_string();
        let status = Command::new("kill")
            .arg(&process_id_text)
            .status()
            .map_err(|error| format!("Failed to terminate process {process_id}: {error}"))?;
        if status.success() {
            return Ok(());
        }
        let forced = Command::new("kill")
            .args(["-9", &process_id_text])
            .status()
            .map_err(|error| format!("Failed to force-terminate process {process_id}: {error}"))?;
        if forced.success() {
            Ok(())
        } else {
            Err(format!("Failed to force-terminate process {process_id}"))
        }
    }

    fn command_available(&self, command: &str) -> bool {
        Command::new("which")
            .arg(command)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    fn file_exists(&self, path: &Path) -> bool {
        path.is_file()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessGrant {
    Inspect,
    Terminate,
}

#[derive(Clone, Debug)]
struct ProcessPolicy {
    module_id: &'static str,
    grants: &'static [ProcessGrant],
}

const INSPECT_ONLY: &[ProcessGrant] = &[ProcessGrant::Inspect];
const INSPECT_AND_TERMINATE: &[ProcessGrant] = &[ProcessGrant::Inspect, ProcessGrant::Terminate];
const DEFAULT_POLICIES: &[ProcessPolicy] = &[
    ProcessPolicy {
        module_id: "core",
        grants: INSPECT_ONLY,
    },
    ProcessPolicy {
        module_id: "shipctl.assistants",
        grants: INSPECT_ONLY,
    },
    ProcessPolicy {
        module_id: "shipctl.ports",
        grants: INSPECT_AND_TERMINATE,
    },
];

#[derive(Clone, Debug)]
struct InspectionLease {
    process_id: u32,
    process_start_time: u64,
}

#[derive(Default)]
struct ProcessesState {
    inspections_by_activation: HashMap<String, HashMap<String, InspectionLease>>,
    released_activations: HashSet<String>,
}

struct ProcessesServiceInner {
    authority: Arc<dyn ProcessAuthority>,
    policies: Vec<ProcessPolicy>,
    state: Mutex<ProcessesState>,
}

#[derive(Clone)]
pub struct ProcessesService {
    inner: Arc<ProcessesServiceInner>,
}

impl Default for ProcessesService {
    fn default() -> Self {
        Self::system()
    }
}

impl ProcessesService {
    pub fn system() -> Self {
        Self::with_authority(Arc::new(SystemProcessAuthority))
    }

    pub fn with_authority(authority: Arc<dyn ProcessAuthority>) -> Self {
        Self::with_policies(authority, DEFAULT_POLICIES.to_vec())
    }

    fn with_policies(authority: Arc<dyn ProcessAuthority>, policies: Vec<ProcessPolicy>) -> Self {
        Self {
            inner: Arc::new(ProcessesServiceInner {
                authority,
                policies,
                state: Mutex::new(ProcessesState::default()),
            }),
        }
    }

    pub fn inspect_listening_processes(
        &self,
        actor: &ProcessesActor,
        input: InspectListeningProcessesInput,
    ) -> Result<Vec<ListeningProcessInspection>, ProcessesError> {
        self.authorize(actor, ProcessGrant::Inspect)?;
        let markers = validate_project_root_markers(input.project_root_markers)?;
        let observed_file_names = validate_project_root_markers(input.observed_project_file_names)?;
        let listeners = parse_listeners(&self.inner.authority.listening_tcp_sockets());
        if listeners.is_empty() {
            self.replace_inspections(actor, HashMap::new())?;
            return Ok(Vec::new());
        }

        let process_ids = listeners
            .iter()
            .map(|listener| listener.process_id)
            .collect::<Vec<_>>();
        let summaries =
            parse_process_summaries(&self.inner.authority.process_summaries(&process_ids));
        let working_directories = parse_working_directories(
            &self
                .inner
                .authority
                .process_working_directories(&process_ids),
        );

        let mut inspections = Vec::with_capacity(listeners.len());
        let mut leases = HashMap::new();
        for listener in listeners {
            let Some(process_start_time) =
                self.inner.authority.process_start_time(listener.process_id)
            else {
                // The listener ended during observation. Publishing an ID
                // without a stable process identity would make termination
                // unsafe, so this transient entry is omitted.
                continue;
            };
            let summary = summaries.get(&listener.process_id);
            let raw_directory = working_directories
                .get(&listener.process_id)
                .cloned()
                .unwrap_or_default();
            let project_directory =
                find_project_root(&raw_directory, &markers, self.inner.authority.as_ref());
            let observed_project_files = observed_file_names
                .iter()
                .filter(|marker| {
                    !project_directory.is_empty()
                        && self
                            .inner
                            .authority
                            .file_exists(&Path::new(&project_directory).join(marker))
                })
                .cloned()
                .collect::<Vec<_>>();
            let inspection_id = Uuid::new_v4().to_string();
            leases.insert(
                inspection_id.clone(),
                InspectionLease {
                    process_id: listener.process_id,
                    process_start_time,
                },
            );
            inspections.push(ListeningProcessInspection {
                inspection_id,
                port: listener.port,
                process_id: listener.process_id,
                name: listener.process_name,
                working_directory: project_directory,
                command_line: summary
                    .map(|summary| summary.command_line.clone())
                    .unwrap_or_default(),
                observed_project_files,
                uptime: summary
                    .map(|summary| summary.uptime.clone())
                    .unwrap_or_default(),
                memory_kilobytes: summary.map(|summary| summary.memory_kilobytes).unwrap_or(0),
            });
        }
        inspections.sort_by_key(|inspection| inspection.port);
        self.replace_inspections(actor, leases)?;
        Ok(inspections)
    }

    pub fn terminate_inspected_process(
        &self,
        actor: &ProcessesActor,
        input: TerminateInspectedProcessInput,
    ) -> Result<TerminatedProcess, ProcessesError> {
        self.authorize(actor, ProcessGrant::Terminate)?;
        validate_identity(&input.inspection_id, "inspection ID")?;
        let lease = {
            let state = self.lock_state()?;
            state
                .inspections_by_activation
                .get(&actor.activation_id)
                .and_then(|inspections| inspections.get(&input.inspection_id))
                .cloned()
        }
        .ok_or_else(stale_inspection)?;

        if self.inner.authority.process_start_time(lease.process_id)
            != Some(lease.process_start_time)
        {
            self.remove_inspection(actor, &input.inspection_id)?;
            return Err(stale_inspection());
        }
        self.inner
            .authority
            .terminate_process(lease.process_id)
            .map_err(|message| error(PROCESSES_TRANSPORT_FAILED, message))?;

        let mut state = self.lock_state()?;
        if let Some(inspections) = state
            .inspections_by_activation
            .get_mut(&actor.activation_id)
        {
            inspections.retain(|_, candidate| {
                candidate.process_id != lease.process_id
                    || candidate.process_start_time != lease.process_start_time
            });
        }
        Ok(TerminatedProcess {
            inspection_id: input.inspection_id,
        })
    }

    pub fn inspect_command(
        &self,
        actor: &ProcessesActor,
        input: InspectCommandInput,
    ) -> Result<CommandInspection, ProcessesError> {
        self.authorize(actor, ProcessGrant::Inspect)?;
        let command = input.command.trim();
        if command.is_empty() || command.chars().any(char::is_control) {
            return Err(error(PROCESSES_INVALID_REQUEST, "Command is invalid"));
        }
        Ok(CommandInspection {
            command: command.to_string(),
            available: self.inner.authority.command_available(command),
        })
    }

    /// Release activation-owned inspection leases without changing a process.
    pub fn release_activation(&self, actor: &ProcessesActor) -> Result<usize, ProcessesError> {
        validate_actor(actor)?;
        self.require_grant(&actor.module_id, ProcessGrant::Inspect)?;
        let mut state = self.lock_state()?;
        state
            .released_activations
            .insert(actor.activation_id.clone());
        Ok(state
            .inspections_by_activation
            .remove(&actor.activation_id)
            .map(|inspections| inspections.len())
            .unwrap_or(0))
    }

    fn authorize(&self, actor: &ProcessesActor, grant: ProcessGrant) -> Result<(), ProcessesError> {
        validate_actor(actor)?;
        self.require_grant(&actor.module_id, grant)?;
        if self
            .lock_state()?
            .released_activations
            .contains(&actor.activation_id)
        {
            return Err(error(
                PROCESSES_ACTIVATION_DISPOSED,
                "The process capability activation is disposed",
            ));
        }
        Ok(())
    }

    fn require_grant(&self, module_id: &str, grant: ProcessGrant) -> Result<(), ProcessesError> {
        self.inner
            .policies
            .iter()
            .find(|policy| policy.module_id == module_id && policy.grants.contains(&grant))
            .map(|_| ())
            .ok_or_else(|| error(PROCESSES_DENIED, "Process capability access was denied"))
    }

    fn replace_inspections(
        &self,
        actor: &ProcessesActor,
        inspections: HashMap<String, InspectionLease>,
    ) -> Result<(), ProcessesError> {
        self.lock_state()?
            .inspections_by_activation
            .insert(actor.activation_id.clone(), inspections);
        Ok(())
    }

    fn remove_inspection(
        &self,
        actor: &ProcessesActor,
        inspection_id: &str,
    ) -> Result<(), ProcessesError> {
        if let Some(inspections) = self
            .lock_state()?
            .inspections_by_activation
            .get_mut(&actor.activation_id)
        {
            inspections.remove(inspection_id);
        }
        Ok(())
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, ProcessesState>, ProcessesError> {
        self.inner.state.lock().map_err(|_| {
            error(
                PROCESSES_TRANSPORT_FAILED,
                "Process capability state lock is poisoned",
            )
        })
    }
}

#[derive(Clone, Debug)]
struct ListenerEntry {
    port: u16,
    process_id: u32,
    process_name: String,
}

#[derive(Clone, Debug)]
struct ProcessSummary {
    memory_kilobytes: u64,
    uptime: String,
    command_line: String,
}

fn parse_listeners(output: &str) -> Vec<ListenerEntry> {
    let mut ports = HashSet::new();
    let mut entries = Vec::new();
    for line in output.lines().skip(1) {
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() < 9 {
            continue;
        }
        let Some(process_id) = parts[1].parse().ok() else {
            continue;
        };
        let Some(port) = extract_port(parts[8]) else {
            continue;
        };
        if !ports.insert(port) {
            continue;
        }
        entries.push(ListenerEntry {
            port,
            process_id,
            process_name: parts[0].to_string(),
        });
    }
    entries
}

fn parse_process_summaries(output: &str) -> HashMap<u32, ProcessSummary> {
    let mut summaries = HashMap::new();
    for line in output.lines() {
        let mut parts = line.split_whitespace();
        let Some(process_id) = parts.next().and_then(|part| part.parse().ok()) else {
            continue;
        };
        let memory_kilobytes = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
        let uptime = parts.next().unwrap_or_default().to_string();
        let command_line = parts.collect::<Vec<_>>().join(" ");
        summaries.insert(
            process_id,
            ProcessSummary {
                memory_kilobytes,
                uptime,
                command_line,
            },
        );
    }
    summaries
}

fn parse_working_directories(output: &str) -> HashMap<u32, String> {
    let mut directories = HashMap::new();
    for line in output.lines().skip(1) {
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() < 9 {
            continue;
        }
        let Ok(process_id) = parts[1].parse() else {
            continue;
        };
        let path = parts[8..].join(" ");
        if path.starts_with('/') {
            directories.insert(process_id, path);
        }
    }
    directories
}

fn extract_port(name_field: &str) -> Option<u16> {
    name_field.rsplit(':').next()?.parse().ok()
}

fn validate_project_root_markers(markers: Vec<String>) -> Result<Vec<String>, ProcessesError> {
    let mut normalized = BTreeSet::new();
    for marker in markers {
        if marker.trim() != marker
            || marker.is_empty()
            || marker == "."
            || marker == ".."
            || marker.chars().any(char::is_control)
            || Path::new(&marker)
                .file_name()
                .and_then(|name| name.to_str())
                != Some(&marker)
        {
            return Err(error(
                PROCESSES_INVALID_REQUEST,
                "Project root marker must be one file name",
            ));
        }
        normalized.insert(marker);
    }
    Ok(normalized.into_iter().collect())
}

fn find_project_root(
    working_directory: &str,
    markers: &[String],
    authority: &dyn ProcessAuthority,
) -> String {
    if working_directory.is_empty() || markers.is_empty() {
        return working_directory.to_string();
    }
    let mut current = PathBuf::from(working_directory);
    for _ in 0..PROJECT_ROOT_ANCESTORS {
        if markers
            .iter()
            .any(|marker| authority.file_exists(&current.join(marker)))
        {
            return current.to_string_lossy().to_string();
        }
        if !current.pop() {
            break;
        }
    }
    working_directory.to_string()
}

fn validate_actor(actor: &ProcessesActor) -> Result<(), ProcessesError> {
    validate_identity(&actor.module_id, "module ID")?;
    validate_identity(&actor.activation_id, "activation ID")?;
    if !actor
        .activation_id
        .starts_with(&format!("{}@", actor.module_id))
    {
        return Err(error(
            PROCESSES_DENIED,
            "Process capability activation does not belong to the requesting module",
        ));
    }
    Ok(())
}

fn validate_identity(value: &str, label: &str) -> Result<(), ProcessesError> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        Err(error(
            PROCESSES_INVALID_REQUEST,
            format!("Process capability {label} is invalid"),
        ))
    } else {
        Ok(())
    }
}

fn stale_inspection() -> ProcessesError {
    error(
        PROCESSES_STALE_INSPECTION,
        "The process inspection is no longer current",
    )
}

fn error(code: &str, message: impl Into<String>) -> ProcessesError {
    ProcessesError {
        code: code.to_string(),
        message: message.into(),
        retryable: false,
    }
}

fn joined_process_ids(process_ids: &[u32]) -> String {
    process_ids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

fn run_with_timeout(command: &str, args: &[&str], timeout: Duration) -> String {
    let mut child = match Command::new(command)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return String::new(),
    };
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                return String::new();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return String::new(),
        }
    }
    child
        .stdout
        .take()
        .and_then(|mut output| {
            let mut buffer = String::new();
            output.read_to_string(&mut buffer).ok()?;
            Some(buffer)
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use std::collections::BTreeMap;

    #[derive(Default)]
    struct FakeAuthority {
        listeners: Mutex<String>,
        summaries: Mutex<String>,
        directories: Mutex<String>,
        identities: Mutex<HashMap<u32, u64>>,
        existing_files: Mutex<HashSet<PathBuf>>,
        available_commands: Mutex<HashSet<String>>,
        terminated: Mutex<Vec<u32>>,
    }

    impl ProcessAuthority for FakeAuthority {
        fn listening_tcp_sockets(&self) -> String {
            self.listeners.lock().unwrap().clone()
        }

        fn process_summaries(&self, _process_ids: &[u32]) -> String {
            self.summaries.lock().unwrap().clone()
        }

        fn process_working_directories(&self, _process_ids: &[u32]) -> String {
            self.directories.lock().unwrap().clone()
        }

        fn process_start_time(&self, process_id: u32) -> Option<u64> {
            self.identities.lock().unwrap().get(&process_id).copied()
        }

        fn terminate_process(&self, process_id: u32) -> Result<(), String> {
            self.terminated.lock().unwrap().push(process_id);
            Ok(())
        }

        fn command_available(&self, command: &str) -> bool {
            self.available_commands.lock().unwrap().contains(command)
        }

        fn file_exists(&self, path: &Path) -> bool {
            self.existing_files.lock().unwrap().contains(path)
        }
    }

    fn actor(module_id: &str, suffix: &str) -> ProcessesActor {
        ProcessesActor {
            module_id: module_id.to_string(),
            activation_id: format!("{module_id}@1.0.0#{suffix}"),
        }
    }

    fn fixture() -> (Arc<FakeAuthority>, ProcessesService) {
        let authority = Arc::new(FakeAuthority::default());
        *authority.listeners.lock().unwrap() = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 22 user 1u IPv4 0 0t0 TCP *:5173\npython3 11 user 1u IPv4 0 0t0 TCP *:3000\n".to_string();
        *authority.summaries.lock().unwrap() =
            "22 2048 00:02 vite dev\n11 1024 00:01 uvicorn app\n".to_string();
        *authority.directories.lock().unwrap() = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 22 user cwd DIR 0 0 0 /work/app/src\npython3 11 user cwd DIR 0 0 0 /work/api\n".to_string();
        authority
            .identities
            .lock()
            .unwrap()
            .extend([(11, 101), (22, 202)]);
        authority
            .existing_files
            .lock()
            .unwrap()
            .insert(PathBuf::from("/work/app/package.json"));
        let service = ProcessesService::with_authority(authority.clone());
        (authority, service)
    }

    #[test]
    fn provider_preserves_characterized_observation_projection() {
        let (_authority, service) = fixture();
        let inspections = service
            .inspect_listening_processes(
                &actor("shipctl.ports", "parity"),
                InspectListeningProcessesInput {
                    project_root_markers: vec!["package.json".to_string()],
                    observed_project_file_names: vec!["package.json".to_string()],
                },
            )
            .unwrap();
        assert_eq!(
            inspections
                .iter()
                .map(|inspection| inspection.port)
                .collect::<Vec<_>>(),
            vec![3000, 5173]
        );
        assert_eq!(inspections[0].command_line, "uvicorn app");
        assert_eq!(inspections[1].working_directory, "/work/app");
        assert_eq!(inspections[1].observed_project_files, vec!["package.json"]);
        assert_eq!(inspections[1].memory_kilobytes, 2048);
    }

    #[test]
    fn reused_pid_is_rejected_without_termination() {
        let (authority, service) = fixture();
        let actor = actor("shipctl.ports", "reuse");
        let inspection = service
            .inspect_listening_processes(
                &actor,
                InspectListeningProcessesInput {
                    project_root_markers: Vec::new(),
                    observed_project_file_names: Vec::new(),
                },
            )
            .unwrap()
            .remove(0);
        authority
            .identities
            .lock()
            .unwrap()
            .insert(inspection.process_id, 999);

        let error = service
            .terminate_inspected_process(
                &actor,
                TerminateInspectedProcessInput {
                    inspection_id: inspection.inspection_id,
                },
            )
            .unwrap_err();
        assert_eq!(error.code, PROCESSES_STALE_INSPECTION);
        assert!(authority.terminated.lock().unwrap().is_empty());
    }

    proptest! {
        #[test]
        fn architecture_provider_processes_parity_property(
            rows in proptest::collection::vec((1u16..=u16::MAX, 1u32..=u32::MAX), 0..80),
        ) {
            let authority = Arc::new(FakeAuthority::default());
            let mut listener_text = String::from("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n");
            let mut expected = BTreeMap::new();
            for (port, process_id) in rows {
                listener_text.push_str(&format!("node {process_id} user 1u IPv4 0 0t0 TCP *:{port}\n"));
                expected.entry(port).or_insert(process_id);
                authority.identities.lock().unwrap().insert(process_id, u64::from(process_id));
            }
            *authority.listeners.lock().unwrap() = listener_text;
            let service = ProcessesService::with_authority(authority);
            let actual = service.inspect_listening_processes(
                &actor("shipctl.ports", "generated"),
                InspectListeningProcessesInput {
                    project_root_markers: Vec::new(),
                    observed_project_file_names: Vec::new(),
                },
            ).unwrap();
            prop_assert_eq!(
                actual.iter().map(|inspection| (inspection.port, inspection.process_id)).collect::<Vec<_>>(),
                expected.into_iter().collect::<Vec<_>>(),
            );
        }

        #[test]
        fn architecture_provider_processes_authority_property(
            module_index in 0usize..4,
            terminate in any::<bool>(),
            matching_activation in any::<bool>(),
            disposed in any::<bool>(),
        ) {
            let modules = ["core", "shipctl.assistants", "shipctl.ports", "shipctl.unknown"];
            let module_id = modules[module_index];
            let mut candidate = actor(module_id, "generated-authority");
            if !matching_activation {
                candidate.activation_id = "shipctl.other@1.0.0#generated-authority".to_string();
            }
            let (_authority, service) = fixture();
            let known = module_id != "shipctl.unknown";
            if disposed && known && matching_activation {
                service.release_activation(&candidate).unwrap();
            }

            let result = if terminate {
                service.terminate_inspected_process(
                    &candidate,
                    TerminateInspectedProcessInput {
                        inspection_id: Uuid::new_v4().to_string(),
                    },
                ).map(|_| ())
            } else {
                service.inspect_listening_processes(
                    &candidate,
                    InspectListeningProcessesInput {
                        project_root_markers: Vec::new(),
                        observed_project_file_names: Vec::new(),
                    },
                ).map(|_| ())
            };

            let expected_code = if !matching_activation || !known || (terminate && module_id != "shipctl.ports") {
                Some(PROCESSES_DENIED)
            } else if disposed {
                Some(PROCESSES_ACTIVATION_DISPOSED)
            } else if terminate {
                Some(PROCESSES_STALE_INSPECTION)
            } else {
                None
            };
            match expected_code {
                Some(code) => prop_assert_eq!(result.unwrap_err().code, code),
                None => prop_assert!(result.is_ok()),
            }
        }

        #[test]
        fn architecture_provider_processes_ownership_property(release_first in any::<bool>()) {
            let (authority, service) = fixture();
            let first = actor("shipctl.ports", "first");
            let second = actor("shipctl.ports", "second");
            let first_inspection = service.inspect_listening_processes(
                &first,
                InspectListeningProcessesInput {
                    project_root_markers: Vec::new(),
                    observed_project_file_names: Vec::new(),
                },
            ).unwrap().remove(0);
            let second_inspection = service.inspect_listening_processes(
                &second,
                InspectListeningProcessesInput {
                    project_root_markers: Vec::new(),
                    observed_project_file_names: Vec::new(),
                },
            ).unwrap().remove(0);
            let (released_actor, released_inspection, live_actor, live_inspection) = if release_first {
                (&first, first_inspection, &second, second_inspection)
            } else {
                (&second, second_inspection, &first, first_inspection)
            };

            prop_assert_eq!(service.release_activation(released_actor).unwrap(), 2);
            prop_assert!(authority.terminated.lock().unwrap().is_empty());
            let disposed = service.terminate_inspected_process(
                released_actor,
                TerminateInspectedProcessInput {
                    inspection_id: released_inspection.inspection_id,
                },
            ).unwrap_err();
            prop_assert_eq!(disposed.code, PROCESSES_ACTIVATION_DISPOSED);
            service.terminate_inspected_process(
                live_actor,
                TerminateInspectedProcessInput {
                    inspection_id: live_inspection.inspection_id,
                },
            ).unwrap();
            let terminated = authority.terminated.lock().unwrap().clone();
            prop_assert_eq!(terminated, vec![11]);
        }
    }
}
