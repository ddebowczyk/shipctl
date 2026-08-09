mod args;
mod instances;
mod offline_modules;
mod output;
mod terminals;

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use clap::error::ErrorKind as ClapErrorKind;
use clap::Parser;
use serde::Serialize;
use serde_json::Value;
use shipctl_core::build_info::BuildIdentity;
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
    if remaining.is_empty() {
        return launch_ui_foreground(&[]);
    }
    if should_forward_ui(remaining) {
        return launch_ui_foreground(&remaining[1..]);
    }

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
        Some(CliCommand::Ui { command }) => match command {
            UiCommand::Start(args) => run_ui_start(args, cli.output),
        },
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
        None => emit_usage(
            cli.output,
            "cli",
            "A command is required unless launching the UI with no arguments",
            remaining,
        ),
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
            instances::inspect(
                args.runtime.runtime_root.as_deref(),
                args.selector.as_deref(),
            )
            .and_then(|data| {
                emit_success(
                    output,
                    "instances.inspect",
                    "control.instance.inspected",
                    false,
                    data,
                )
                .map_err(render_error)
            }),
        ),
        InstancesCommand::Diagnose(args) => {
            let rendered = instances::diagnose(
                args.runtime.runtime_root.as_deref(),
                args.selector.as_deref(),
            )
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
            let selector = args.selector;
            let rendered = match instances::stop(
                args.runtime.runtime_root.as_deref(),
                selector.as_deref(),
                args.force,
            ) {
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

fn launch_ui_foreground(args: &[OsString]) -> ExitCode {
    let ui_path = match resolve_ui_path() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("shipctl: {}", error.message);
            return ExitCode::FAILURE;
        }
    };
    match Command::new(&ui_path).args(args).status() {
        Ok(status) => ExitCode::from(status.code().unwrap_or(1) as u8),
        Err(error) => {
            eprintln!("shipctl: could not launch {}: {error}", ui_path.display());
            ExitCode::FAILURE
        }
    }
}

fn resolve_ui_path() -> Result<PathBuf, ControlError> {
    let current_exe = std::env::current_exe().map_err(|error| {
        ControlError::new(
            "control.instance.launcher_unavailable",
            format!("Could not resolve the Shipctl executable path: {error}"),
        )
    })?;
    let ui_path = paired_ui_path(&current_exe);
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

fn should_forward_ui(args: &[OsString]) -> bool {
    args.first().is_some_and(|argument| argument == "ui")
        && !matches!(
            args.get(1).and_then(|argument| argument.to_str()),
            Some("start" | "--help" | "-h")
        )
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

fn detect_output(args: &[OsString]) -> OutputFormat {
    for (index, argument) in args.iter().enumerate() {
        if argument == OsStr::new("--output")
            && args.get(index + 1) == Some(&OsString::from("json"))
        {
            return OutputFormat::Json;
        }
        if argument == OsStr::new("--output=json") {
            return OutputFormat::Json;
        }
    }
    OutputFormat::Toon
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
            command: UiCommand::Start(start),
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
}
