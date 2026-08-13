mod args;
mod instances;
mod logs;
mod offline_modules;
mod output;
mod terminals;

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::error::ErrorKind as ClapErrorKind;
use clap::Parser;
use serde::Serialize;
use serde_json::Value;
use shipctl_core::build_info::BuildIdentity;
use shipctl_core::instance::protocol::{DiscoveryProblemCategory, InstanceLifecycle};
use shipctl_core::instance::ControlError;
use shipctl_core::message_bus::{
    RUNTIME_DIAGNOSTICS_FAILED, RUNTIME_HEALTHY, RUNTIME_INSPECTED as MESSAGE_RUNTIME_INSPECTED,
};
use shipctl_core::module_control::agent::{
    CAPABILITY_RUNTIME_INSPECTED, CAPABILITY_RUNTIME_INVOKED, CAPABILITY_RUNTIME_LISTED,
};
use shipctl_core::module_control::codes::{
    ARTIFACT_ADDED, ARTIFACT_PREFLIGHTED, CAPABILITY_INSPECTED, OPERATION_ACCEPTED,
    OPERATION_INSPECTED, REGISTRY_LISTED, RUNTIME_DIAGNOSED, RUNTIME_INSPECTED,
};
use shipctl_core::module_control::ModuleOperationKind;
use shipctl_core::scheduler::contracts::ScheduleDeliveryOutcome;
use shipctl_core::scheduler::{
    SCHEDULE_CONTROL_INSPECTED, SCHEDULE_CONTROL_LISTED, SCHEDULE_CONTROL_REFRESHED,
    SCHEDULE_CONTROL_REFRESH_PARTIAL, SCHEDULE_CONTROL_REFRESH_REJECTED,
};
use shipctl_core::state::archive::inspect_archive;
use uuid::Uuid;

use args::{
    CapabilitiesCommand, Cli, Command as CliCommand, InstancesCommand, MessagesCommand,
    ModulesCommand, OperationsCommand, ScheduleCommand, StateCommand, UiCommand,
};
use instances::{StartDisposition, StartRequest};
use output::OutputFormat;

pub const APP_VERSION: &str = env!("SHIPCTL_APP_VERSION");
pub const BUILD_ID: &str = env!("SHIPCTL_BUILD_ID");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoppedNoOp {
    selector: String,
    stopped: bool,
}

pub fn paired_ui_path(cli_executable: &Path) -> PathBuf {
    let file_name = if cfg!(windows) {
        "shipctl-ui.exe"
    } else {
        "shipctl-ui"
    };
    cli_executable
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(file_name)
}

pub fn run(args: impl IntoIterator<Item = OsString>) -> ExitCode {
    let raw = args.into_iter().collect::<Vec<_>>();
    let remaining = raw.get(1..).unwrap_or_default();
    let format_hint = detect_output(remaining);
    let cli = match Cli::try_parse_from(&raw) {
        Ok(cli) => cli,
        Err(error)
            if matches!(
                error.kind(),
                ClapErrorKind::DisplayHelp | ClapErrorKind::DisplayVersion
            ) =>
        {
            print!("{error}");
            return ExitCode::SUCCESS;
        }
        Err(error) => {
            return emit_usage(
                format_hint,
                operation_hint(remaining),
                error.to_string().trim(),
                remaining,
            );
        }
    };
    if cli.version {
        if cli.command.is_some() {
            return emit_usage(
                cli.output,
                "cli.version",
                "--version cannot be combined with a subcommand",
                remaining,
            );
        }
        print_version(cli.output);
        return ExitCode::SUCCESS;
    }

    match cli.command {
        // `shipctl ui` and `shipctl ui start` are the same operation. Both detach
        // the UI process and return once it publishes readiness, so neither one
        // holds the terminal or inherits its streams.
        Some(CliCommand::Ui { command, start }) => match command {
            Some(UiCommand::Start(args)) => run_ui_start(args, cli.output),
            None => run_ui_start(start, cli.output),
        },
        Some(CliCommand::Logs(args)) => {
            logs::run(args, cli.output, requested_output(remaining).is_some())
        }
        Some(CliCommand::Instances { command }) => run_instances(command, cli.output),
        Some(CliCommand::Modules { command }) => run_modules(command, cli.output),
        Some(CliCommand::Messages { command }) => run_messages(command, cli.output),
        Some(CliCommand::Capabilities { command }) => run_capabilities(command, cli.output),
        Some(CliCommand::Terminals { command }) => terminals::run(command, cli.output),
        Some(CliCommand::Schedule { command }) => run_schedules(command, cli.output, cli.full),
        Some(CliCommand::Operations { command }) => run_operations(command, cli.output),
        Some(CliCommand::State { command }) => run_state(command, cli.output),
        Some(CliCommand::Version) => {
            print_version(cli.output);
            ExitCode::SUCCESS
        }
        None => run_home(cli.output),
    }
}

/// Operation name for the top-level home view.
const HOME_OPERATION: &str = "home";
const HOME_RENDERED: &str = "control.home.rendered";
const HOME_DESCRIPTION: &str = "Control room for your agent ops";

/// One instance row, projected down to the fields an agent needs to choose a
/// next command. The full record stays available through `instances inspect`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HomeInstance {
    name: String,
    instance_id: String,
    lifecycle: InstanceLifecycle,
}

/// A descriptor that could not be reached and whose process is still alive, so
/// the discovery sweep could not reclaim it. Reclaimed descriptors are omitted:
/// discovery already deleted them, so reporting them would invite action on
/// housekeeping that has already happened.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HomeProblem {
    descriptor_path: PathBuf,
    category: DiscoveryProblemCategory,
    code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HomeView {
    bin: String,
    description: &'static str,
    version: &'static str,
    instances: Vec<HomeInstance>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    unreachable: Vec<HomeProblem>,
    help: Vec<String>,
}

/// The top-level surface for bare `shipctl`. It shows live state rather than a
/// usage manual so an agent can act on the first call, and it never starts the
/// UI — `shipctl ui` does that explicitly.
fn run_home(format: OutputFormat) -> ExitCode {
    let view = match build_home_view(None) {
        Ok(view) => view,
        Err(error) => return emit_failure(format, HOME_OPERATION, &error, false),
    };
    match emit_success(format, HOME_OPERATION, HOME_RENDERED, false, view) {
        Ok(code) => code,
        Err(message) => emit_render_failure(format, HOME_OPERATION, message),
    }
}

fn build_home_view(runtime_root: Option<&Path>) -> Result<HomeView, ControlError> {
    let listed = instances::list(runtime_root)?;
    let instances = listed
        .instances
        .into_iter()
        .map(|record| HomeInstance {
            name: record.name,
            instance_id: record.instance_id.to_string(),
            lifecycle: record.lifecycle,
        })
        .collect::<Vec<_>>();
    let unreachable = listed
        .problems
        .into_iter()
        .filter(|problem| !problem.reclaimed)
        .map(|problem| HomeProblem {
            descriptor_path: problem.descriptor_path,
            category: problem.category,
            code: problem.error.code.to_string(),
        })
        .collect::<Vec<_>>();
    let help = home_help(instances.len(), unreachable.len());
    Ok(HomeView {
        bin: home_executable_path(),
        description: HOME_DESCRIPTION,
        version: APP_VERSION,
        instances,
        unreachable,
        help,
    })
}

/// Suggestions follow from what the view just showed: start the UI when nothing
/// runs, inspect when something does, diagnose when something is stuck.
fn home_help(running: usize, unreachable: usize) -> Vec<String> {
    let mut help = Vec::new();
    if running == 0 {
        help.push("Run `shipctl ui` to start the UI".to_string());
    } else {
        help.push("Run `shipctl ui` to start another instance".to_string());
        help.push("Run `shipctl instances inspect <selector>` for details".to_string());
    }
    if unreachable > 0 {
        help.push(
            "Run `shipctl instances diagnose <selector>` to diagnose an unreachable instance"
                .to_string(),
        );
    }
    help
}

/// The absolute path of this executable, with the home directory collapsed to
/// `~` so the identity line stays short and portable across machines.
fn home_executable_path() -> String {
    let executable = std::env::current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "shipctl".to_string());
    collapse_home(&executable, std::env::var("HOME").ok().as_deref())
}

fn collapse_home(executable: &str, home: Option<&str>) -> String {
    let Some(home) = home.filter(|home| !home.is_empty()) else {
        return executable.to_string();
    };
    let home = home.strip_suffix('/').unwrap_or(home);
    match executable.strip_prefix(home) {
        Some(rest) if rest.starts_with('/') => format!("~{rest}"),
        _ => executable.to_string(),
    }
}

