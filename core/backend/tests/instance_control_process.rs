use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use shipctl_core::build_info::CONTROL_PROTOCOL_VERSION;
use shipctl_core::instance::{
    ActiveWorkBlocker, ControlError, ControlHandler, ControlServer, InstanceBuildIdentity,
    InstanceContext, InstanceDirectory, InstanceLaunchOptions, InstanceLeases, LaunchProvenance,
};
use uuid::Uuid;

const FIXTURE_ENV: &str = "SHIPCTL_CONTROL_PROCESS_FIXTURE";
const NAME_ENV: &str = "SHIPCTL_CONTROL_PROCESS_NAME";
const STATE_ROOT_ENV: &str = "SHIPCTL_CONTROL_PROCESS_STATE_ROOT";
const RUNTIME_ROOT_ENV: &str = "SHIPCTL_CONTROL_PROCESS_RUNTIME_ROOT";
const STATUS_PATH_ENV: &str = "SHIPCTL_CONTROL_PROCESS_STATUS_PATH";
const BLOCKED_ENV: &str = "SHIPCTL_CONTROL_PROCESS_BLOCKED";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FixtureStatus {
    instance_id: Option<Uuid>,
    error: Option<ControlError>,
}

struct FixtureHandler {
    blocked: bool,
    stopped: Arc<AtomicBool>,
}

impl ControlHandler for FixtureHandler {
    fn active_work(&self) -> Vec<ActiveWorkBlocker> {
        if self.blocked {
            vec![ActiveWorkBlocker {
                kind: "fixture_work".to_string(),
                count: 1,
                message: "The fixture represents active instance work".to_string(),
            }]
        } else {
            Vec::new()
        }
    }

    fn shutdown(&self, _force: bool) -> Result<(), ControlError> {
        self.stopped.store(true, Ordering::SeqCst);
        Ok(())
    }
}

#[test]
#[ignore]
fn control_process_fixture() {
    if std::env::var_os(FIXTURE_ENV).is_none() {
        return;
    }

    let status_path = required_path(STATUS_PATH_ENV);
    let context = InstanceContext::resolve(
        InstanceLaunchOptions {
            name: Some(required_string(NAME_ENV)),
            state_root: Some(required_path(STATE_ROOT_ENV)),
            runtime_root: Some(required_path(RUNTIME_ROOT_ENV)),
            load_state: None,
            provenance: Some(LaunchProvenance::Cli),
        },
        "process-test",
    )
    .unwrap();
    let leases = match InstanceLeases::acquire(&context) {
        Ok(leases) => Arc::new(leases),
        Err(error) => {
            write_status(&status_path, None, Some(error));
            return;
        }
    };
    let stopped = Arc::new(AtomicBool::new(false));
    let handler = Arc::new(FixtureHandler {
        blocked: std::env::var_os(BLOCKED_ENV).is_some(),
        stopped: stopped.clone(),
    });
    let server = match ControlServer::start(context.clone(), leases, handler) {
        Ok(server) => server,
        Err(error) => {
            write_status(&status_path, None, Some(error));
            return;
        }
    };

    write_status(&status_path, Some(context.instance_id), None);
    while !stopped.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(server);
}

