use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use shipctl_core::build_info::CONTROL_PROTOCOL_VERSION;
use shipctl_core::instance::{
    resolve_runtime_root, resolve_state_root, ControlError, DiscoveryProblem,
    InstanceBuildIdentity, InstanceDiagnosticReport, InstanceDirectory, InstanceRecord,
    StopOutcome,
};
use shipctl_core::message_bus::{
    MessageDiagnosticReport, MessageRuntimeInspection, RUNTIME_UNAVAILABLE,
};
use shipctl_core::module_control::{
    Diagnostic, ModuleInspection, ModuleOperation, ModuleOperationKind,
};
use shipctl_core::scheduler::{
    ScheduleDiagnosticReport, ScheduleInspection, ScheduleRefreshReport, ScheduleTriggerReport,
    ScheduleVerification,
};
use shipctl_core::state::archive::inspect_archive;
use shipctl_core::state::archive::StateArchiveInspection;
use uuid::Uuid;

use crate::APP_VERSION;

pub struct StartRequest {
    pub name: String,
    pub state_root: Option<PathBuf>,
    pub runtime_root: Option<PathBuf>,
    pub load_state: Option<PathBuf>,
}

pub enum StartDisposition {
    Started(InstanceRecord),
    AlreadyReady(InstanceRecord),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub count: usize,
    pub instances: Vec<InstanceRecord>,
    pub problems: Vec<DiscoveryProblem>,
}

/// The schedule list adds an explicit total while preserving the authoritative
/// accepted-snapshot inspection projection.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleListResult {
    pub count: usize,
    #[serde(flatten)]
    pub inspection: ScheduleInspection,
}

/// Independent outcomes from an explicitly non-transactional all-instance
/// refresh. Each result remains attributable to the exact live incarnation
/// discovered before its endpoint request.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRefreshAllResult {
    pub count: usize,
    pub applied_count: usize,
    pub rejected_count: usize,
    pub error_count: usize,
    pub problem_count: usize,
    pub results: Vec<ScheduleRefreshInstanceResult>,
    pub problems: Vec<DiscoveryProblem>,
}

impl ScheduleRefreshAllResult {
    pub fn all_applied(&self) -> bool {
        self.rejected_count == 0 && self.error_count == 0 && self.problem_count == 0
    }