fn run_messages(command: MessagesCommand, output: OutputFormat) -> ExitCode {
    match command {
        MessagesCommand::Inspect(args) => {
            match instances::inspect_messages(args.runtime.runtime_root.as_deref(), &args.instance)
            {
                Ok(data) => emit_success(
                    output,
                    "messages.inspect",
                    MESSAGE_RUNTIME_INSPECTED,
                    false,
                    data,
                )
                .unwrap_or_else(|message| emit_render_failure(output, "messages.inspect", message)),
                Err(error) => emit_failure(output, "messages.inspect", &error, false),
            }
        }
        MessagesCommand::Diagnose(args) => {
            match instances::diagnose_messages(args.runtime.runtime_root.as_deref(), &args.instance)
            {
                Ok(data) => {
                    let healthy = data.healthy;
                    emit_outcome(
                        output,
                        "messages.diagnose",
                        if healthy {
                            RUNTIME_HEALTHY
                        } else {
                            RUNTIME_DIAGNOSTICS_FAILED
                        },
                        healthy,
                        data,
                    )
                    .unwrap_or_else(|message| {
                        emit_render_failure(output, "messages.diagnose", message)
                    })
                }
                Err(error) => emit_failure(output, "messages.diagnose", &error, false),
            }
        }
    }
}

fn run_capabilities(command: CapabilitiesCommand, output: OutputFormat) -> ExitCode {
    match command {
        CapabilitiesCommand::List(args) => {
            match instances::list_capabilities(args.runtime.runtime_root.as_deref(), &args.instance)
            {
                Ok(data) => emit_success(
                    output,
                    "capabilities.list",
                    CAPABILITY_RUNTIME_LISTED,
                    data.capabilities.is_empty(),
                    data,
                )
                .unwrap_or_else(|message| {
                    emit_render_failure(output, "capabilities.list", message)
                }),
                Err(error) => emit_failure(output, "capabilities.list", &error, false),
            }
        }
        CapabilitiesCommand::Inspect(args) => {
            match instances::inspect_capability(
                args.target.runtime.runtime_root.as_deref(),
                &args.target.instance,
                args.capability_id,
            ) {
                Ok(data) => emit_success(
                    output,
                    "capabilities.inspect",
                    CAPABILITY_RUNTIME_INSPECTED,
                    false,
                    data,
                )
                .unwrap_or_else(|message| {
                    emit_render_failure(output, "capabilities.inspect", message)
                }),
                Err(error) => emit_failure(output, "capabilities.inspect", &error, false),
            }
        }
        CapabilitiesCommand::Call(args) => {
            let operation = "capabilities.call";
            let payload = match serde_json::from_str::<Value>(&args.input) {
                Ok(payload) => payload,
                Err(error) => {
                    return emit_failure(
                        output,
                        operation,
                        &ControlError::new(
                            "capability.input.invalid",
                            format!("--input must be valid JSON: {error}"),
                        ),
                        false,
                    );
                }
            };
            match instances::call_capability(
                args.target.runtime.runtime_root.as_deref(),
                &args.target.instance,
                args.capability_id,
                args.port_id,
                payload,
            ) {
                Ok(data) => {
                    emit_success(output, operation, CAPABILITY_RUNTIME_INVOKED, false, data)
                        .unwrap_or_else(|message| emit_render_failure(output, operation, message))
                }
                Err(error) => emit_failure(output, operation, &error, false),
            }
        }
    }
}

fn run_schedules(command: ScheduleCommand, output: OutputFormat, full: bool) -> ExitCode {
    match command {
        ScheduleCommand::List(args) => {
            let operation = "schedule.list";
            match instances::list_schedules(args.runtime.runtime_root.as_deref(), &args.instance) {
                Ok(data) => emit_schedule_success(
                    output,
                    operation,
                    SCHEDULE_CONTROL_LISTED,
                    false,
                    full,
                    data,
                )
                .unwrap_or_else(|message| emit_render_failure(output, operation, message)),
                Err(error) => emit_failure(output, operation, &error, false),
            }
        }
        ScheduleCommand::Inspect(args) => {
            let operation = "schedule.inspect";
            match instances::inspect_schedule(
                args.target.runtime.runtime_root.as_deref(),
                &args.target.instance,
                args.id,
            ) {
                Ok(data) => emit_schedule_success(
                    output,
                    operation,
                    SCHEDULE_CONTROL_INSPECTED,
                    false,
                    full,
                    data,
                )
                .unwrap_or_else(|message| emit_render_failure(output, operation, message)),
                Err(error) => emit_failure(output, operation, &error, false),
            }
        }
        ScheduleCommand::Diagnose(args) => {
            let operation = "schedule.diagnose";
            match instances::diagnose_schedules(
                args.runtime.runtime_root.as_deref(),
                &args.instance,
            ) {
                Ok(data) => {
                    let succeeded = data.healthy;
                    let code = data.code.clone();
                    emit_schedule_outcome(output, operation, &code, succeeded, full, data)
                        .unwrap_or_else(|message| emit_render_failure(output, operation, message))
                }
                Err(error) => emit_failure(output, operation, &error, false),
            }
        }
        ScheduleCommand::Verify(args) => {
            let operation = "schedule.verify";
            match instances::verify_schedules(args.runtime.runtime_root.as_deref(), &args.instance)
            {
                Ok(data) => {
                    let succeeded = data.matches_accepted;
                    let code = data.code.clone();
                    emit_schedule_outcome(output, operation, &code, succeeded, full, data)
                        .unwrap_or_else(|message| emit_render_failure(output, operation, message))
                }
                Err(error) => emit_failure(output, operation, &error, false),
            }
        }
        ScheduleCommand::Refresh(args) if args.all_instances => {
            let operation = "schedule.refresh";
            match instances::refresh_all_schedules(
                args.runtime.runtime_root.as_deref(),
                args.request_id,
            ) {
                Ok(data) if data.is_no_op() => emit_schedule_success(
                    output,
                    operation,
                    SCHEDULE_CONTROL_REFRESHED,
                    true,
                    full,
                    data,
                )
                .unwrap_or_else(|message| emit_render_failure(output, operation, message)),
                Ok(data) => {
                    let succeeded = data.all_applied();
                    let code = if succeeded {
                        SCHEDULE_CONTROL_REFRESHED
                    } else if data.applied_count > 0 {
                        SCHEDULE_CONTROL_REFRESH_PARTIAL
                    } else {
                        SCHEDULE_CONTROL_REFRESH_REJECTED
                    };
                    emit_schedule_outcome(output, operation, code, succeeded, full, data)
                        .unwrap_or_else(|message| emit_render_failure(output, operation, message))
                }
                Err(error) => emit_failure(output, operation, &error, false),
            }
        }
        ScheduleCommand::Refresh(args) => {
            let operation = "schedule.refresh";
            let request_id = args.request_id.unwrap_or_else(Uuid::new_v4);
            let instance = args
                .instance
                .as_deref()
                .expect("clap requires --instance unless --all-instances is selected");
            match instances::refresh_schedules(
                args.runtime.runtime_root.as_deref(),
                instance,
                request_id,
            ) {
                Ok(data) => {
                    let succeeded = data.applied;
                    let code = data.code.clone();
                    emit_schedule_outcome(output, operation, &code, succeeded, full, data)
                        .unwrap_or_else(|message| emit_render_failure(output, operation, message))
                }
                Err(error) => emit_failure(output, operation, &error, false),
            }
        }
        ScheduleCommand::Trigger(args) => {
            let operation = "schedule.trigger";
            let request_id = args.request_id.unwrap_or_else(Uuid::new_v4);
            match instances::trigger_schedule(
                args.target.runtime.runtime_root.as_deref(),
                &args.target.instance,
                args.id,
                request_id,
            ) {
                Ok(data) => {
                    let succeeded =
                        matches!(&data.delivery.outcome, ScheduleDeliveryOutcome::Delivered);
                    let code = data.code.clone();
                    emit_schedule_outcome(output, operation, &code, succeeded, full, data)
                        .unwrap_or_else(|message| emit_render_failure(output, operation, message))
                }
                Err(error) => emit_failure(output, operation, &error, false),
            }
        }
    }
}

