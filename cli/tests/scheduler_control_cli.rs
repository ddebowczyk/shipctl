use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use shipctl_core::instance::{
    ActiveWorkBlocker, ControlError, ControlHandler, ControlResponseResult, ControlServer,
    ControlStream, InstanceContext, InstanceLaunchOptions, InstanceLeases, LaunchProvenance,
    ScheduleCommand,
};
use shipctl_core::message_bus::contracts::JSON_SCHEMA_DRAFT_2020_12;
use shipctl_core::message_bus::{
    DirectedChannelDeclaration, MessageContractError, MessageDeclarations, MessageSchemaDescriptor,
    MessageTypeContract, MessageTypeId, PreparedRegistration, RegistrationHandlers,
    RouteEndpointRef, RuntimeMessageBus, MESSAGE_CONTRACT_SCHEMA_VERSION,
};
use shipctl_core::module_control::ModuleGrant;
use shipctl_core::scheduler::{SchedulerControlError, SchedulerService};
use uuid::Uuid;

const FIXTURE_ENV: &str = "SHIPCTL_SCHEDULER_CONTROL_PROCESS_FIXTURE";
const NAME_ENV: &str = "SHIPCTL_SCHEDULER_CONTROL_PROCESS_NAME";
const STATE_ROOT_ENV: &str = "SHIPCTL_SCHEDULER_CONTROL_PROCESS_STATE_ROOT";
const RUNTIME_ROOT_ENV: &str = "SHIPCTL_SCHEDULER_CONTROL_PROCESS_RUNTIME_ROOT";
const STATUS_PATH_ENV: &str = "SHIPCTL_SCHEDULER_CONTROL_PROCESS_STATUS_PATH";
const DELIVERY_PATH_ENV: &str = "SHIPCTL_SCHEDULER_CONTROL_PROCESS_DELIVERY_PATH";
const SOURCE_ENV: &str = "SHIPCTL_SCHEDULER_CONTROL_PROCESS_SOURCE";

const ALPHA: &str = "scheduler-alpha";
const BETA: &str = "scheduler-beta";
const STOPPED: &str = "scheduler-stopped";
const SCHEDULE_ID: &str = "scheduler.fixture";
const CHANNEL: &str = "scheduler.fixture";
const MESSAGE_TYPE: &str = "fixture.scheduler-control";
const SECRET: &str = "fixture-secret-value";
const INVALID_SECRET: &str = "fixture-invalid-private-value";

#[derive(Clone, Copy)]
enum FixtureSource {
    Valid,
    Invalid,
}

