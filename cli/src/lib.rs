mod instances;
mod output;

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use serde::Serialize;
use shipctl_core::build_info::BuildIdentity;
use shipctl_core::instance::ControlError;
use shipctl_core::state::archive::inspect_archive;

use instances::{StartDisposition, StartRequest};
use output::OutputFormat;

pub const APP_VERSION: &str = env!("SHIPCTL_APP_VERSION");

const USAGE: &str = "shipctl [--version [--output json]] | shipctl ui [UI_ARGS...] | shipctl ui start --name <name> [--state-root <path>] [--runtime-root <path>] [--load-state <file>] [--output toon|json] | shipctl instances list [--runtime-root <path>] [--output toon|json] | shipctl instances inspect [<name-or-id>] [--runtime-root <path>] [--output toon|json] | shipctl instances stop [<name-or-id>] [--force] [--runtime-root <path>] [--output toon|json] | shipctl state save --instance <name-or-id> --to <file> [--runtime-root <path>] [--output toon|json] | shipctl state inspect <file> [--output toon|json] | shipctl state verify <file> [--output toon|json]";

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
    let mut args = args.into_iter();
    let _program = args.next();
    let remaining: Vec<OsString> = args.collect();

    if is_version_request(&remaining) {
        print_version(wants_json(&remaining));
        return ExitCode::SUCCESS;
    }
    if remaining.is_empty() {
        return launch_ui_foreground(&[]);
    }

    match remaining[0].to_str() {
        Some("ui") => run_ui(&remaining[1..]),
        Some("instances") => run_instances(&remaining[1..]),
        Some("state") => run_state(&remaining[1..]),
        _ => emit_usage("cli", "Unknown Shipctl command", &remaining),
    }
}

fn run_ui(args: &[OsString]) -> ExitCode {
    if args.first().and_then(|value| value.to_str()) != Some("start") {
        return launch_ui_foreground(args);
    }
    let format = detect_output(args);
    let parsed = match parse_ui_start(&args[1..]) {
        Ok(parsed) => parsed,
        Err(message) => return emit_usage("ui.start", &message, args),
    };
    let ui_path = match resolve_ui_path() {
        Ok(path) => path,
        Err(error) => return emit_failure(parsed.output, "ui.start", &error, false),
    };
    match instances::start(
        &ui_path,
        StartRequest {
            name: parsed.name,
            state_root: parsed.state_root,
            runtime_root: parsed.runtime_root,
            load_state: parsed.load_state,
        },
    ) {
        Ok(StartDisposition::Started(instance)) => emit_success(
            parsed.output,
            "ui.start",
            "control.instance.ready",
            false,
            instance,
        ),
        Ok(StartDisposition::AlreadyReady(instance)) => emit_success(
            parsed.output,
            "ui.start",
            "control.instance.already_ready",
            true,
            instance,
        ),
        Err(error) => Ok(emit_failure(parsed.output, "ui.start", &error, false)),
    }
    .unwrap_or_else(|message| emit_render_failure(format, "ui.start", message))
}

fn run_state(args: &[OsString]) -> ExitCode {
    let Some(command) = args.first().and_then(|value| value.to_str()) else {
        return emit_usage("state", "A state subcommand is required", args);
    };
    let operation = match command {
        "save" => "state.save",
        "inspect" => "state.inspect",
        "verify" => "state.verify",
        _ => return emit_usage("state", "Unknown state subcommand", args),
    };
    let parsed = match parse_state(command, &args[1..]) {
        Ok(parsed) => parsed,
        Err(message) => return emit_usage(operation, &message, args),
    };
    let result = match command {
        "save" => instances::save(
            parsed.runtime_root.as_deref(),
            parsed.selector.as_deref(),
            &parsed.path,
        ),
        "inspect" | "verify" => inspect_archive(&parsed.path),
        _ => unreachable!(),
    };
    match result {
        Ok(data) => emit_success(
            parsed.output,
            operation,
            if command == "save" {
                "state.snapshot.saved"
            } else if command == "verify" {
                "state.snapshot.verified"
            } else {
                "state.snapshot.inspected"
            },
            false,
            data,
        )
        .unwrap_or_else(|message| emit_render_failure(parsed.output, operation, message)),
        Err(error) => emit_failure(parsed.output, operation, &error, false),
    }
}