fn run_modules(command: ModulesCommand, output: OutputFormat) -> ExitCode {
    match command {
        ModulesCommand::Preflight(args) => {
            debug_assert!(args.offline);
            match offline_modules::preflight(args.state_root.as_deref(), &args.archive) {
                Ok(data) => emit_success(
                    output,
                    "modules.preflight",
                    ARTIFACT_PREFLIGHTED,
                    false,
                    data,
                )
                .unwrap_or_else(|message| {
                    emit_render_failure(output, "modules.preflight", message)
                }),
                Err(error) => emit_failure(output, "modules.preflight", &error, false),
            }
        }
        ModulesCommand::Add(args) => {
            debug_assert!(args.offline);
            match offline_modules::add(args.state_root.as_deref(), &args.archive) {
                Ok(data) => {
                    let no_op = !data.receipt.changed;
                    emit_success(output, "modules.add", ARTIFACT_ADDED, no_op, data).unwrap_or_else(
                        |message| emit_render_failure(output, "modules.add", message),
                    )
                }
                Err(error) => emit_failure(output, "modules.add", &error, false),
            }
        }
        ModulesCommand::List(args) => {
            debug_assert!(args.offline);
            match offline_modules::list(args.state_root.as_deref()) {
                Ok(data) => emit_success(output, "modules.list", REGISTRY_LISTED, false, data)
                    .unwrap_or_else(|message| emit_render_failure(output, "modules.list", message)),
                Err(error) => emit_failure(output, "modules.list", &error, false),
            }
        }
        ModulesCommand::Inspect(args) if args.offline => {
            match offline_modules::inspect(args.state_root.as_deref(), &args.module_id) {
                Ok(data) => {
                    let code = offline_modules::inspection_code(&data);
                    emit_success(output, "modules.inspect", code, false, data).unwrap_or_else(
                        |message| emit_render_failure(output, "modules.inspect", message),
                    )
                }
                Err(error) => emit_failure(output, "modules.inspect", &error, false),
            }
        }
        ModulesCommand::Inspect(args) => match instances::inspect_module(
            args.online.runtime_root.as_deref(),
            args.online.instance.as_deref(),
            args.module_id,
        ) {
            Ok(data) => emit_success(output, "modules.inspect", RUNTIME_INSPECTED, false, data)
                .unwrap_or_else(|message| emit_render_failure(output, "modules.inspect", message)),
            Err(error) => emit_failure(output, "modules.inspect", &error, false),
        },
        ModulesCommand::InspectCapability(args) => {
            debug_assert!(args.offline);
            match offline_modules::inspect_capability(
                args.state_root.as_deref(),
                &args.capability_id,
            ) {
                Ok(data) => emit_success(
                    output,
                    "modules.inspect_capability",
                    CAPABILITY_INSPECTED,
                    false,
                    data,
                )
                .unwrap_or_else(|message| {
                    emit_render_failure(output, "modules.inspect_capability", message)
                }),
                Err(error) => emit_failure(output, "modules.inspect_capability", &error, false),
            }
        }
        ModulesCommand::Diagnose(args) if args.offline => {
            match offline_modules::diagnose(args.state_root.as_deref(), args.module_id.as_deref()) {
                Ok(data) => {
                    let succeeded = data.healthy;
                    let code = offline_modules::diagnostics_code(&data);
                    emit_outcome(output, "modules.diagnose", code, succeeded, data).unwrap_or_else(
                        |message| emit_render_failure(output, "modules.diagnose", message),
                    )
                }
                Err(error) => emit_failure(output, "modules.diagnose", &error, false),
            }
        }
        ModulesCommand::Diagnose(args) => match instances::diagnose_module(
            args.online.runtime_root.as_deref(),
            args.online.instance.as_deref(),
            args.module_id
                .expect("clap requires a module id for online diagnosis"),
        ) {
            Ok(data) => emit_success(output, "modules.diagnose", RUNTIME_DIAGNOSED, false, data)
                .unwrap_or_else(|message| emit_render_failure(output, "modules.diagnose", message)),
            Err(error) => emit_failure(output, "modules.diagnose", &error, false),
        },
        ModulesCommand::Verify(args) => {
            debug_assert!(args.offline);
            match offline_modules::verify(
                args.state_root.as_deref(),
                &args.module_id,
                &args.expectation,
            ) {
                Ok(data) => {
                    let succeeded = data.matched;
                    let code = offline_modules::verification_code(&data);
                    emit_outcome(output, "modules.verify", code, succeeded, data).unwrap_or_else(
                        |message| emit_render_failure(output, "modules.verify", message),
                    )
                }
                Err(error) => emit_failure(output, "modules.verify", &error, false),
            }
        }
        ModulesCommand::Enable(args) => run_module_transition(args, output, true),
        ModulesCommand::Disable(args) => run_module_transition(args, output, false),
    }
}

fn run_module_transition(
    args: args::ModuleTransitionArgs,
    output: OutputFormat,
    enable: bool,
) -> ExitCode {
    let operation = if enable {
        "modules.enable"
    } else {
        "modules.disable"
    };
    if args.offline {
        return match offline_modules::set_enabled(
            args.state_root.as_deref(),
            &args.module_id,
            enable,
        ) {
            Ok(data) => emit_success(output, operation, OPERATION_ACCEPTED, false, data)
                .unwrap_or_else(|message| emit_render_failure(output, operation, message)),
            Err(error) => emit_failure(output, operation, &error, false),
        };
    }
    match instances::transition_module(
        args.runtime_root.as_deref(),
        args.instance.as_deref(),
        args.module_id,
        if enable {
            ModuleOperationKind::Enable
        } else {
            ModuleOperationKind::Disable
        },
        args.target_revision
            .expect("clap requires target revision for online transitions"),
    ) {
        Ok(data) => emit_success(output, operation, OPERATION_ACCEPTED, false, data)
            .unwrap_or_else(|message| emit_render_failure(output, operation, message)),
        Err(error) => emit_failure(output, operation, &error, false),
    }
}

fn run_operations(command: OperationsCommand, output: OutputFormat) -> ExitCode {
    match command {
        OperationsCommand::Inspect(args) => match instances::inspect_operation(
            args.runtime_root.as_deref(),
            args.instance.as_deref(),
            args.operation_id,
        ) {
            Ok(data) => emit_success(
                output,
                "operations.inspect",
                OPERATION_INSPECTED,
                false,
                data,
            )
            .unwrap_or_else(|message| emit_render_failure(output, "operations.inspect", message)),
            Err(error) => emit_failure(output, "operations.inspect", &error, false),
        },
    }
}

fn run_ui_start(args: args::UiStartArgs, output: OutputFormat) -> ExitCode {
    let load_state = match args.load_state {
        Some(path) => match path.canonicalize() {
            Ok(path) => Some(path),
            Err(error) => {
                return emit_failure(
                    output,
                    "ui.start",
                    &ControlError::new(
                        "state.snapshot.unreadable",
                        format!(
                            "Could not resolve state archive {}: {error}",
                            path.display()
                        ),
                    ),
                    false,
                );
            }
        },
        None => None,
    };
    let ui_path = match resolve_ui_path() {
        Ok(path) => path,
        Err(error) => return emit_failure(output, "ui.start", &error, false),
    };
    match instances::start(
        &ui_path,
        StartRequest {
            name: args.name,
            state_root: args.state_root,
            runtime_root: args.runtime_root,
            load_state,
        },
    ) {
        Ok(StartDisposition::Started(instance)) => emit_success(
            output,
            "ui.start",
            "control.instance.ready",
            false,
            instance,
        ),
        Ok(StartDisposition::AlreadyReady(instance)) => emit_success(
            output,
            "ui.start",
            "control.instance.already_ready",
            true,
            instance,
        ),
        Err(error) => Ok(emit_failure(output, "ui.start", &error, false)),
    }
    .unwrap_or_else(|message| emit_render_failure(output, "ui.start", message))
}

fn run_state(command: StateCommand, output: OutputFormat) -> ExitCode {
    let (operation, code, result) = match command {
        StateCommand::Save(args) => {
            let destination = match absolute_path(&args.destination) {
                Ok(path) => path,
                Err(message) => {
                    return emit_failure(
                        output,
                        "state.save",
                        &ControlError::new("state.snapshot.path_invalid", message),
                        false,
                    );
                }
            };
            (
                "state.save",
                "state.snapshot.saved",
                instances::save(
                    args.runtime_root.as_deref(),
                    Some(&args.instance),
                    &destination,
                ),
            )
        }
        StateCommand::Inspect(args) => (
            "state.inspect",
            "state.snapshot.inspected",
            inspect_archive(&args.path),
        ),
        StateCommand::Verify(args) => (
            "state.verify",
            "state.snapshot.verified",
            inspect_archive(&args.path),
        ),
    };
    match result {
        Ok(data) => emit_success(output, operation, code, false, data)
            .unwrap_or_else(|message| emit_render_failure(output, operation, message)),
        Err(error) => emit_failure(output, operation, &error, false),
    }
}