    pub fn is_no_op(&self) -> bool {
        self.count == 0 && self.problem_count == 0
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRefreshInstanceResult {
    pub instance: String,
    pub incarnation: String,
    pub request_id: Uuid,
    #[serde(flatten)]
    pub outcome: ScheduleRefreshInstanceOutcome,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum ScheduleRefreshInstanceOutcome {
    Applied { report: ScheduleRefreshReport },
    Rejected { report: ScheduleRefreshReport },
    Error { error: ControlError },
}

enum Wake {
    Filesystem,
    ChildExited(ExitStatus),
    WatchFailed(String),
}

pub fn start(ui_path: &Path, request: StartRequest) -> Result<StartDisposition, ControlError> {
    let (state_root, _) = resolve_state_root(request.state_root.as_deref())
        .map_err(|error| operational_error("control.instance.invalid_state_root", error))?;
    let (runtime_root, _) = resolve_runtime_root(request.runtime_root.as_deref())
        .map_err(|error| operational_error("control.instance.invalid_runtime_root", error))?;
    let directory = directory(runtime_root.clone());

    if let Some(disposition) = existing_disposition(&directory, &request.name, &state_root)? {
        return Ok(disposition);
    }
    reject_live_state_root_owner(&directory, &request.name, &state_root)?;
    if let Some(archive) = request.load_state.as_deref() {
        inspect_archive(archive)?;
        reject_nonempty_restore_target(&state_root)?;
    }

    let descriptor_directory = runtime_root.join("instances");
    create_private_directory(&descriptor_directory).map_err(|error| {
        operational_error(
            "control.instance.discovery_setup_failed",
            format!("Could not prepare instance discovery: {error}"),
        )
    })?;
    let (watcher, events, sender) = watch(&descriptor_directory)?;
    let _watcher = watcher;

    if let Some(disposition) = existing_disposition(&directory, &request.name, &state_root)? {
        return Ok(disposition);
    }
    reject_live_state_root_owner(&directory, &request.name, &state_root)?;

    let mut command = Command::new(ui_path);
    command
        .arg("--name")
        .arg(&request.name)
        .arg("--state-root")
        .arg(&state_root)
        .arg("--runtime-root")
        .arg(&runtime_root)
        .arg("--launched-by-cli")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(load_state) = &request.load_state {
        command.arg("--load-state").arg(load_state);
    }
    configure_detached(&mut command);
    let mut child = command.spawn().map_err(|error| {
        operational_error(
            "control.instance.launch_failed",
            format!("Could not launch {}: {error}", ui_path.display()),
        )
    })?;
    std::thread::spawn(move || {
        if let Ok(status) = child.wait() {
            let _ = sender.send(Wake::ChildExited(status));
        }
    });

    loop {
        if let Some(disposition) = existing_disposition(&directory, &request.name, &state_root)? {
            return Ok(match disposition {
                StartDisposition::AlreadyReady(record) => StartDisposition::Started(record),
                StartDisposition::Started(record) => StartDisposition::Started(record),
            });
        }
        match events.recv().map_err(|error| {
            operational_error(
                "control.instance.discovery_failed",
                format!("The readiness event channel closed: {error}"),
            )
        })? {
            Wake::Filesystem => {}
            Wake::ChildExited(status) => {
                if let Some(disposition) =
                    existing_disposition(&directory, &request.name, &state_root)?
                {
                    return Ok(disposition);
                }
                return Err(operational_error(
                    "control.instance.launch_failed",
                    format!("The UI process exited before publishing readiness: {status}"),
                ));
            }
            Wake::WatchFailed(error) => {
                return Err(operational_error(
                    "control.instance.discovery_failed",
                    format!("Could not observe instance readiness: {error}"),
                ));
            }
        }
    }
}

fn reject_live_state_root_owner(
    directory: &InstanceDirectory,
    requested_name: &str,
    requested_state_root: &Path,
) -> Result<(), ControlError> {
    if let Some(owner) = directory.discover().instances.into_iter().find(|instance| {
        instance.state_root == requested_state_root && instance.name != requested_name
    }) {
        return Err(ControlError::new(
            "control.instance.state_root_in_use",
            "The requested writable state root belongs to another live instance",
        )
        .with_selector(requested_name)
        .for_context(owner.instance_id, owner.state_root)
        .with_expected_observed("available exclusive state root", owner.name));
    }
    Ok(())
}

fn reject_nonempty_restore_target(state_root: &Path) -> Result<(), ControlError> {
    if !state_root.exists() {
        return Ok(());
    }
    let mut entries = std::fs::read_dir(state_root).map_err(|error| {
        operational_error(
            "state.restore.provider_failed",
            format!("Could not inspect restore target: {error}"),
        )
    })?;
    if entries
        .next()
        .transpose()
        .map_err(|error| {
            operational_error(
                "state.restore.provider_failed",
                format!("Could not inspect restore target: {error}"),
            )
        })?
        .is_some()
    {
        return Err(ControlError::new(
            "state.restore.target_not_empty",
            format!("Restore target is not empty: {}", state_root.display()),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn configure_detached(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(windows)]
fn configure_detached(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
}

pub fn list(runtime_root: Option<&Path>) -> Result<ListResult, ControlError> {
    let (runtime_root, _) = resolve_runtime_root(runtime_root)
        .map_err(|error| operational_error("control.instance.invalid_runtime_root", error))?;
    let mut report = directory(runtime_root).discover();
    report.instances.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.instance_id.cmp(&right.instance_id))
    });
    Ok(ListResult {
        count: report.instances.len(),
        instances: report.instances,
        problems: report.problems,
    })
}

pub fn inspect(
    runtime_root: Option<&Path>,
    selector: Option<&str>,
) -> Result<InstanceRecord, ControlError> {
    let (runtime_root, _) = resolve_runtime_root(runtime_root)
        .map_err(|error| operational_error("control.instance.invalid_runtime_root", error))?;
    directory(runtime_root).inspect(effective_selector(selector).as_deref())
}

pub fn diagnose(
    runtime_root: Option<&Path>,
    selector: Option<&str>,
) -> Result<InstanceDiagnosticReport, ControlError> {
    let (runtime_root, _) = resolve_runtime_root(runtime_root)
        .map_err(|error| operational_error("control.instance.invalid_runtime_root", error))?;
    directory(runtime_root).diagnose(effective_selector(selector).as_deref())
}

pub fn stop(
    runtime_root: Option<&Path>,
    selector: Option<&str>,
    force: bool,
) -> Result<StopOutcome, ControlError> {
    let (runtime_root, _) = resolve_runtime_root(runtime_root)
        .map_err(|error| operational_error("control.instance.invalid_runtime_root", error))?;
    let descriptor_directory = runtime_root.join("instances");
    create_private_directory(&descriptor_directory).map_err(|error| {
        operational_error(
            "control.instance.discovery_setup_failed",
            format!("Could not prepare instance discovery: {error}"),
        )
    })?;
    let (watcher, events, _) = watch(&descriptor_directory)?;
    let _watcher = watcher;
    let directory = directory(runtime_root);
    let selector = effective_selector(selector);
    let outcome = directory.stop(selector.as_deref(), force)?;
    let stopped_id = outcome.instance.instance_id;

    while directory
        .discover()
        .instances
        .iter()
        .any(|instance| instance.instance_id == stopped_id)
    {
        match events.recv().map_err(|error| {
            operational_error(
                "control.instance.discovery_failed",
                format!("The shutdown event channel closed: {error}"),
            )
        })? {
            Wake::Filesystem => {}
            Wake::WatchFailed(error) => {
                return Err(operational_error(
                    "control.instance.discovery_failed",
                    format!("Could not observe instance shutdown: {error}"),
                ));
            }
            Wake::ChildExited(_) => {}
        }
    }
    Ok(outcome)
}

pub fn save(
    runtime_root: Option<&Path>,
    selector: Option<&str>,
    destination: &Path,
) -> Result<StateArchiveInspection, ControlError> {
    let (runtime_root, _) = resolve_runtime_root(runtime_root)
        .map_err(|error| operational_error("control.instance.invalid_runtime_root", error))?;
    directory(runtime_root).save_state(
        effective_selector(selector).as_deref(),
        destination.to_path_buf(),
    )
}

pub fn inspect_module(
    runtime_root: Option<&Path>,
    selector: Option<&str>,
    module_id: String,
) -> Result<ModuleInspection, ControlError> {
    let (runtime_root, _) = resolve_runtime_root(runtime_root)
        .map_err(|error| operational_error("control.instance.invalid_runtime_root", error))?;
    directory(runtime_root).inspect_module(effective_selector(selector).as_deref(), module_id)
}

pub fn diagnose_module(
    runtime_root: Option<&Path>,
    selector: Option<&str>,
    module_id: String,
) -> Result<Vec<Diagnostic>, ControlError> {
    let (runtime_root, _) = resolve_runtime_root(runtime_root)
        .map_err(|error| operational_error("control.instance.invalid_runtime_root", error))?;
    directory(runtime_root).diagnose_module(effective_selector(selector).as_deref(), module_id)
}

pub fn inspect_messages(
    runtime_root: Option<&Path>,
    selector: &str,
) -> Result<MessageRuntimeInspection, ControlError> {
    let (runtime_root, _) = resolve_runtime_root(runtime_root)
        .map_err(|error| operational_error("control.instance.invalid_runtime_root", error))?;
    directory(runtime_root)
        .inspect_messages(Some(selector))
        .map_err(|error| message_runtime_error(error, selector))
}

pub fn diagnose_messages(
    runtime_root: Option<&Path>,
    selector: &str,
) -> Result<MessageDiagnosticReport, ControlError> {
    let (runtime_root, _) = resolve_runtime_root(runtime_root)
        .map_err(|error| operational_error("control.instance.invalid_runtime_root", error))?;
    directory(runtime_root)
        .diagnose_messages(Some(selector))
        .map_err(|error| message_runtime_error(error, selector))
}

fn message_runtime_error(error: ControlError, selector: &str) -> ControlError {
    if error.code.as_str() == "control.instance.absent" {
        ControlError::new(
            RUNTIME_UNAVAILABLE,
            "The selected instance is not running; runtime message routes are unavailable",
        )
        .with_selector(selector)
    } else {
        error
    }
}

pub fn transition_module(
    runtime_root: Option<&Path>,
    selector: Option<&str>,
    module_id: String,
    kind: ModuleOperationKind,
    target_registry_revision: u64,
) -> Result<ModuleOperation, ControlError> {
    let (runtime_root, _) = resolve_runtime_root(runtime_root)
        .map_err(|error| operational_error("control.instance.invalid_runtime_root", error))?;
    directory(runtime_root).transition_module(
        effective_selector(selector).as_deref(),
        module_id,
        kind,
        target_registry_revision,
    )
}

pub fn inspect_operation(
    runtime_root: Option<&Path>,
    selector: Option<&str>,
    operation_id: uuid::Uuid,
) -> Result<ModuleOperation, ControlError> {
    let (runtime_root, _) = resolve_runtime_root(runtime_root)
        .map_err(|error| operational_error("control.instance.invalid_runtime_root", error))?;
    directory(runtime_root).inspect_operation(effective_selector(selector).as_deref(), operation_id)
}

/// Reads the accepted schedule snapshot from one explicitly selected instance.
/// Unlike legacy instance commands, schedules intentionally never fall back to
/// `SHIPCTL_INSTANCE_ID`: callers must name their target at the CLI boundary.
pub fn list_schedules(
    runtime_root: Option<&Path>,
    selector: &str,
) -> Result<ScheduleListResult, ControlError> {
    let (runtime_root, _) = resolve_runtime_root(runtime_root)
        .map_err(|error| operational_error("control.instance.invalid_runtime_root", error))?;
    let inspection = directory(runtime_root).list_schedules(selector)?;
    Ok(ScheduleListResult {
        count: inspection.schedules.len(),
        inspection,
    })
}

/// Reads one accepted schedule from one explicitly selected running instance.
pub fn inspect_schedule(
    runtime_root: Option<&Path>,
    selector: &str,
    schedule_id: String,
) -> Result<ScheduleInspection, ControlError> {
    let (runtime_root, _) = resolve_runtime_root(runtime_root)
        .map_err(|error| operational_error("control.instance.invalid_runtime_root", error))?;
    directory(runtime_root).inspect_schedule(selector, schedule_id)
}

/// Produces a read-only current-source comparison for an explicit instance.
pub fn diagnose_schedules(
    runtime_root: Option<&Path>,
    selector: &str,
) -> Result<ScheduleDiagnosticReport, ControlError> {
    let (runtime_root, _) = resolve_runtime_root(runtime_root)
        .map_err(|error| operational_error("control.instance.invalid_runtime_root", error))?;
    directory(runtime_root).diagnose_schedules(selector)
}

/// Verifies current sources against accepted state without publishing a refresh.
pub fn verify_schedules(
    runtime_root: Option<&Path>,
    selector: &str,
) -> Result<ScheduleVerification, ControlError> {
    let (runtime_root, _) = resolve_runtime_root(runtime_root)
        .map_err(|error| operational_error("control.instance.invalid_runtime_root", error))?;
    directory(runtime_root).verify_schedules(selector)
}

/// Refreshes one explicitly selected instance with a caller-controlled request
/// identity for retry-safe endpoint transport.
pub fn refresh_schedules(
    runtime_root: Option<&Path>,
    selector: &str,
    request_id: Uuid,
) -> Result<ScheduleRefreshReport, ControlError> {
    let (runtime_root, _) = resolve_runtime_root(runtime_root)
        .map_err(|error| operational_error("control.instance.invalid_runtime_root", error))?;
    directory(runtime_root).refresh_schedules_with_request_id(selector, request_id)
}

/// Refreshes only the live instances discovered in this runtime root. The
/// caller-supplied request identity is deliberately reused per endpoint:
/// scheduler replay state is scoped to each instance incarnation, so repeating
/// the same fan-out remains idempotent per target without claiming a global
/// transaction. Without a supplied identity, each target receives a new one.
pub fn refresh_all_schedules(
    runtime_root: Option<&Path>,
    request_id: Option<Uuid>,
) -> Result<ScheduleRefreshAllResult, ControlError> {
    let (runtime_root, _) = resolve_runtime_root(runtime_root)
        .map_err(|error| operational_error("control.instance.invalid_runtime_root", error))?;
    let directory = directory(runtime_root);
    let discovery = directory.discover();
    let mut results = Vec::with_capacity(discovery.instances.len());
    let mut applied_count = 0;
    let mut rejected_count = 0;
    let mut error_count = 0;

    for instance in discovery.instances {
        let instance_name = instance.name;
        let incarnation = instance.instance_id.to_string();
        let selector = incarnation.clone();
        let target_request_id = request_id.unwrap_or_else(Uuid::new_v4);
        let outcome =
            match directory.refresh_schedules_with_request_id(&selector, target_request_id) {
                Ok(report) if report.applied => {
                    applied_count += 1;
                    ScheduleRefreshInstanceOutcome::Applied { report }
                }
                Ok(report) => {
                    rejected_count += 1;
                    ScheduleRefreshInstanceOutcome::Rejected { report }
                }
                Err(error) => {
                    error_count += 1;
                    ScheduleRefreshInstanceOutcome::Error { error }
                }
            };
        results.push(ScheduleRefreshInstanceResult {
            instance: instance_name,
            incarnation,
            request_id: target_request_id,
            outcome,
        });
    }

    let count = results.len();
    let problem_count = discovery.problems.len();
    Ok(ScheduleRefreshAllResult {
        count,
        applied_count,
        rejected_count,
        error_count,
        problem_count,
        results,
        problems: discovery.problems,
    })
}

/// Delivers one accepted schedule through the current target using the shared
/// scheduler path and a caller-controlled retry identity.
pub fn trigger_schedule(
    runtime_root: Option<&Path>,
    selector: &str,
    schedule_id: String,
    request_id: Uuid,
) -> Result<ScheduleTriggerReport, ControlError> {
    let (runtime_root, _) = resolve_runtime_root(runtime_root)
        .map_err(|error| operational_error("control.instance.invalid_runtime_root", error))?;
    directory(runtime_root).trigger_schedule_with_request_id(selector, schedule_id, request_id)
}

fn existing_disposition(
    directory: &InstanceDirectory,
    name: &str,
    requested_state_root: &Path,
) -> Result<Option<StartDisposition>, ControlError> {
    match directory.inspect(Some(name)) {
        Ok(instance) if instance.state_root == requested_state_root => {
            Ok(Some(StartDisposition::AlreadyReady(instance)))
        }
        Ok(instance) => Err(ControlError::new(
            "control.instance.name_in_use",
            "The requested name belongs to a live instance with a different state root",
        )
        .with_selector(name)
        .for_context(instance.instance_id, instance.state_root.clone())
        .with_expected_observed(
            requested_state_root.display().to_string(),
            instance.state_root.display().to_string(),
        )),
        Err(error) if error.code.as_str() == "control.instance.absent" => Ok(None),
        Err(error) => Err(error),
    }
}

fn watch(path: &Path) -> Result<(RecommendedWatcher, Receiver<Wake>, Sender<Wake>), ControlError> {
    let (sender, receiver) = mpsc::channel();
    let event_sender = sender.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let wake = match event {
            Ok(_) => Wake::Filesystem,
            Err(error) => Wake::WatchFailed(error.to_string()),
        };
        let _ = event_sender.send(wake);
    })
    .map_err(|error| {
        operational_error(
            "control.instance.discovery_setup_failed",
            format!("Could not initialize the readiness watcher: {error}"),
        )
    })?;
    watcher
        .watch(path, RecursiveMode::NonRecursive)
        .map_err(|error| {
            operational_error(
                "control.instance.discovery_setup_failed",
                format!("Could not watch {}: {error}", path.display()),
            )
        })?;
    Ok((watcher, receiver, sender))
}

fn directory(runtime_root: PathBuf) -> InstanceDirectory {
    InstanceDirectory::new(
        runtime_root,
        InstanceBuildIdentity {
            app_version: APP_VERSION.to_string(),
            control_protocol_version: CONTROL_PROTOCOL_VERSION,
        },
    )
}

fn effective_selector(selector: Option<&str>) -> Option<String> {
    selector.map(str::to_string).or_else(|| {
        std::env::var("SHIPCTL_INSTANCE_ID")
            .ok()
            .filter(|value| !value.trim().is_empty())
    })
}

fn create_private_directory(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn operational_error(code: &str, message: impl Into<String>) -> ControlError {
    ControlError::new(code, message)
}