#[test]
fn separate_process_leases_discovery_and_stop_are_deterministic() {
    let root = test_root("lifecycle");
    let runtime_root = root.join("runtime");
    let state_a = root.join("state-a");
    let state_b = root.join("state-b");

    let mut owner = start_fixture("alpha", &state_a, &runtime_root, true);
    let owner_status = wait_for_status(&mut owner);
    assert!(owner_status.error.is_none());

    let mut duplicate_name = start_fixture("alpha", &state_b, &runtime_root, false);
    let duplicate_name_status = wait_for_status(&mut duplicate_name);
    assert_eq!(
        duplicate_name_status.error.unwrap().code.as_str(),
        "control.instance.name_in_use"
    );
    assert!(duplicate_name.child.wait().unwrap().success());

    let mut duplicate_root = start_fixture("beta", &state_a, &runtime_root, false);
    let duplicate_root_status = wait_for_status(&mut duplicate_root);
    assert_eq!(
        duplicate_root_status.error.unwrap().code.as_str(),
        "control.instance.state_root_in_use"
    );
    assert!(duplicate_root.child.wait().unwrap().success());

    let directory = directory(runtime_root.clone());
    let report = directory.discover();
    assert_eq!(report.instances.len(), 1);
    assert_eq!(report.instances[0].name, "alpha");
    assert_eq!(report.instances[0].active_work[0].kind, "fixture_work");

    let blocked = directory.stop(Some("alpha"), false).unwrap_err();
    assert_eq!(blocked.code.as_str(), "control.instance.shutdown_blocked");
    assert_eq!(blocked.blockers[0].kind, "fixture_work");

    assert!(directory.stop(Some("alpha"), true).unwrap().accepted);
    let repeated_stop = directory.stop(Some("alpha"), true).unwrap_err();
    assert_eq!(repeated_stop.code.as_str(), "control.instance.absent");
    assert!(owner.child.wait().unwrap().success());
    assert!(directory.discover().instances.is_empty());

    let mut recovered = start_fixture("alpha", &state_a, &runtime_root, false);
    assert!(wait_for_status(&mut recovered).error.is_none());
    assert!(directory.stop(Some("alpha"), false).unwrap().accepted);
    assert!(recovered.child.wait().unwrap().success());

    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn dead_process_descriptor_is_reclaimed_after_failed_handshake() {
    let root = test_root("stale");
    let runtime_root = root.join("runtime");
    let mut fixture = start_fixture("stale", &root.join("state"), &runtime_root, false);
    assert!(wait_for_status(&mut fixture).error.is_none());

    fixture.child.kill().unwrap();
    fixture.child.wait().unwrap();

    let report = directory(runtime_root).discover();
    assert!(report.instances.is_empty());
    assert_eq!(report.problems.len(), 1);
    assert!(report.problems[0].reclaimed);
    assert!(!report.problems[0].descriptor_path.exists());

    std::fs::remove_dir_all(root).unwrap();
}

struct FixtureProcess {
    child: Child,
    status_path: PathBuf,
}

fn start_fixture(
    name: &str,
    state_root: &Path,
    runtime_root: &Path,
    blocked: bool,
) -> FixtureProcess {
    let status_path = runtime_root
        .parent()
        .unwrap()
        .join(format!("status-{}.json", Uuid::new_v4()));
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .arg("--ignored")
        .arg("--exact")
        .arg("control_process_fixture")
        .env(FIXTURE_ENV, "1")
        .env(NAME_ENV, name)
        .env(STATE_ROOT_ENV, state_root)
        .env(RUNTIME_ROOT_ENV, runtime_root)
        .env(STATUS_PATH_ENV, &status_path)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    if blocked {
        command.env(BLOCKED_ENV, "1");
    }
    FixtureProcess {
        child: command.spawn().unwrap(),
        status_path,
    }
}

fn wait_for_status(fixture: &mut FixtureProcess) -> FixtureStatus {
    loop {
        match std::fs::read_to_string(&fixture.status_path) {
            Ok(value) => return serde_json::from_str(&value).unwrap(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("could not read fixture status: {error}"),
        }
        if let Some(status) = fixture.child.try_wait().unwrap() {
            panic!("control fixture exited before publishing status: {status}");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn write_status(path: &Path, instance_id: Option<Uuid>, error: Option<ControlError>) {
    std::fs::write(
        path,
        serde_json::to_vec(&FixtureStatus { instance_id, error }).unwrap(),
    )
    .unwrap();
}

fn required_string(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("missing {name}"))
}

fn required_path(name: &str) -> PathBuf {
    PathBuf::from(required_string(name))
}

fn directory(runtime_root: PathBuf) -> InstanceDirectory {
    InstanceDirectory::new(
        runtime_root,
        InstanceBuildIdentity {
            app_version: "process-test".to_string(),
            control_protocol_version: CONTROL_PROTOCOL_VERSION,
        },
    )
}

fn test_root(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "shipctl-instance-process-{label}-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    root
}