impl FixtureSource {
    fn as_env(self) -> &'static str {
        match self {
            Self::Valid => "valid",
            Self::Invalid => "invalid",
        }
    }

    fn from_env(value: &str) -> Self {
        match value {
            "valid" => Self::Valid,
            "invalid" => Self::Invalid,
            _ => panic!("unsupported scheduler fixture source {value:?}"),
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FixtureStatus {
    instance_id: Option<Uuid>,
    error: Option<ControlError>,
}

struct SchedulerFixtureHandler {
    runtime: Arc<tokio::runtime::Runtime>,
    scheduler: SchedulerService,
    stopped: Arc<AtomicBool>,
}

impl ControlHandler for SchedulerFixtureHandler {
    fn active_work(&self) -> Vec<ActiveWorkBlocker> {
        Vec::new()
    }

    fn schedule_control(
        &self,
        command: ScheduleCommand,
        request_id: Uuid,
    ) -> Result<ControlStream, ControlError> {
        let scheduler = self.scheduler.clone();
        match command {
            ScheduleCommand::List {} => Ok(ControlStream::result(
                ControlResponseResult::ScheduleInspection(scheduler.inspect()),
            )),
            ScheduleCommand::Inspect { schedule_id } => scheduler
                .inspect_schedule(&schedule_id)
                .map(ControlResponseResult::ScheduleInspection)
                .map(ControlStream::result)
                .map_err(scheduler_control_error),
            ScheduleCommand::Diagnose {} => Ok(ControlStream::result(
                ControlResponseResult::ScheduleDiagnostics(scheduler.diagnose()),
            )),
            ScheduleCommand::Verify {} => Ok(ControlStream::result(
                ControlResponseResult::ScheduleVerification(scheduler.verify()),
            )),
            ScheduleCommand::Refresh {} => self
                .runtime
                .block_on(async move { scheduler.refresh_with_request_id(request_id).await })
                .map(ControlResponseResult::ScheduleRefresh)
                .map(ControlStream::result)
                .map_err(scheduler_control_error),
            ScheduleCommand::Trigger { schedule_id } => self
                .runtime
                .block_on(async move {
                    scheduler
                        .trigger_with_request_id(&schedule_id, request_id)
                        .await
                })
                .map(ControlResponseResult::ScheduleTrigger)
                .map(ControlStream::result)
                .map_err(scheduler_control_error),
        }
    }

    fn shutdown(&self, _force: bool) -> Result<(), ControlError> {
        self.scheduler.shutdown();
        self.stopped.store(true, Ordering::SeqCst);
        Ok(())
    }
}

fn scheduler_control_error(error: SchedulerControlError) -> ControlError {
    let code = error.code().to_string();
    let message = error.diagnostic().map_or_else(
        || "Scheduler request identity conflicts with an existing mutation".to_string(),
        |diagnostic| format!("Scheduler control rejected: {}", diagnostic.code),
    );
    ControlError::new(code, message)
}

/// This ignored test is an executable fixture for the public-boundary test
/// below. It owns a real control server, message runtime, and scheduler in a
/// separately spawned process; the proof only talks to it via the built CLI.
#[test]
#[ignore]
fn scheduler_control_process_fixture() {
    if std::env::var_os(FIXTURE_ENV).is_none() {
        return;
    }

    let status_path = required_path(STATUS_PATH_ENV);
    let context = match InstanceContext::resolve(
        InstanceLaunchOptions {
            name: Some(required_string(NAME_ENV)),
            state_root: Some(required_path(STATE_ROOT_ENV)),
            runtime_root: Some(required_path(RUNTIME_ROOT_ENV)),
            load_state: None,
            provenance: Some(LaunchProvenance::Cli),
        },
        "scheduler-control-cli-fixture",
    ) {
        Ok(context) => context,
        Err(error) => {
            write_status(
                &status_path,
                None,
                Some(ControlError::new("scheduler.fixture.setup_failed", error)),
            );
            return;
        }
    };
    let source = FixtureSource::from_env(&required_string(SOURCE_ENV));
    if let Err(error) = write_fixture_source(&context.paths().schedule_root, source) {
        write_status(
            &status_path,
            None,
            Some(ControlError::new(
                "scheduler.fixture.setup_failed",
                error.to_string(),
            )),
        );
        return;
    }
    let delivery_path = required_path(DELIVERY_PATH_ENV);
    if let Err(error) = fs::write(&delivery_path, "0") {
        write_status(
            &status_path,
            None,
            Some(ControlError::new(
                "scheduler.fixture.setup_failed",
                error.to_string(),
            )),
        );
        return;
    }

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_time()
        .build()
    {
        Ok(runtime) => Arc::new(runtime),
        Err(error) => {
            write_status(
                &status_path,
                None,
                Some(ControlError::new(
                    "scheduler.fixture.setup_failed",
                    error.to_string(),
                )),
            );
            return;
        }
    };
    let bus = RuntimeMessageBus::new(context.clone());
    if let Err(error) = runtime.block_on(register_fixture_channel(
        &context,
        &bus,
        delivery_path.clone(),
    )) {
        write_status(
            &status_path,
            None,
            Some(ControlError::new(
                "scheduler.fixture.setup_failed",
                error.to_string(),
            )),
        );
        return;
    }
    let scheduler = match SchedulerService::new(context.clone(), context.paths().schedule_root, bus)
    {
        Ok(scheduler) => scheduler,
        Err(error) => {
            write_status(
                &status_path,
                None,
                Some(ControlError::new(
                    "scheduler.fixture.setup_failed",
                    error.to_string(),
                )),
            );
            return;
        }
    };
    let leases = match InstanceLeases::acquire(&context) {
        Ok(leases) => Arc::new(leases),
        Err(error) => {
            write_status(&status_path, None, Some(error));
            return;
        }
    };
    let stopped = Arc::new(AtomicBool::new(false));
    let handler = Arc::new(SchedulerFixtureHandler {
        runtime,
        scheduler,
        stopped: Arc::clone(&stopped),
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
fn built_cli_proves_named_scheduler_control_and_independent_fanout() {
    let root = test_root();
    let runtime_root = root.join("runtime");
    let mut alpha = start_fixture(&root, &runtime_root, ALPHA, FixtureSource::Invalid);
    let alpha_status = wait_for_status(&mut alpha);
    assert_fixture_ready(&alpha_status, ALPHA);

    // Scheduler commands reject a legacy environment selector before the
    // process can be contacted, proving the public CLI requires a name.
    let missing_selector = Command::new(env!("CARGO_BIN_EXE_shipctl"))
        .args(["schedule", "list", "--runtime-root"])
        .arg(&runtime_root)
        .args(["--output", "json"])
        .env(
            "SHIPCTL_INSTANCE_ID",
            alpha_status.instance_id.unwrap().to_string(),
        )
        .output()
        .unwrap();
    assert_eq!(missing_selector.status.code(), Some(2));
    let missing_selector_error = parse_stderr(&missing_selector);
    assert_eq!(missing_selector_error["operation"], "schedule.list");
    assert_eq!(missing_selector_error["code"], "cli.usage");

    let initial_list = schedule(&runtime_root, &["list", "--instance", ALPHA]);
    let initial_list = expect_stdout_json(&initial_list, true);
    assert_eq!(initial_list["operation"], "schedule.list");
    assert_eq!(initial_list["code"], "scheduler.control.listed");
    assert_eq!(initial_list["data"]["instanceId"], ALPHA);
    assert_eq!(
        initial_list["data"]["incarnation"],
        alpha_status.instance_id.unwrap().to_string()
    );
    assert_eq!(initial_list["data"]["count"], 0);
    assert_eq!(initial_list["data"]["scheduleGeneration"], 0);

    // Verify parses current candidate state but never publishes it. The
    // invalid source is still rejected, and accepted generation zero remains.
    let invalid_verify = schedule(&runtime_root, &["verify", "--instance", ALPHA]);
    let invalid_verify = expect_stdout_json(&invalid_verify, false);
    assert_eq!(invalid_verify["operation"], "schedule.verify");
    assert_eq!(invalid_verify["code"], "scheduler.control.verified");
    assert_eq!(invalid_verify["data"]["matchesAccepted"], false);
    assert_eq!(invalid_verify["data"]["accepted"]["scheduleGeneration"], 0);

    let list_after_verify = schedule(&runtime_root, &["list", "--instance", ALPHA]);
    let list_after_verify = expect_stdout_json(&list_after_verify, true);
    assert_eq!(list_after_verify["data"], initial_list["data"]);

    let rejected_id = Uuid::new_v4().to_string();
    let rejected_refresh = schedule(
        &runtime_root,
        &["refresh", "--instance", ALPHA, "--request-id", &rejected_id],
    );
    let rejected_refresh = expect_stdout_json(&rejected_refresh, false);
    assert_eq!(rejected_refresh["operation"], "schedule.refresh");
    assert_eq!(
        rejected_refresh["code"],
        "scheduler.control.refresh_rejected"
    );
    assert_eq!(rejected_refresh["data"]["applied"], false);
    assert_eq!(
        rejected_refresh["data"]["inspection"]["scheduleGeneration"],
        0
    );
    assert_eq!(
        rejected_refresh["data"]["inspection"]["schedules"],
        json!([])
    );
    let rejected_diagnostics = rejected_refresh["data"]["diagnostics"].as_array().unwrap();
    assert_eq!(rejected_diagnostics.len(), 1);
    assert_eq!(
        rejected_diagnostics[0]["code"],
        "scheduler.source.unknown_field"
    );
    assert_eq!(rejected_diagnostics[0]["sourcePath"], "fixture.yaml");

    write_fixture_source(&alpha.schedule_root(), FixtureSource::Valid).unwrap();
    let refresh_id = Uuid::new_v4().to_string();
    let refreshed = schedule(
        &runtime_root,
        &["refresh", "--instance", ALPHA, "--request-id", &refresh_id],
    );
    let refreshed = expect_stdout_json(&refreshed, true);
    assert_eq!(refreshed["code"], "scheduler.control.refreshed");
    assert_eq!(refreshed["data"]["applied"], true);
    assert_eq!(refreshed["data"]["inspection"]["scheduleGeneration"], 1);

    let refresh_retry = schedule(
        &runtime_root,
        &["refresh", "--instance", ALPHA, "--request-id", &refresh_id],
    );
    let refresh_retry = expect_stdout_json(&refresh_retry, true);
    assert_eq!(refresh_retry, refreshed);

    let accepted_list = schedule(&runtime_root, &["list", "--instance", ALPHA]);
    let accepted_list = expect_stdout_json(&accepted_list, true);
    assert_eq!(accepted_list["data"]["count"], 1);
    assert_eq!(accepted_list["data"]["schedules"][0]["id"], SCHEDULE_ID);
    assert!(accepted_list["data"]["snapshotDigestSha256"]
        .as_str()
        .is_some_and(|digest| !digest.is_empty()));
    assert!(accepted_list["data"]["busRouteGeneration"]
        .as_u64()
        .is_some_and(|generation| generation > 0));

    let accepted_list_toon = schedule_default(&runtime_root, &["list", "--instance", ALPHA]);
    let accepted_list_toon = expect_stdout_toon(&accepted_list_toon, true);
    assert_eq!(accepted_list_toon, accepted_list);

    let inspection = schedule(
        &runtime_root,
        &["inspect", SCHEDULE_ID, "--instance", ALPHA],
    );
    let inspection = expect_stdout_json(&inspection, true);
    assert_eq!(inspection["operation"], "schedule.inspect");
    assert_eq!(inspection["data"]["schedules"][0]["id"], SCHEDULE_ID);

    let verified = schedule(&runtime_root, &["verify", "--instance", ALPHA]);
    let verified = expect_stdout_json(&verified, true);
    assert_eq!(verified["data"]["matchesAccepted"], true);
    assert_eq!(verified["data"]["accepted"]["scheduleGeneration"], 1);

    let diagnosed_full = schedule(&runtime_root, &["diagnose", "--instance", ALPHA, "--full"]);
    let diagnosed_full = expect_stdout_json(&diagnosed_full, true);
    assert_eq!(diagnosed_full["operation"], "schedule.diagnose");
    assert_eq!(diagnosed_full["data"]["healthy"], true);

    let trigger_id = Uuid::new_v4().to_string();
    let triggered = schedule(
        &runtime_root,
        &[
            "trigger",
            SCHEDULE_ID,
            "--instance",
            ALPHA,
            "--request-id",
            &trigger_id,
        ],
    );
    let triggered = expect_stdout_json(&triggered, true);
    assert_eq!(triggered["operation"], "schedule.trigger");
    assert_eq!(triggered["code"], "scheduler.control.triggered");
    assert_eq!(triggered["data"]["delivery"]["outcome"], "delivered");

    let trigger_retry = schedule(
        &runtime_root,
        &[
            "trigger",
            SCHEDULE_ID,
            "--instance",
            ALPHA,
            "--request-id",
            &trigger_id,
        ],
    );
    let trigger_retry = expect_stdout_json(&trigger_retry, true);
    assert_eq!(trigger_retry, triggered);
    wait_for_delivery_count(&alpha, 1);

    let mut beta = start_fixture(&root, &runtime_root, BETA, FixtureSource::Invalid);
    let beta_status = wait_for_status(&mut beta);
    assert_fixture_ready(&beta_status, BETA);
    let mut stopped = start_fixture(&root, &runtime_root, STOPPED, FixtureSource::Valid);
    let stopped_status = wait_for_status(&mut stopped);
    assert_fixture_ready(&stopped_status, STOPPED);
    let stopped_source = fs::read(stopped.schedule_path()).unwrap();
    stop_fixture(&runtime_root, STOPPED);
    assert!(stopped.child.wait().unwrap().success());

    let all_request_id = Uuid::new_v4().to_string();
    let all_refresh = schedule(
        &runtime_root,
        &[
            "refresh",
            "--all-instances",
            "--request-id",
            &all_request_id,
        ],
    );
    let all_refresh = expect_stdout_json(&all_refresh, false);
    assert_eq!(all_refresh["operation"], "schedule.refresh");
    assert_eq!(all_refresh["code"], "scheduler.control.refresh_partial");
    assert_eq!(all_refresh["data"]["count"], 2);
    assert_eq!(all_refresh["data"]["appliedCount"], 1);
    assert_eq!(all_refresh["data"]["rejectedCount"], 1);
    assert_eq!(all_refresh["data"]["errorCount"], 0);
    assert_eq!(all_refresh["data"]["problemCount"], 0);
    let results = all_refresh["data"]["results"].as_array().unwrap();
    let alpha_result = fanout_result(results, ALPHA);
    assert_eq!(
        alpha_result["incarnation"],
        alpha_status.instance_id.unwrap().to_string()
    );
    assert_eq!(alpha_result["requestId"], all_request_id);
    assert_eq!(alpha_result["status"], "applied");
    assert_eq!(alpha_result["report"]["applied"], true);
    assert_eq!(
        alpha_result["report"]["inspection"]["scheduleGeneration"],
        2
    );
    let beta_result = fanout_result(results, BETA);
    assert_eq!(
        beta_result["incarnation"],
        beta_status.instance_id.unwrap().to_string()
    );
    assert_eq!(beta_result["requestId"], all_request_id);
    assert_eq!(beta_result["status"], "rejected");
    assert_eq!(beta_result["report"]["applied"], false);
    assert_eq!(beta_result["report"]["inspection"]["scheduleGeneration"], 0);
    assert!(results.iter().all(|result| result["instance"] != STOPPED));
    assert_eq!(fs::read(stopped.schedule_path()).unwrap(), stopped_source);

    let alpha_after_fanout = schedule(&runtime_root, &["list", "--instance", ALPHA]);
    let alpha_after_fanout = expect_stdout_json(&alpha_after_fanout, true);
    assert_eq!(alpha_after_fanout["data"]["scheduleGeneration"], 2);
    let beta_after_fanout = schedule(&runtime_root, &["list", "--instance", BETA]);
    let beta_after_fanout = expect_stdout_json(&beta_after_fanout, true);
    assert_eq!(beta_after_fanout["data"]["scheduleGeneration"], 0);
    assert_eq!(beta_after_fanout["data"]["schedules"], json!([]));

    stop_fixture(&runtime_root, ALPHA);
    stop_fixture(&runtime_root, BETA);
    assert!(alpha.child.wait().unwrap().success());
    assert!(beta.child.wait().unwrap().success());
    fs::remove_dir_all(root).unwrap();
}

async fn register_fixture_channel(
    context: &InstanceContext,
    bus: &RuntimeMessageBus,
    delivery_path: PathBuf,
) -> Result<(), MessageContractError> {
    let message = MessageTypeId {
        id: MESSAGE_TYPE.to_string(),
        version: 1,
    };
    let root = "schemas/fixture-scheduler-control.json".to_string();
    let declarations = MessageDeclarations {
        schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
        provides: vec![MessageTypeContract {
            message: message.clone(),
            schema: MessageSchemaDescriptor {
                draft: JSON_SCHEMA_DRAFT_2020_12.to_string(),
                root: root.clone(),
                resources: BTreeMap::from([(
                    root.clone(),
                    json!({
                        "$schema": JSON_SCHEMA_DRAFT_2020_12,
                        "$id": format!("shipctl-artifact:///{root}"),
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["reason"],
                        "properties": {"reason": {"type": "string"}}
                    }),
                )]),
                max_encoded_bytes: 256,
                redacted_fields: Vec::new(),
                compatible_versions: vec![1],
            },
        }],
        handles: vec![DirectedChannelDeclaration {
            endpoint: RouteEndpointRef {
                id: CHANNEL.to_string(),
                message,
            },
            capacity: 2,
            required_grant: format!("message.send.{CHANNEL}"),
            scheduler_allowed: true,
        }],
        publishes: Vec::new(),
        subscribes: Vec::new(),
        ports: Vec::new(),
    };
    let handler_path = delivery_path.clone();
    let handlers = RegistrationHandlers::new().with_directed(CHANNEL, move |_| {
        let delivery_path = handler_path.clone();
        async move {
            let current = fs::read_to_string(&delivery_path)
                .map_err(|error| {
                    MessageContractError::new(
                        "message.fixture.delivery_read_failed",
                        error.to_string(),
                    )
                })?
                .trim()
                .parse::<usize>()
                .map_err(|error| {
                    MessageContractError::new(
                        "message.fixture.delivery_read_failed",
                        error.to_string(),
                    )
                })?;
            fs::write(&delivery_path, (current + 1).to_string()).map_err(|error| {
                MessageContractError::new(
                    "message.fixture.delivery_write_failed",
                    error.to_string(),
                )
            })?;
            Ok(())
        }
    });
    let registration = Arc::new(PreparedRegistration::prepare(
        context,
        "fixture@scheduler-control#one",
        &[] as &[ModuleGrant],
        declarations,
        handlers,
    )?);
    bus.register(registration).await?;
    Ok(())
}

struct FixtureProcess {
    child: Child,
    status_path: PathBuf,
    state_root: PathBuf,
    delivery_path: PathBuf,
}

impl FixtureProcess {
    fn schedule_root(&self) -> PathBuf {
        self.state_root.join("schedules")
    }

    fn schedule_path(&self) -> PathBuf {
        self.schedule_root().join("fixture.yaml")
    }
}

impl Drop for FixtureProcess {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn start_fixture(
    root: &Path,
    runtime_root: &Path,
    name: &str,
    source: FixtureSource,
) -> FixtureProcess {
    let state_root = root.join(format!("state-{name}"));
    let status_path = root.join(format!("status-{name}-{}.json", Uuid::new_v4()));
    let delivery_path = root.join(format!("delivery-{name}-{}.txt", Uuid::new_v4()));
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .arg("--ignored")
        .arg("--exact")
        .arg("scheduler_control_process_fixture")
        .env(FIXTURE_ENV, "1")
        .env(NAME_ENV, name)
        .env(STATE_ROOT_ENV, &state_root)
        .env(RUNTIME_ROOT_ENV, runtime_root)
        .env(STATUS_PATH_ENV, &status_path)
        .env(DELIVERY_PATH_ENV, &delivery_path)
        .env(SOURCE_ENV, source.as_env())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    FixtureProcess {
        child: command.spawn().unwrap(),
        status_path,
        state_root,
        delivery_path,
    }
}

fn wait_for_status(fixture: &mut FixtureProcess) -> FixtureStatus {
    loop {
        match fs::read_to_string(&fixture.status_path) {
            Ok(value) => return serde_json::from_str(&value).unwrap(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("could not read fixture status: {error}"),
        }
        if let Some(status) = fixture.child.try_wait().unwrap() {
            panic!("scheduler control fixture exited before publishing status: {status}");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn assert_fixture_ready(status: &FixtureStatus, name: &str) {
    assert!(
        status.error.is_none(),
        "scheduler fixture {name} failed: {}",
        status
            .error
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_default()
    );
    assert!(
        status.instance_id.is_some(),
        "fixture {name} has no incarnation"
    );
}

fn wait_for_delivery_count(fixture: &FixtureProcess, expected: usize) {
    loop {
        let count = fs::read_to_string(&fixture.delivery_path)
            .unwrap()
            .trim()
            .parse::<usize>()
            .unwrap();
        assert!(
            count <= expected,
            "scheduler trigger delivered {count} times; expected exactly {expected}"
        );
        if count == expected {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn schedule(runtime_root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_shipctl"))
        .arg("schedule")
        .args(args)
        .arg("--runtime-root")
        .arg(runtime_root)
        .args(["--output", "json"])
        .output()
        .unwrap()
}

fn schedule_default(runtime_root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_shipctl"))
        .arg("schedule")
        .args(args)
        .arg("--runtime-root")
        .arg(runtime_root)
        .output()
        .unwrap()
}

fn stop_fixture(runtime_root: &Path, name: &str) {
    let output = Command::new(env!("CARGO_BIN_EXE_shipctl"))
        .args(["instances", "stop", name, "--runtime-root"])
        .arg(runtime_root)
        .args(["--output", "json"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "could not stop fixture {name}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn expect_stdout_json(output: &Output, succeeds: bool) -> Value {
    assert_no_payload_leak(output);
    assert_eq!(
        output.status.success(),
        succeeds,
        "shipctl output mismatch: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "shipctl wrote unexpected stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn expect_stdout_toon(output: &Output, succeeds: bool) -> Value {
    assert_no_payload_leak(output);
    assert_eq!(
        output.status.success(),
        succeeds,
        "shipctl output mismatch: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "shipctl wrote unexpected stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    toon_format::decode_default(std::str::from_utf8(&output.stdout).unwrap()).unwrap()
}

fn parse_stderr(output: &Output) -> Value {
    assert!(output.stdout.is_empty());
    serde_json::from_slice(&output.stderr).unwrap()
}

fn assert_no_payload_leak(output: &Output) {
    let rendered = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    for private_value in [SECRET, INVALID_SECRET] {
        assert!(
            !rendered.contains(private_value),
            "scheduler CLI leaked private source value {private_value:?}: {rendered}"
        );
    }
    assert!(
        !rendered.contains("\"payload\""),
        "scheduler CLI rendered a raw payload field: {rendered}"
    );
    assert!(
        !rendered
            .lines()
            .any(|line| line.trim_start().starts_with("payload:")),
        "scheduler CLI rendered a raw payload field: {rendered}"
    );
}

fn fanout_result<'a>(results: &'a [Value], instance: &str) -> &'a Value {
    results
        .iter()
        .find(|result| result["instance"] == instance)
        .unwrap_or_else(|| panic!("missing fanout result for {instance}: {results:?}"))
}

fn write_fixture_source(root: &Path, source: FixtureSource) -> std::io::Result<()> {
    fs::create_dir_all(root)?;
    fs::write(root.join("fixture.yaml"), schedule_source(source))
}

fn schedule_source(source: FixtureSource) -> String {
    let extra = match source {
        FixtureSource::Valid => String::new(),
        FixtureSource::Invalid => format!("fixture_private: {INVALID_SECRET}\n"),
    };
    format!(
        r#"schema_version: 1
id: {SCHEDULE_ID}
enabled: true
cron: "0 0 1 1 * Europe/Warsaw"
target:
  kind: channel
  id: {CHANNEL}
message:
  type: {MESSAGE_TYPE}
  version: 1
  payload:
    reason: {SECRET}
{extra}"#
    )
}

fn write_status(path: &Path, instance_id: Option<Uuid>, error: Option<ControlError>) {
    fs::write(
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

fn test_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "shipctl-scheduler-control-cli-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    fs::create_dir_all(&root).unwrap();
    root
}