fn run_instances(args: &[OsString]) -> ExitCode {
    let Some(command) = args.first().and_then(|value| value.to_str()) else {
        return emit_usage("instances", "An instances subcommand is required", args);
    };
    let operation = match command {
        "list" => "instances.list",
        "inspect" => "instances.inspect",
        "stop" => "instances.stop",
        _ => return emit_usage("instances", "Unknown instances subcommand", args),
    };
    let parsed = match parse_instances(command, &args[1..]) {
        Ok(parsed) => parsed,
        Err(message) => return emit_usage(operation, &message, args),
    };

    let rendered = match command {
        "list" => instances::list(parsed.runtime_root.as_deref()).and_then(|data| {
            emit_success(
                parsed.output,
                operation,
                "control.instances.listed",
                false,
                data,
            )
            .map_err(render_error)
        }),
        "inspect" => instances::inspect(parsed.runtime_root.as_deref(), parsed.selector.as_deref())
            .and_then(|data| {
                emit_success(
                    parsed.output,
                    operation,
                    "control.instance.inspected",
                    false,
                    data,
                )
                .map_err(render_error)
            }),
        "stop" => match instances::stop(
            parsed.runtime_root.as_deref(),
            parsed.selector.as_deref(),
            parsed.force,
        ) {
            Ok(data) => emit_success(
                parsed.output,
                operation,
                "control.instance.stopped",
                false,
                data,
            )
            .map_err(render_error),
            Err(error) if error.code.as_str() == "control.instance.absent" => emit_success(
                parsed.output,
                operation,
                "control.instance.already_stopped",
                true,
                StoppedNoOp {
                    selector: parsed
                        .selector
                        .or_else(|| std::env::var("SHIPCTL_INSTANCE_ID").ok())
                        .unwrap_or_else(|| "<sole-live-instance>".to_string()),
                    stopped: false,
                },
            )
            .map_err(render_error),
            Err(error) => Err(error),
        },
        _ => unreachable!(),
    };

    match rendered {
        Ok(code) => code,
        Err(error) => emit_failure(parsed.output, operation, &error, false),
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

struct UiStartArgs {
    name: String,
    state_root: Option<PathBuf>,
    runtime_root: Option<PathBuf>,
    load_state: Option<PathBuf>,
    output: OutputFormat,
}

struct StateArgs {
    selector: Option<String>,
    path: PathBuf,
    runtime_root: Option<PathBuf>,
    output: OutputFormat,
}

struct InstancesArgs {
    selector: Option<String>,
    runtime_root: Option<PathBuf>,
    output: OutputFormat,
    force: bool,
}

fn parse_ui_start(args: &[OsString]) -> Result<UiStartArgs, String> {
    let mut name = None;
    let mut state_root = None;
    let mut runtime_root = None;
    let mut load_state = None;
    let mut output = OutputFormat::Toon;
    let mut index = 0;
    while index < args.len() {
        let argument = unicode(&args[index])?;
        if let Some((flag, inline)) = split_flag(argument) {
            match flag {
                "--name" => name = Some(value(args, &mut index, flag, inline)?),
                "--state-root" => {
                    state_root = Some(PathBuf::from(value(args, &mut index, flag, inline)?))
                }
                "--runtime-root" => {
                    runtime_root = Some(PathBuf::from(value(args, &mut index, flag, inline)?))
                }
                "--load-state" => {
                    let path = PathBuf::from(value(args, &mut index, flag, inline)?);
                    load_state = Some(path.canonicalize().map_err(|error| {
                        format!(
                            "Could not resolve state archive {}: {error}",
                            path.display()
                        )
                    })?);
                }
                "--output" => output = parse_output(&value(args, &mut index, flag, inline)?)?,
                _ => return Err(format!("Unknown ui start option: {argument}")),
            }
        } else {
            return Err(format!("Unexpected ui start argument: {argument}"));
        }
        index += 1;
    }
    Ok(UiStartArgs {
        name: name.ok_or_else(|| "ui start requires --name <name>".to_string())?,
        state_root,
        runtime_root,
        load_state,
        output,
    })
}

fn parse_state(command: &str, args: &[OsString]) -> Result<StateArgs, String> {
    let mut selector = None;
    let mut path = None;
    let mut runtime_root = None;
    let mut output = OutputFormat::Toon;
    let mut index = 0;
    while index < args.len() {
        let argument = unicode(&args[index])?;
        if let Some((flag, inline)) = split_flag(argument) {
            match flag {
                "--instance" if command == "save" => {
                    selector = Some(value(args, &mut index, flag, inline)?)
                }
                "--to" if command == "save" => {
                    path = Some(absolute_path(Path::new(&value(
                        args, &mut index, flag, inline,
                    )?))?)
                }
                "--runtime-root" if command == "save" => {
                    runtime_root = Some(PathBuf::from(value(args, &mut index, flag, inline)?))
                }
                "--output" => output = parse_output(&value(args, &mut index, flag, inline)?)?,
                _ => return Err(format!("Unknown state {command} option: {argument}")),
            }
        } else if command == "save" {
            return Err(format!("Unexpected state save argument: {argument}"));
        } else if path.replace(PathBuf::from(argument)).is_some() {
            return Err(format!("state {command} accepts exactly one archive path"));
        }
        index += 1;
    }
    let path = path.ok_or_else(|| match command {
        "save" => "state save requires --to <file>".to_string(),
        _ => format!("state {command} requires an archive path"),
    })?;
    if command == "save" && selector.is_none() {
        return Err("state save requires --instance <name-or-id>".to_string());
    }
    let path = if command == "save" {
        path
    } else {
        path.canonicalize().map_err(|error| {
            format!(
                "Could not resolve state archive {}: {error}",
                path.display()
            )
        })?
    };
    Ok(StateArgs {
        selector,
        path,
        runtime_root,
        output,
    })
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

fn parse_instances(command: &str, args: &[OsString]) -> Result<InstancesArgs, String> {
    let mut selector = None;
    let mut runtime_root = None;
    let mut output = OutputFormat::Toon;
    let mut force = false;
    let mut index = 0;
    while index < args.len() {
        let argument = unicode(&args[index])?;
        if let Some((flag, inline)) = split_flag(argument) {
            match flag {
                "--runtime-root" => {
                    runtime_root = Some(PathBuf::from(value(args, &mut index, flag, inline)?))
                }
                "--output" => output = parse_output(&value(args, &mut index, flag, inline)?)?,
                "--force" if command == "stop" && inline.is_none() => force = true,
                _ => return Err(format!("Unknown {command} option: {argument}")),
            }
        } else if command == "list" {
            return Err(format!("Unexpected list argument: {argument}"));
        } else if selector.replace(argument.to_string()).is_some() {
            return Err(format!("{command} accepts at most one instance selector"));
        }
        index += 1;
    }
    Ok(InstancesArgs {
        selector,
        runtime_root,
        output,
        force,
    })
}

fn split_flag(argument: &str) -> Option<(&str, Option<&str>)> {
    if !argument.starts_with('-') {
        return None;
    }
    Some(
        argument
            .split_once('=')
            .map_or((argument, None), |(flag, value)| (flag, Some(value))),
    )
}

fn value(
    args: &[OsString],
    index: &mut usize,
    flag: &str,
    inline: Option<&str>,
) -> Result<String, String> {
    match inline {
        Some(value) if !value.is_empty() => Ok(value.to_string()),
        Some(_) => Err(format!("{flag} requires a value")),
        None => {
            *index += 1;
            args.get(*index)
                .ok_or_else(|| format!("{flag} requires a value"))
                .and_then(|value| unicode(value).map(str::to_string))
        }
    }
}

fn unicode(value: &OsString) -> Result<&str, String> {
    value
        .to_str()
        .ok_or_else(|| "Shipctl command arguments must be valid Unicode".to_string())
}

fn parse_output(value: &str) -> Result<OutputFormat, String> {
    match value {
        "toon" => Ok(OutputFormat::Toon),
        "json" => Ok(OutputFormat::Json),
        _ => Err("--output must be toon or json".to_string()),
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

fn emit_usage(operation: &str, message: &str, args: &[OsString]) -> ExitCode {
    let error = ControlError::new("cli.usage", message)
        .with_expected_observed(USAGE, format!("{:?}", args));
    emit_failure(detect_output(args), operation, &error, true)
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

fn is_version_request(args: &[OsString]) -> bool {
    matches!(
        args.first().and_then(|arg| arg.to_str()),
        Some("--version" | "version")
    )
}

fn wants_json(args: &[OsString]) -> bool {
    args.windows(2)
        .any(|pair| pair[0] == OsStr::new("--output") && pair[1] == OsStr::new("json"))
}

fn print_version(json: bool) {
    let identity = BuildIdentity::new("cli", APP_VERSION);
    if json {
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
    fn parses_agent_instance_commands_without_prompts() {
        let parsed = parse_ui_start(&[
            "--name".into(),
            "alpha".into(),
            "--state-root=/tmp/alpha".into(),
            "--runtime-root".into(),
            "/tmp/runtime".into(),
            "--output".into(),
            "json".into(),
        ])
        .unwrap();
        assert_eq!(parsed.name, "alpha");
        assert_eq!(parsed.output, OutputFormat::Json);

        let parsed = parse_instances(
            "stop",
            &["alpha".into(), "--force".into(), "--output=toon".into()],
        )
        .unwrap();
        assert_eq!(parsed.selector.as_deref(), Some("alpha"));
        assert!(parsed.force);
    }

    #[test]
    fn parses_state_archive_commands_and_restore_start() {
        let archive = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let archive_text = archive.to_string_lossy().into_owned();

        let save = parse_state(
            "save",
            &[
                "--instance=alpha".into(),
                "--to".into(),
                "/tmp/alpha.shipctl-state".into(),
                "--runtime-root=/tmp/runtime".into(),
                "--output=json".into(),
            ],
        )
        .unwrap();
        assert_eq!(save.selector.as_deref(), Some("alpha"));
        assert_eq!(save.path, Path::new("/tmp/alpha.shipctl-state"));
        assert_eq!(save.output, OutputFormat::Json);

        let inspect = parse_state("inspect", &[archive_text.clone().into()]).unwrap();
        assert_eq!(inspect.path, archive.canonicalize().unwrap());

        let start = parse_ui_start(&[
            "--name=restored".into(),
            format!("--load-state={archive_text}").into(),
        ])
        .unwrap();
        assert_eq!(start.load_state, Some(archive.canonicalize().unwrap()));
    }

    #[test]
    fn app_version_is_compiled_from_the_tauri_source_of_truth() {
        assert_ne!(APP_VERSION, "0.0.0");
    }
}