fn run_instances(command: InstancesCommand, output: OutputFormat) -> ExitCode {
    let (operation, rendered) = match command {
        InstancesCommand::List(args) => (
            "instances.list",
            instances::list(args.runtime_root.as_deref()).and_then(|data| {
                emit_success(
                    output,
                    "instances.list",
                    "control.instances.listed",
                    false,
                    data,
                )
                .map_err(render_error)
            }),
        ),
        InstancesCommand::Inspect(args) => (
            "instances.inspect",
            instances::inspect(args.runtime.runtime_root.as_deref(), args.target()).and_then(
                |data| {
                    emit_success(
                        output,
                        "instances.inspect",
                        "control.instance.inspected",
                        false,
                        data,
                    )
                    .map_err(render_error)
                },
            ),
        ),
        InstancesCommand::Diagnose(args) => {
            let rendered = instances::diagnose(args.runtime.runtime_root.as_deref(), args.target())
                .and_then(|data| {
                    let healthy = data.healthy;
                    emit_outcome(
                        output,
                        "instances.diagnose",
                        if healthy {
                            "control.instance.diagnostics_ok"
                        } else {
                            "control.instance.diagnostics_failed"
                        },
                        healthy,
                        data,
                    )
                    .map_err(render_error)
                });
            ("instances.diagnose", rendered)
        }
        InstancesCommand::Stop(args) => {
            let (selector, force, runtime_root) = args.target();
            let rendered =
                match instances::stop(runtime_root.as_deref(), selector.as_deref(), force) {
                    Ok(data) => emit_success(
                        output,
                        "instances.stop",
                        "control.instance.stopped",
                        false,
                        data,
                    )
                    .map_err(render_error),
                    Err(error) if error.code.as_str() == "control.instance.absent" => emit_success(
                        output,
                        "instances.stop",
                        "control.instance.already_stopped",
                        true,
                        StoppedNoOp {
                            selector: selector
                                .or_else(|| std::env::var("SHIPCTL_INSTANCE_ID").ok())
                                .unwrap_or_else(|| "<sole-live-instance>".to_string()),
                            stopped: false,
                        },
                    )
                    .map_err(render_error),
                    Err(error) => Err(error),
                };
            ("instances.stop", rendered)
        }
    };

    match rendered {
        Ok(code) => code,
        Err(error) => emit_failure(output, operation, &error, false),
    }
}

fn resolve_ui_path() -> Result<PathBuf, ControlError> {
    let current_exe = std::env::current_exe().map_err(|error| {
        ControlError::new(
            "control.instance.launcher_unavailable",
            format!("Could not resolve the Shipctl executable path: {error}"),
        )
    })?;
    resolve_ui_path_from(&current_exe)
}

fn resolve_ui_path_from(cli_executable: &Path) -> Result<PathBuf, ControlError> {
    let cli_executable = cli_executable.canonicalize().map_err(|error| {
        ControlError::new(
            "control.instance.launcher_unavailable",
            format!(
                "Could not resolve the Shipctl executable path {}: {error}",
                cli_executable.display()
            ),
        )
    })?;
    let ui_path = paired_ui_path(&cli_executable);
    if ui_path.is_file() {
        Ok(ui_path)
    } else {
        Err(ControlError::new(
            "control.instance.launcher_unavailable",
            format!(
                "The paired UI launcher was not found at {}",
                ui_path.display()
            ),
        ))
    }
}

fn absolute_path(path: &Path) -> Result<PathBuf, String> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        std::env::current_dir()
            .map(|directory| directory.join(path))
            .map_err(|error| format!("Could not resolve current directory: {error}"))
    }
}

fn operation_hint(args: &[OsString]) -> &str {
    match (
        args.first().and_then(|value| value.to_str()),
        args.get(1).and_then(|value| value.to_str()),
    ) {
        (Some(group), Some(command)) if !command.starts_with('-') => match (group, command) {
            ("ui", "start") => "ui.start",
            ("instances", "list") => "instances.list",
            ("instances", "inspect") => "instances.inspect",
            ("instances", "diagnose") => "instances.diagnose",
            ("instances", "stop") => "instances.stop",
            ("modules", "preflight") => "modules.preflight",
            ("modules", "add") => "modules.add",
            ("modules", "list") => "modules.list",
            ("modules", "inspect") => "modules.inspect",
            ("modules", "inspect-capability") => "modules.inspect_capability",
            ("modules", "diagnose") => "modules.diagnose",
            ("modules", "verify") => "modules.verify",
            ("modules", "enable") => "modules.enable",
            ("modules", "disable") => "modules.disable",
            ("messages", "inspect") => "messages.inspect",
            ("messages", "diagnose") => "messages.diagnose",
            ("schedule", "list") => "schedule.list",
            ("schedule", "inspect") => "schedule.inspect",
            ("schedule", "diagnose") => "schedule.diagnose",
            ("schedule", "verify") => "schedule.verify",
            ("schedule", "refresh") => "schedule.refresh",
            ("schedule", "trigger") => "schedule.trigger",
            ("operations", "inspect") => "operations.inspect",
            ("terminals", "list") => "terminals.list",
            ("terminals", "get") => "terminals.get",
            ("terminals", "attach") => "terminals.attach",
            ("terminals", "write") => "terminals.write",
            ("terminals", "report") => "terminals.report",
            ("terminals", "close") => "terminals.close",
            ("state", "save") => "state.save",
            ("state", "inspect") => "state.inspect",
            ("state", "verify") => "state.verify",
            _ => "cli",
        },
        (Some("version"), _) | (Some("--version"), _) | (Some("-V"), _) => "cli.version",
        _ => "cli",
    }
}

/// Read `--output` out of the raw arguments, before clap runs.
///
/// This serves two callers. A parse failure needs a format to report itself in,
/// and a command that rejects a format combination needs to tell an explicit
/// choice from the default — which is why this reports absence rather than
/// substituting the default itself.
fn requested_output(args: &[OsString]) -> Option<OutputFormat> {
    for (index, argument) in args.iter().enumerate() {
        let value = if argument == OsStr::new("--output") {
            args.get(index + 1).and_then(|value| value.to_str())
        } else {
            argument
                .to_str()
                .and_then(|argument| argument.strip_prefix("--output="))
        };
        let Some(value) = value else { continue };
        return match value {
            "toon" => Some(OutputFormat::Toon),
            "json" => Some(OutputFormat::Json),
            "jsonl" => Some(OutputFormat::Jsonl),
            _ => None,
        };
    }
    None
}

fn detect_output(args: &[OsString]) -> OutputFormat {
    requested_output(args).unwrap_or_default()
}

fn emit_success(
    format: OutputFormat,
    operation: &str,
    code: &str,
    no_op: bool,
    data: impl Serialize,
) -> Result<ExitCode, String> {
    println!("{}", output::success(format, operation, code, no_op, data)?);
    Ok(ExitCode::SUCCESS)
}

