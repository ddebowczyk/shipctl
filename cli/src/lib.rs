mod args;
mod instances;
mod offline_modules;
mod output;

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use clap::error::ErrorKind as ClapErrorKind;
use clap::Parser;
use serde::Serialize;
use shipctl_core::build_info::BuildIdentity;
use shipctl_core::instance::ControlError;
use shipctl_core::module_control::codes::{
    OPERATION_ACCEPTED, OPERATION_INSPECTED, REGISTRY_INSPECTED, REGISTRY_LISTED,
    RUNTIME_DIAGNOSED, RUNTIME_INSPECTED,
};
use shipctl_core::module_control::ModuleOperationKind;
use shipctl_core::state::archive::inspect_archive;

use args::{
    Cli, Command as CliCommand, InstancesCommand, ModulesCommand, OperationsCommand, StateCommand,
    UiCommand,
};
use instances::{StartDisposition, StartRequest};
use output::OutputFormat;

pub const APP_VERSION: &str = env!("SHIPCTL_APP_VERSION");

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

fn run_modules(command: ModulesCommand, output: OutputFormat) -> ExitCode {
    match command {
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
                    emit_success(output, "modules.inspect", REGISTRY_INSPECTED, false, data)
                        .unwrap_or_else(|message| {
                            emit_render_failure(output, "modules.inspect", message)
                        })
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
    match instances::transition_module(
        args.runtime_root.as_deref(),
        args.instance.as_deref(),
        args.module_id,
        if enable {
            ModuleOperationKind::Enable
        } else {
            ModuleOperationKind::Disable
        },
        args.target_revision,
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
            ("modules", "list") => "modules.list",
            ("modules", "inspect") => "modules.inspect",
            ("modules", "diagnose") => "modules.diagnose",
            ("modules", "verify") => "modules.verify",
            ("modules", "enable") => "modules.enable",
            ("modules", "disable") => "modules.disable",
            ("operations", "inspect") => "operations.inspect",
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

fn emit_failure(
    format: OutputFormat,
    operation: &str,
    error: &ControlError,
    usage: bool,
) -> ExitCode {
    match output::failure(format, operation, error) {
        Ok(rendered) => eprintln!("{rendered}"),
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
        assert_eq!(module.target_revision, 12);
        assert_eq!(module.instance.as_deref(), Some("fixture"));

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