fn emit_outcome(
    format: OutputFormat,
    operation: &str,
    code: &str,
    succeeded: bool,
    data: impl Serialize,
) -> Result<ExitCode, String> {
    println!(
        "{}",
        output::outcome(format, operation, code, succeeded, data)?
    );
    Ok(if succeeded {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

fn emit_schedule_success(
    format: OutputFormat,
    operation: &str,
    code: &str,
    no_op: bool,
    full: bool,
    data: impl Serialize,
) -> Result<ExitCode, String> {
    emit_success(
        format,
        operation,
        code,
        no_op,
        schedule_output_data(full, data)?,
    )
}

fn emit_schedule_outcome(
    format: OutputFormat,
    operation: &str,
    code: &str,
    succeeded: bool,
    full: bool,
    data: impl Serialize,
) -> Result<ExitCode, String> {
    emit_outcome(
        format,
        operation,
        code,
        succeeded,
        schedule_output_data(full, data)?,
    )
}

/// The regular projection retains stable diagnostic code, severity, source,
/// and schedule identity while dropping optional context. `--full` restores
/// that already-redacted context without altering any scheduler decision data.
fn schedule_output_data(full: bool, data: impl Serialize) -> Result<Value, String> {
    let mut value = serde_json::to_value(data).map_err(|error| error.to_string())?;
    if !full {
        strip_schedule_diagnostic_context(&mut value);
    }
    Ok(value)
}

fn strip_schedule_diagnostic_context(value: &mut Value) {
    match value {
        Value::Array(items) => {
            for item in items {
                strip_schedule_diagnostic_context(item);
            }
        }
        Value::Object(fields) => {
            let is_schedule_diagnostic = fields.contains_key("schemaVersion")
                && fields.contains_key("code")
                && fields.contains_key("severity")
                && fields.contains_key("context");
            if is_schedule_diagnostic {
                fields.remove("context");
            }
            for field in fields.values_mut() {
                strip_schedule_diagnostic_context(field);
            }
        }
        _ => {}
    }
}

fn emit_failure(
    format: OutputFormat,
    operation: &str,
    error: &ControlError,
    usage: bool,
) -> ExitCode {
    match output::failure(format, operation, error) {
        Ok(rendered) => println!("{rendered}"),
        Err(render_error) => eprintln!(
            "{{\"schemaVersion\":1,\"operation\":\"{operation}\",\"status\":\"error\",\"code\":\"cli.render_failed\",\"error\":{{\"message\":{}}}}}",
            serde_json::to_string(&render_error).unwrap()
        ),
    }
    if usage {
        ExitCode::from(2)
    } else {
        ExitCode::FAILURE
    }
}

fn emit_usage(format: OutputFormat, operation: &str, message: &str, args: &[OsString]) -> ExitCode {
    let error = ControlError::new("cli.usage", message).with_expected_observed(
        "valid arguments; run the command with --help for generated usage",
        format!("{args:?}"),
    );
    emit_failure(format, operation, &error, true)
}

/// A usage failure whose cause is a rejected combination of arguments rather
/// than a parse error, so there is no argument list to echo back.
fn emit_usage_message(format: OutputFormat, operation: &str, message: &str) -> ExitCode {
    emit_failure(
        format,
        operation,
        &ControlError::new("cli.usage", message),
        true,
    )
}

fn emit_render_failure(format: OutputFormat, operation: &str, message: String) -> ExitCode {
    emit_failure(
        format,
        operation,
        &ControlError::new("cli.render_failed", message),
        false,
    )
}

fn render_error(message: String) -> ControlError {
    ControlError::new("cli.render_failed", message)
}

fn print_version(format: OutputFormat) {
    let identity = BuildIdentity::new("cli", APP_VERSION);
    if format == OutputFormat::Json {
        println!(
            "{}",
            serde_json::to_string(&identity).expect("build identity is serializable")
        );
    } else {
        println!(
            "shipctl {} (role {}, control protocol {})",
            identity.app_version, identity.executable_role, identity.control_protocol_version
        );
    }
}

#[cfg(test)]
mod tests {
    use crate::args::TerminalsCommand;
    use shipctl_core::instance::{DiscoveryProblem, DEFAULT_INSTANCE_NAME};
    use shipctl_module_semantic_terminal_core::projection::ProjectedSpace;

    use super::*;

    #[test]
    fn paired_ui_is_a_sibling_of_the_cli() {
        let cli = if cfg!(windows) {
            Path::new("C:/Shipctl/shipctl.exe")
        } else {
            Path::new("/Applications/shipctl.app/Contents/MacOS/shipctl")
        };

        let paired = paired_ui_path(cli);

        assert_eq!(paired.parent(), cli.parent());
        assert_eq!(
            paired.file_name(),
            Some(OsStr::new(if cfg!(windows) {
                "shipctl-ui.exe"
            } else {
                "shipctl-ui"
            }))
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolves_the_ui_from_a_homebrew_style_cli_symlink() {
        use std::fs;
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("shipctl-cli-test-{}", Uuid::new_v4()));
        let application = root.join("Cellar/shipctl/0.0.0/shipctl.app/Contents/MacOS");
        let cli = application.join("shipctl");
        let ui = application.join("shipctl-ui");
        let shell_cli = root.join("bin/shipctl");

        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            fs::create_dir_all(&application)?;
            fs::create_dir_all(shell_cli.parent().expect("shell CLI has a parent"))?;
            fs::write(&cli, [])?;
            fs::write(&ui, [])?;
            symlink(&cli, &shell_cli)?;

            assert_eq!(resolve_ui_path_from(&shell_cli)?, ui.canonicalize()?);
            Ok(())
        })();

        let _ = fs::remove_dir_all(&root);
        result.expect("a Homebrew CLI symlink must resolve its bundled UI sibling");
    }

    #[test]
    fn clap_parses_agent_instance_commands_without_prompts() {
        let parsed = Cli::try_parse_from([
            "shipctl",
            "ui",
            "start",
            "--name",
            "alpha",
            "--state-root=/tmp/alpha",
            "--runtime-root",
            "/tmp/runtime",
            "--output",
            "json",
        ])
        .unwrap();
        assert_eq!(parsed.output, OutputFormat::Json);
        let Some(CliCommand::Ui {
            command: Some(UiCommand::Start(start)),
            ..
        }) = parsed.command
        else {
            panic!("expected ui start")
        };
        assert_eq!(start.name, "alpha");

        let parsed = Cli::try_parse_from([
            "shipctl",
            "instances",
            "stop",
            "alpha",
            "--force",
            "--output=toon",
        ])
        .unwrap();
        let Some(CliCommand::Instances {
            command: InstancesCommand::Stop(stop),
        }) = parsed.command
        else {
            panic!("expected instances stop")
        };
        assert_eq!(stop.selector.as_deref(), Some("alpha"));
        assert!(stop.force);
    }

    fn stop_target(arguments: &[&str]) -> Option<String> {
        let parsed = Cli::try_parse_from(arguments).unwrap();
        let Some(CliCommand::Instances {
            command: InstancesCommand::Stop(stop),
        }) = parsed.command
        else {
            panic!("expected instances stop")
        };
        stop.target().0
    }

    /// One instance is addressed the same way everywhere. `ui start --name`
    /// created it, so `--name` has to stop it too, and `--instance` is the
    /// spelling every other command already uses.
    #[test]
    fn an_instance_is_addressed_by_position_or_by_either_flag() {
        assert_eq!(
            stop_target(&["shipctl", "instances", "stop", "alpha"]).as_deref(),
            Some("alpha")
        );
        assert_eq!(
            stop_target(&["shipctl", "instances", "stop", "--instance", "alpha"]).as_deref(),
            Some("alpha")
        );
        assert_eq!(
            stop_target(&["shipctl", "instances", "stop", "--name", "alpha"]).as_deref(),
            Some("alpha")
        );
        assert_eq!(stop_target(&["shipctl", "instances", "stop"]), None);
    }

    /// The two spellings name the same thing, so giving both is a caller
    /// mistake rather than a precedence question this CLI should answer.
    #[test]
    fn the_positional_and_the_flag_cannot_both_address_an_instance() {
        assert!(Cli::try_parse_from([
            "shipctl",
            "instances",
            "stop",
            "alpha",
            "--instance",
            "beta"
        ])
        .is_err());
    }

    #[test]
    fn inspect_and_diagnose_accept_the_same_spellings_as_stop() {
        for verb in ["inspect", "diagnose"] {
            for spelling in [
                vec!["alpha"],
                vec!["--instance", "alpha"],
                vec!["--name", "alpha"],
            ] {
                let mut arguments = vec!["shipctl", "instances", verb];
                arguments.extend(spelling.iter());
                let parsed = Cli::try_parse_from(&arguments).unwrap();
                let target = match parsed.command {
                    Some(CliCommand::Instances {
                        command: InstancesCommand::Inspect(args),
                    })
                    | Some(CliCommand::Instances {
                        command: InstancesCommand::Diagnose(args),
                    }) => args.target().map(str::to_string),
                    _ => panic!("expected an instances selector command"),
                };
                assert_eq!(target.as_deref(), Some("alpha"), "{arguments:?}");
            }
        }
    }

    /// `ui start` keeps `--name`, and gains the spelling the rest of the CLI
    /// uses, so a caller never has to remember which command wants which.
    #[test]
    fn starting_the_ui_accepts_both_spellings_of_the_instance_name() {
        for flag in ["--name", "--instance"] {
            let parsed = Cli::try_parse_from(["shipctl", "ui", "start", flag, "alpha"]).unwrap();
            let Some(CliCommand::Ui {
                command: Some(UiCommand::Start(start)),
                ..
            }) = parsed.command
            else {
                panic!("expected ui start")
            };
            assert_eq!(start.name, "alpha", "{flag}");
        }
    }

    /// Commands that reach a running instance already used `--instance`. They
    /// must accept `--name` too, or the alias is only half a convention.
    #[test]
    fn a_running_instance_target_accepts_the_name_alias() {
        let parsed =
            Cli::try_parse_from(["shipctl", "terminals", "list", "--name", "alpha"]).unwrap();
        let Some(CliCommand::Terminals {
            command: TerminalsCommand::List(args),
        }) = parsed.command
        else {
            panic!("expected terminals list")
        };
        assert_eq!(args.instance, "alpha");

        let parsed = Cli::try_parse_from(["shipctl", "logs", "--name", "alpha"]).unwrap();
        let Some(CliCommand::Logs(args)) = parsed.command else {
            panic!("expected logs")
        };
        assert_eq!(args.instance.as_deref(), Some("alpha"));
    }

    #[test]
    fn clap_parses_typed_terminal_commands() {
        let terminal_id = "01234567-89ab-4def-8123-456789abcdef";

        let parsed = Cli::try_parse_from([
            "shipctl",
            "terminals",
            "attach",
            terminal_id,
            "--instance",
            "alpha",
            "--runtime-root=/tmp/runtime",
            "--raw",
        ])
        .unwrap();
        let Some(CliCommand::Terminals {
            command: args::TerminalsCommand::Attach(attach),
        }) = parsed.command
        else {
            panic!("expected terminal attach")
        };
        assert_eq!(attach.terminal_id.to_string(), terminal_id);
        assert_eq!(attach.target.instance, "alpha");
        assert!(attach.raw);
        assert!(
            Cli::try_parse_from([
                "shipctl",
                "terminals",
                "attach",
                terminal_id,
                "--instance=alpha",
                "--encoding=semantic",
            ])
            .is_err(),
            "the raw control attachment has no presentation selector"
        );

        let parsed = Cli::try_parse_from([
            "shipctl",
            "terminals",
            "write",
            terminal_id,
            "--instance=alpha",
            "--base64=AAEC/w==",
        ])
        .unwrap();
        let Some(CliCommand::Terminals {
            command: args::TerminalsCommand::Write(write),
        }) = parsed.command
        else {
            panic!("expected terminal write")
        };
        assert_eq!(write.base64.as_deref(), Some("AAEC/w=="));
        assert!(write.data.is_none());
        assert!(!write.stdin);

        let parsed = Cli::try_parse_from([
            "shipctl",
            "terminals",
            "input",
            terminal_id,
            "--instance=alpha",
            r#"--json={"kind":"focus","gained":true}"#,
        ])
        .unwrap();
        let Some(CliCommand::Terminals {
            command: args::TerminalsCommand::Input(input),
        }) = parsed.command
        else {
            panic!("expected terminal input")
        };
        assert_eq!(
            input.json.as_deref(),
            Some(r#"{"kind":"focus","gained":true}"#)
        );
        assert!(!input.stdin);
        for refused in [
            vec![
                "shipctl",
                "terminals",
                "input",
                terminal_id,
                "--instance=alpha",
            ],
            vec![
                "shipctl",
                "terminals",
                "input",
                terminal_id,
                "--instance=alpha",
                r#"--json={"kind":"focus","gained":true}"#,
                "--stdin",
            ],
        ] {
            assert!(
                Cli::try_parse_from(refused).is_err(),
                "one semantic input comes from one source"
            );
        }

        let parsed = Cli::try_parse_from([
            "shipctl",
            "terminals",
            "history",
            terminal_id,
            "--instance=alpha",
            "--start-row=2",
            "--rows=8",
        ])
        .unwrap();
        let Some(CliCommand::Terminals {
            command: args::TerminalsCommand::History(history),
        }) = parsed.command
        else {
            panic!("expected terminal history")
        };
        assert_eq!(history.start_row, 2);
        assert_eq!(history.rows, 8);
        assert!(!history.text);
        for refused in [
            vec![
                "shipctl",
                "terminals",
                "history",
                terminal_id,
                "--instance=alpha",
                "--start-row=0",
            ],
            vec![
                "shipctl",
                "terminals",
                "history",
                terminal_id,
                "--instance=alpha",
                "--rows=8",
            ],
        ] {
            assert!(
                Cli::try_parse_from(refused).is_err(),
                "a window has no bounds this CLI is entitled to invent"
            );
        }

        let parsed = Cli::try_parse_from([
            "shipctl",
            "terminals",
            "anchor",
            terminal_id,
            "--instance=alpha",
            "--space=history",
            "--row=3",
            "--column=0",
        ])
        .unwrap();
        let Some(CliCommand::Terminals {
            command: args::TerminalsCommand::Anchor(anchor),
        }) = parsed.command
        else {
            panic!("expected a terminal anchor")
        };
        assert_eq!(anchor.row, 3);
        assert_eq!(anchor.column, 0);
        assert!(matches!(
            ProjectedSpace::from(anchor.space),
            ProjectedSpace::History
        ));
        for refused in [
            vec![
                "shipctl",
                "terminals",
                "anchor",
                terminal_id,
                "--instance=alpha",
                "--row=3",
                "--column=0",
            ],
            vec![
                "shipctl",
                "terminals",
                "anchor",
                terminal_id,
                "--instance=alpha",
                "--space=history",
                "--column=0",
            ],
        ] {
            assert!(
                Cli::try_parse_from(refused).is_err(),
                "a cell with no space, or no row, is not a cell",
            );
        }

        let parsed = Cli::try_parse_from([
            "shipctl",
            "terminals",
            "resolve-anchor",
            terminal_id,
            "7",
            "--instance=alpha",
        ])
        .unwrap();
        let Some(CliCommand::Terminals {
            command: args::TerminalsCommand::ResolveAnchor(resolve),
        }) = parsed.command
        else {
            panic!("expected an anchor resolve")
        };
        assert_eq!(resolve.anchor, 7);

        let parsed = Cli::try_parse_from([
            "shipctl",
            "terminals",
            "release-anchor",
            terminal_id,
            "7",
            "--instance=alpha",
        ])
        .unwrap();
        let Some(CliCommand::Terminals {
            command: args::TerminalsCommand::ReleaseAnchor(release),
        }) = parsed.command
        else {
            panic!("expected an anchor release")
        };
        assert_eq!(release.anchor, 7);

        let parsed = Cli::try_parse_from([
            "shipctl",
            "terminals",
            "report",
            "blocked",
            "--terminal-id",
            terminal_id,
            "--instance=alpha",
            "--source=codex",
            "--source-version=1.2.3",
            "--message=waiting for review",
        ])
        .unwrap();
        let Some(CliCommand::Terminals {
            command: args::TerminalsCommand::Report(report),
        }) = parsed.command
        else {
            panic!("expected terminal report")
        };
        assert_eq!(report.terminal_id.unwrap().to_string(), terminal_id);
        assert_eq!(report.instance.as_deref(), Some("alpha"));
        assert!(matches!(
            report.kind,
            args::TerminalAgentReportKindArg::Blocked
        ));
        assert_eq!(report.source, "codex");
        assert_eq!(report.source_version, "1.2.3");
        assert_eq!(report.message.as_deref(), Some("waiting for review"));
    }

    #[test]
    fn clap_enforces_terminal_target_identity_and_one_write_source() {
        let terminal_id = "01234567-89ab-4def-8123-456789abcdef";

        for args in [
            vec![
                "shipctl",
                "terminals",
                "write",
                terminal_id,
                "--instance=alpha",
            ],
            vec![
                "shipctl",
                "terminals",
                "write",
                terminal_id,
                "--instance=alpha",
                "--data=hello",
                "--stdin",
            ],
            vec!["shipctl", "terminals", "list"],
            vec![
                "shipctl",
                "terminals",
                "get",
                "not-a-terminal",
                "--instance=alpha",
            ],
        ] {
            assert!(Cli::try_parse_from(args).is_err());
        }

        for source in ["--data=hello", "--base64=aGVsbG8=", "--stdin"] {
            assert!(Cli::try_parse_from([
                "shipctl",
                "terminals",
                "write",
                terminal_id,
                "--instance=alpha",
                source,
            ])
            .is_ok());
        }
    }

    #[test]
    fn clap_parses_state_archive_commands() {
        let parsed = Cli::try_parse_from([
            "shipctl",
            "state",
            "save",
            "--instance=alpha",
            "--to",
            "/tmp/alpha.shipctl-state",
            "--runtime-root=/tmp/runtime",
            "--output=json",
        ])
        .unwrap();
        assert_eq!(parsed.output, OutputFormat::Json);
        let Some(CliCommand::State {
            command: StateCommand::Save(save),
        }) = parsed.command
        else {
            panic!("expected state save")
        };
        assert_eq!(save.instance, "alpha");
        assert_eq!(save.destination, Path::new("/tmp/alpha.shipctl-state"));
    }

    #[test]
    fn clap_parses_online_and_offline_module_commands() {
        let parsed = Cli::try_parse_from([
            "shipctl",
            "modules",
            "enable",
            "shipctl.fixture",
            "--target-revision=12",
            "--instance",
            "fixture",
            "--output=json",
        ])
        .unwrap();
        assert_eq!(parsed.output, OutputFormat::Json);
        let Some(CliCommand::Modules {
            command: ModulesCommand::Enable(module),
        }) = parsed.command
        else {
            panic!("expected modules enable")
        };
        assert_eq!(module.module_id, "shipctl.fixture");
        assert_eq!(module.target_revision, Some(12));
        assert_eq!(module.instance.as_deref(), Some("fixture"));

        let parsed = Cli::try_parse_from([
            "shipctl",
            "modules",
            "enable",
            "shipctl.fixture",
            "--offline",
            "--state-root",
            "/tmp/state",
            "--output=json",
        ])
        .unwrap();
        let Some(CliCommand::Modules {
            command: ModulesCommand::Enable(module),
        }) = parsed.command
        else {
            panic!("expected offline modules enable")
        };
        assert!(module.offline);
        assert_eq!(module.state_root.as_deref(), Some(Path::new("/tmp/state")));
        assert_eq!(module.target_revision, None);

        let parsed = Cli::try_parse_from([
            "shipctl",
            "modules",
            "diagnose",
            "--offline",
            "--state-root",
            "/tmp/state",
        ])
        .unwrap();
        let Some(CliCommand::Modules {
            command: ModulesCommand::Diagnose(diagnose),
        }) = parsed.command
        else {
            panic!("expected offline modules diagnose")
        };
        assert!(diagnose.offline);
        assert!(diagnose.module_id.is_none());
    }

    #[test]
    fn clap_requires_explicit_offline_artifact_operations() {
        let archive = Path::new("/tmp/fixture.shipctl-module");
        let state_root = Path::new("/tmp/state");

        let preflight = Cli::try_parse_from([
            "shipctl",
            "modules",
            "preflight",
            archive.to_str().unwrap(),
            "--offline",
            "--state-root",
            state_root.to_str().unwrap(),
        ])
        .unwrap();
        let Some(CliCommand::Modules {
            command: ModulesCommand::Preflight(args),
        }) = preflight.command
        else {
            panic!("expected offline artifact preflight")
        };
        assert!(args.offline);
        assert_eq!(args.archive, archive);
        assert_eq!(args.state_root.as_deref(), Some(state_root));

        let add = Cli::try_parse_from([
            "shipctl",
            "modules",
            "add",
            archive.to_str().unwrap(),
            "--offline",
        ])
        .unwrap();
        assert!(matches!(
            add.command,
            Some(CliCommand::Modules {
                command: ModulesCommand::Add(args),
            }) if args.offline && args.archive == archive
        ));

        let capability = Cli::try_parse_from([
            "shipctl",
            "modules",
            "inspect-capability",
            "acme.work-review",
            "--offline",
        ])
        .unwrap();
        assert!(matches!(
            capability.command,
            Some(CliCommand::Modules {
                command: ModulesCommand::InspectCapability(args),
            }) if args.offline && args.capability_id == "acme.work-review"
        ));

        for command in [
            vec!["shipctl", "modules", "preflight", archive.to_str().unwrap()],
            vec!["shipctl", "modules", "add", archive.to_str().unwrap()],
            vec![
                "shipctl",
                "modules",
                "inspect-capability",
                "acme.work-review",
            ],
        ] {
            assert!(Cli::try_parse_from(command).is_err());
        }
    }

    #[test]
    fn clap_requires_an_explicit_message_runtime_and_has_no_send_surface() {
        let parsed = Cli::try_parse_from([
            "shipctl",
            "messages",
            "inspect",
            "--instance",
            "fixture",
            "--runtime-root=/tmp/runtime",
            "--output=json",
        ])
        .unwrap();
        assert_eq!(parsed.output, OutputFormat::Json);
        let Some(CliCommand::Messages {
            command: MessagesCommand::Inspect(inspect),
        }) = parsed.command
        else {
            panic!("expected messages inspect")
        };
        assert_eq!(inspect.instance, "fixture");
        assert_eq!(
            inspect.runtime.runtime_root.as_deref(),
            Some(Path::new("/tmp/runtime"))
        );

        assert!(Cli::try_parse_from(["shipctl", "messages", "inspect"]).is_err());
        assert!(
            Cli::try_parse_from(["shipctl", "messages", "send", "--instance", "fixture"]).is_err()
        );
    }

    #[test]
    fn clap_exposes_only_explicit_schedule_targets() {
        let parsed = Cli::try_parse_from([
            "shipctl",
            "schedule",
            "list",
            "--instance",
            "fixture",
            "--runtime-root=/tmp/runtime",
            "--full",
            "--output=json",
        ])
        .unwrap();
        assert!(parsed.full);
        let Some(CliCommand::Schedule {
            command: ScheduleCommand::List(list),
        }) = parsed.command
        else {
            panic!("expected schedule list");
        };
        assert_eq!(list.instance, "fixture");

        let parsed = Cli::try_parse_from([
            "shipctl",
            "schedule",
            "inspect",
            "daily-usage",
            "--instance=fixture",
        ])
        .unwrap();
        let Some(CliCommand::Schedule {
            command: ScheduleCommand::Inspect(inspect),
        }) = parsed.command
        else {
            panic!("expected schedule inspect");
        };
        assert_eq!(inspect.id, "daily-usage");
        assert_eq!(inspect.target.instance, "fixture");

        for command in ["diagnose", "verify"] {
            assert!(Cli::try_parse_from(
                ["shipctl", "schedule", command, "--instance", "fixture",]
            )
            .is_ok());
        }

        let request_id = "b56fd2d4-3f84-4ad0-9e36-c887bc62cc4c";
        let parsed = Cli::try_parse_from([
            "shipctl",
            "schedule",
            "refresh",
            "--instance",
            "fixture",
            "--request-id",
            request_id,
        ])
        .unwrap();
        let Some(CliCommand::Schedule {
            command: ScheduleCommand::Refresh(refresh),
        }) = parsed.command
        else {
            panic!("expected single-instance schedule refresh");
        };
        assert_eq!(refresh.instance.as_deref(), Some("fixture"));
        assert!(!refresh.all_instances);
        assert_eq!(refresh.request_id.unwrap().to_string(), request_id);

        let parsed = Cli::try_parse_from([
            "shipctl",
            "schedule",
            "refresh",
            "--all-instances",
            "--request-id",
            request_id,
        ])
        .unwrap();
        let Some(CliCommand::Schedule {
            command: ScheduleCommand::Refresh(refresh),
        }) = parsed.command
        else {
            panic!("expected all-instance schedule refresh");
        };
        assert!(refresh.all_instances);
        assert!(refresh.instance.is_none());
        assert_eq!(refresh.request_id.unwrap().to_string(), request_id);

        let parsed = Cli::try_parse_from([
            "shipctl",
            "schedule",
            "trigger",
            "daily-usage",
            "--instance",
            "fixture",
            "--request-id",
            request_id,
        ])
        .unwrap();
        let Some(CliCommand::Schedule {
            command: ScheduleCommand::Trigger(trigger),
        }) = parsed.command
        else {
            panic!("expected schedule trigger");
        };
        assert_eq!(trigger.id, "daily-usage");
        assert_eq!(trigger.target.instance, "fixture");
        assert_eq!(trigger.request_id.unwrap().to_string(), request_id);

        assert!(Cli::try_parse_from(["shipctl", "schedule", "list"]).is_err());
        assert!(Cli::try_parse_from(["shipctl", "schedule", "inspect", "daily-usage"]).is_err());
        assert!(Cli::try_parse_from(["shipctl", "schedule", "diagnose"]).is_err());
        assert!(Cli::try_parse_from(["shipctl", "schedule", "verify"]).is_err());
        assert!(Cli::try_parse_from(["shipctl", "schedule", "refresh"]).is_err());
        assert!(Cli::try_parse_from(["shipctl", "schedule", "trigger", "daily-usage"]).is_err());
        assert!(Cli::try_parse_from([
            "shipctl",
            "schedule",
            "refresh",
            "--instance",
            "fixture",
            "--all-instances",
        ])
        .is_err());
    }

    #[test]
    fn schedule_default_projection_omits_only_diagnostic_context() {
        let diagnostic = serde_json::json!({
            "schemaVersion": 1,
            "code": "scheduler.source.invalid",
            "severity": "error",
            "sourcePath": "schedules/daily.yaml",
            "context": {"fields": {"reason": "missing target"}},
        });
        let data = serde_json::json!({
            "count": 1,
            "diagnostics": [diagnostic],
            "unrelated": {"context": {"preserved": true}},
        });

        let default = schedule_output_data(false, &data).unwrap();
        assert!(default["diagnostics"][0].get("context").is_none());
        assert_eq!(
            default["unrelated"]["context"]["preserved"],
            serde_json::json!(true)
        );

        let full = schedule_output_data(true, &data).unwrap();
        assert_eq!(
            full["diagnostics"][0]["context"]["fields"]["reason"],
            serde_json::json!("missing target")
        );
    }

    #[test]
    fn clap_rejects_conflicting_module_targets_and_emits_plain_help() {
        let error = Cli::try_parse_from([
            "shipctl",
            "modules",
            "inspect",
            "shipctl.fixture",
            "--offline",
            "--instance",
            "alpha",
        ])
        .unwrap_err();
        assert_eq!(error.kind(), ClapErrorKind::ArgumentConflict);

        let help = Cli::try_parse_from(["shipctl", "modules", "--help"])
            .unwrap_err()
            .to_string();
        assert!(!help.contains('\u{1b}'));
        assert!(help.contains("Usage: shipctl modules"));
    }

    #[test]
    fn app_version_is_compiled_from_the_tauri_source_of_truth() {
        assert_ne!(APP_VERSION, "0.0.0");
    }

    /// A command that rejects a format combination has to tell an explicit
    /// `--output` from the default, so absence is reported rather than
    /// replaced with the default value.
    #[test]
    fn the_requested_output_reports_absence_and_every_spelling() {
        let of =
            |args: &[&str]| requested_output(&args.iter().map(OsString::from).collect::<Vec<_>>());

        assert_eq!(of(&["logs"]), None);
        assert_eq!(of(&["logs", "--output", "toon"]), Some(OutputFormat::Toon));
        assert_eq!(of(&["logs", "--output=json"]), Some(OutputFormat::Json));
        assert_eq!(
            of(&["logs", "--output", "jsonl"]),
            Some(OutputFormat::Jsonl)
        );
        assert_eq!(of(&["logs", "--output=jsonl"]), Some(OutputFormat::Jsonl));
        assert_eq!(of(&["logs", "--output", "nonsense"]), None);
        assert_eq!(detect_output(&[OsString::from("logs")]), OutputFormat::Toon);
    }

    #[test]
    fn clap_parses_the_log_read_surface() {
        let cli = Cli::try_parse_from([
            "shipctl",
            "logs",
            "--level",
            "warn",
            "--target",
            "webview:*",
            "--target",
            "shipctl::*",
            "--instance",
            "lab",
            "--since",
            "15m",
            "--limit",
            "20",
            "--follow",
            "--output",
            "jsonl",
        ])
        .unwrap();

        assert_eq!(cli.output, OutputFormat::Jsonl);
        let Some(CliCommand::Logs(args)) = cli.command else {
            panic!("expected the logs command")
        };
        assert_eq!(args.level.as_deref(), Some("warn"));
        assert_eq!(args.target, vec!["webview:*", "shipctl::*"]);
        assert_eq!(args.instance.as_deref(), Some("lab"));
        assert_eq!(args.since.as_deref(), Some("15m"));
        assert_eq!(args.limit, 20);
        assert!(args.follow);
        assert!(!args.notices);
    }

    #[test]
    fn no_arguments_parse_to_the_home_view_instead_of_launching_the_ui() {
        let cli = Cli::try_parse_from(["shipctl"]).unwrap();
        assert!(cli.command.is_none());
        assert!(!cli.version);
    }

    /// Bare `shipctl ui` must reach the same detached start path as
    /// `shipctl ui start`, so it never holds the terminal.
    #[test]
    fn bare_ui_carries_default_start_arguments() {
        let cli = Cli::try_parse_from(["shipctl", "ui"]).unwrap();
        let Some(CliCommand::Ui { command, start }) = cli.command else {
            panic!("expected the ui command")
        };
        assert!(command.is_none());
        assert_eq!(start.name, DEFAULT_INSTANCE_NAME);
        assert!(start.state_root.is_none());
        assert!(start.runtime_root.is_none());
        assert!(start.load_state.is_none());
    }

    #[test]
    fn bare_ui_accepts_the_start_arguments_directly() {
        let cli = Cli::try_parse_from(["shipctl", "ui", "--name", "alpha"]).unwrap();
        let Some(CliCommand::Ui { command, start }) = cli.command else {
            panic!("expected the ui command")
        };
        assert!(command.is_none());
        assert_eq!(start.name, "alpha");
    }

    /// `ui start` keeps working for the ops integration scripts, and its name
    /// now falls back to the same default the UI itself applies.
    #[test]
    fn ui_start_defaults_its_name_to_the_shared_constant() {
        let cli = Cli::try_parse_from(["shipctl", "ui", "start"]).unwrap();
        let Some(CliCommand::Ui {
            command: Some(UiCommand::Start(start)),
            ..
        }) = cli.command
        else {
            panic!("expected ui start")
        };
        assert_eq!(start.name, DEFAULT_INSTANCE_NAME);
    }

    #[test]
    fn home_help_follows_from_what_the_view_shows() {
        assert_eq!(
            home_help(0, 0),
            vec!["Run `shipctl ui` to start the UI".to_string()]
        );

        let running = home_help(2, 0);
        assert_eq!(running.len(), 2);
        assert!(running[0].contains("start another instance"));
        assert!(running[1].contains("instances inspect <selector>"));

        let stuck = home_help(0, 1);
        assert_eq!(stuck.len(), 2);
        assert!(stuck[1].contains("instances diagnose <selector>"));
    }

    #[test]
    fn home_collapses_only_a_real_home_prefix() {
        assert_eq!(
            collapse_home("/Users/me/bin/shipctl", Some("/Users/me")),
            "~/bin/shipctl"
        );
        assert_eq!(
            collapse_home("/Users/me/bin/shipctl", Some("/Users/me/")),
            "~/bin/shipctl"
        );
        // A sibling directory that merely starts with the same characters is
        // not inside the home directory.
        assert_eq!(
            collapse_home("/Users/median/bin/shipctl", Some("/Users/me")),
            "/Users/median/bin/shipctl"
        );
        assert_eq!(
            collapse_home("/opt/shipctl", Some("/Users/me")),
            "/opt/shipctl"
        );
        assert_eq!(collapse_home("/opt/shipctl", None), "/opt/shipctl");
        assert_eq!(collapse_home("/opt/shipctl", Some("")), "/opt/shipctl");
    }

    #[test]
    fn home_view_reports_a_definitive_zero_for_an_empty_runtime_root() {
        let runtime_root = tempfile::tempdir().unwrap();
        let view = build_home_view(Some(runtime_root.path())).unwrap();

        assert!(view.instances.is_empty());
        assert!(view.unreachable.is_empty());
        assert_eq!(view.version, APP_VERSION);
        assert_eq!(view.description, HOME_DESCRIPTION);
        assert_eq!(
            view.help,
            vec!["Run `shipctl ui` to start the UI".to_string()]
        );

        // The empty `unreachable` list is omitted so a quiet home view stays
        // small, while `instances` always renders its definitive zero.
        let rendered = output::success(
            OutputFormat::Toon,
            HOME_OPERATION,
            HOME_RENDERED,
            false,
            &view,
        )
        .unwrap();
        assert!(rendered.contains("instances[0]:"));
        assert!(!rendered.contains("unreachable"));
    }

    #[test]
    fn home_view_hides_reclaimed_descriptors_and_keeps_stuck_ones() {
        let reclaimed = DiscoveryProblem {
            descriptor_path: PathBuf::from("/tmp/gone.json"),
            category: DiscoveryProblemCategory::HandshakeFailed,
            error: ControlError::new("control.instance.handshake_failed", "dead"),
            reclaimed: true,
        };
        let stuck = DiscoveryProblem {
            descriptor_path: PathBuf::from("/tmp/stuck.json"),
            category: DiscoveryProblemCategory::HandshakeFailed,
            error: ControlError::new("control.instance.handshake_failed", "alive"),
            reclaimed: false,
        };

        let kept = [reclaimed, stuck]
            .into_iter()
            .filter(|problem| !problem.reclaimed)
            .map(|problem| problem.descriptor_path)
            .collect::<Vec<_>>();

        assert_eq!(kept, vec![PathBuf::from("/tmp/stuck.json")]);
    }
}
