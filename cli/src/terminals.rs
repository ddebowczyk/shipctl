use std::env;
use std::io::{self, Read, Write};
use std::process::ExitCode;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::Serialize;
use shipctl_core::instance::{
    ControlError, TerminalControlEvent, TERMINAL_CONTROL_WRITE_MAX_BYTES,
};
use shipctl_core::terminal::{
    TerminalAgentReportRequest, TerminalAgentReportSource, TerminalDescriptor, TerminalId,
    TerminalLifecycle,
};

use crate::args::{TerminalAttachArgs, TerminalReportArgs, TerminalWriteArgs, TerminalsCommand};
use crate::output::OutputFormat;

const TERMINALS_LISTED: &str = "terminal.control.listed";
const TERMINAL_INSPECTED: &str = "terminal.control.inspected";
const TERMINAL_WRITTEN: &str = "terminal.control.written";
const TERMINAL_AGENT_REPORTED: &str = "terminal.agent.reported";
const TERMINAL_CLOSED: &str = "terminal.control.closed";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalListView {
    count: usize,
    terminals: Vec<TerminalSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSummary {
    id: TerminalId,
    label: String,
    lifecycle: TerminalLifecycle,
    cwd: String,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case", tag = "type", content = "value")]
enum StreamRecord<'a> {
    Attachment(&'a shipctl_core::instance::TerminalAttachmentState),
    Event(&'a TerminalControlEvent),
    Error(&'a ControlError),
}

pub fn run(command: TerminalsCommand, output: OutputFormat) -> ExitCode {
    match command {
        TerminalsCommand::List(args) => {
            let operation = "terminals.list";
            match crate::instances::list_terminals(
                args.runtime.runtime_root.as_deref(),
                &args.instance,
            ) {
                Ok(result) => {
                    let data = TerminalListView {
                        count: result.count,
                        terminals: result.terminals.into_iter().map(summary).collect(),
                    };
                    crate::emit_success(output, operation, TERMINALS_LISTED, data.count == 0, data)
                        .unwrap_or_else(|message| {
                            crate::emit_render_failure(output, operation, message)
                        })
                }
                Err(error) => crate::emit_failure(output, operation, &error, false),
            }
        }
        TerminalsCommand::Get(args) => {
            let operation = "terminals.get";
            match crate::instances::get_terminal(
                args.target.runtime.runtime_root.as_deref(),
                &args.target.instance,
                args.terminal_id,
            ) {
                Ok(descriptor) => {
                    crate::emit_success(output, operation, TERMINAL_INSPECTED, false, descriptor)
                        .unwrap_or_else(|message| {
                            crate::emit_render_failure(output, operation, message)
                        })
                }
                Err(error) => crate::emit_failure(output, operation, &error, false),
            }
        }
        TerminalsCommand::Write(args) => run_write(args, output),
        TerminalsCommand::Report(args) => run_report(args, output),
        TerminalsCommand::Close(args) => {
            let operation = "terminals.close";
            match crate::instances::close_terminal(
                args.target.runtime.runtime_root.as_deref(),
                &args.target.instance,
                args.terminal_id,
            ) {
                Ok(result) => {
                    crate::emit_success(output, operation, TERMINAL_CLOSED, !result.existed, result)
                        .unwrap_or_else(|message| {
                            crate::emit_render_failure(output, operation, message)
                        })
                }
                Err(error) => crate::emit_failure(output, operation, &error, false),
            }
        }
        TerminalsCommand::Attach(args) => run_attach(args),
    }
}

fn run_report(args: TerminalReportArgs, output: OutputFormat) -> ExitCode {
    let operation = "terminals.report";
    let (terminal_id, instance) = match resolve_report_target(
        args.terminal_id,
        args.instance,
        env::var("SHIPCTL_TERMINAL_ID").ok().as_deref(),
        env::var("SHIPCTL_INSTANCE_ID").ok().as_deref(),
    ) {
        Ok(target) => target,
        Err(error) => return crate::emit_failure(output, operation, &error, false),
    };
    let report = TerminalAgentReportRequest {
        terminal_id,
        kind: args.kind.into(),
        source: TerminalAgentReportSource {
            identifier: args.source,
            version: args.source_version,
        },
        message: args.message,
    };
    match crate::instances::report_terminal_agent(
        args.runtime.runtime_root.as_deref(),
        &instance,
        report,
    ) {
        Ok(result) => {
            crate::emit_success(output, operation, TERMINAL_AGENT_REPORTED, false, result)
                .unwrap_or_else(|message| crate::emit_render_failure(output, operation, message))
        }
        Err(error) => crate::emit_failure(output, operation, &error, false),
    }
}

fn resolve_report_target(
    terminal_id: Option<TerminalId>,
    instance: Option<String>,
    environment_terminal_id: Option<&str>,
    environment_instance: Option<&str>,
) -> Result<(TerminalId, String), ControlError> {
    let terminal_id = match terminal_id {
        Some(terminal_id) => terminal_id,
        None => environment_terminal_id
            .ok_or_else(|| {
                ControlError::new(
                    "cli.usage",
                    "Pass --terminal-id or run inside a Shipctl-hosted terminal",
                )
            })?
            .parse()
            .map_err(|_| {
                ControlError::new(
                    "terminal.id.invalid",
                    "SHIPCTL_TERMINAL_ID is not a valid terminal UUID",
                )
            })?,
    };
    let instance = instance
        .or_else(|| environment_instance.map(str::to_owned))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            ControlError::new(
                "cli.usage",
                "Pass --instance or run inside a Shipctl-hosted terminal",
            )
        })?;
    Ok((terminal_id, instance))
}

fn summary(descriptor: TerminalDescriptor) -> TerminalSummary {
    TerminalSummary {
        id: descriptor.id,
        label: descriptor.metadata.label,
        lifecycle: descriptor.lifecycle,
        cwd: descriptor.metadata.cwd.display().to_string(),
    }
}

fn run_write(args: TerminalWriteArgs, output: OutputFormat) -> ExitCode {
    let operation = "terminals.write";
    let data = match terminal_input(&args) {
        Ok(data) => data,
        Err(error) => return crate::emit_failure(output, operation, &error, false),
    };
    match crate::instances::write_terminal(
        args.target.runtime.runtime_root.as_deref(),
        &args.target.instance,
        args.terminal_id,
        &data,
    ) {
        Ok(result) => crate::emit_success(
            output,
            operation,
            TERMINAL_WRITTEN,
            result.accepted_bytes == 0,
            result,
        )
        .unwrap_or_else(|message| crate::emit_render_failure(output, operation, message)),
        Err(error) => crate::emit_failure(output, operation, &error, false),
    }
}

fn terminal_input(args: &TerminalWriteArgs) -> Result<Vec<u8>, ControlError> {
    let data = match (&args.data, &args.base64, args.stdin) {
        (Some(data), None, false) => data.as_bytes().to_vec(),
        (None, Some(data), false) => BASE64_STANDARD.decode(data).map_err(|error| {
            ControlError::new(
                "terminal.input.invalid_base64",
                format!("--base64 is not valid standard base64: {error}"),
            )
        })?,
        (None, None, true) => {
            let mut data = Vec::new();
            io::stdin()
                .take((TERMINAL_CONTROL_WRITE_MAX_BYTES + 1) as u64)
                .read_to_end(&mut data)
                .map_err(|error| {
                    ControlError::new(
                        "terminal.input.stdin_failed",
                        format!("Could not read terminal bytes from stdin: {error}"),
                    )
                })?;
            data
        }
        _ => {
            return Err(ControlError::new(
                "cli.usage",
                "Exactly one of --data, --base64, or --stdin is required",
            ));
        }
    };
    if data.len() > TERMINAL_CONTROL_WRITE_MAX_BYTES {
        return Err(ControlError::new(
            "terminal.input.too_large",
            format!(
                "Terminal input exceeds the established {TERMINAL_CONTROL_WRITE_MAX_BYTES}-byte flow-control budget"
            ),
        ));
    }
    Ok(data)
}

fn run_attach(args: TerminalAttachArgs) -> ExitCode {
    let mut attachment = match crate::instances::attach_terminal(
        args.target.runtime.runtime_root.as_deref(),
        &args.target.instance,
        args.terminal_id,
    ) {
        Ok(attachment) => attachment,
        Err(error) => {
            if args.raw {
                render_raw_error(&error);
                return ExitCode::FAILURE;
            }
            return render_stream_error(&error);
        }
    };

    if args.raw {
        if let Err(error) = write_raw_replay(attachment.state().replay.data_base64.as_str()) {
            render_raw_error(&error);
            return ExitCode::FAILURE;
        }
    } else if let Err(error) = print_stream_record(&StreamRecord::Attachment(attachment.state())) {
        return render_stream_error(&error);
    }

    loop {
        let event = match attachment.next_event() {
            Ok(Some(event)) => event,
            Ok(None) => return ExitCode::SUCCESS,
            Err(error) => {
                if args.raw {
                    render_raw_error(&error);
                    return ExitCode::FAILURE;
                }
                return render_stream_error(&error);
            }
        };
        let result = if args.raw {
            write_raw_event(&event)
        } else {
            print_stream_record(&StreamRecord::Event(&event))
        };
        if let Err(error) = result {
            if args.raw {
                render_raw_error(&error);
                return ExitCode::FAILURE;
            }
            return render_stream_error(&error);
        }
    }
}

fn print_stream_record(record: &StreamRecord<'_>) -> Result<(), ControlError> {
    let rendered = serde_json::to_string(record).map_err(|error| {
        ControlError::new(
            "cli.render_failed",
            format!("Could not encode terminal NDJSON: {error}"),
        )
    })?;
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{rendered}")
        .and_then(|()| stdout.flush())
        .map_err(|error| {
            ControlError::new(
                "terminal.attach.output_failed",
                format!("Could not write the terminal attachment stream: {error}"),
            )
        })
}

fn write_raw_replay(data_base64: &str) -> Result<(), ControlError> {
    let bytes = decode_server_bytes(data_base64)?;
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(&bytes)
        .and_then(|()| stdout.flush())
        .map_err(|error| {
            ControlError::new(
                "terminal.attach.output_failed",
                format!("Could not write terminal bytes to stdout: {error}"),
            )
        })
}

fn write_raw_event(event: &TerminalControlEvent) -> Result<(), ControlError> {
    match event {
        TerminalControlEvent::Output { data_base64, .. } => write_raw_replay(data_base64),
        TerminalControlEvent::Replay { replay, .. } => write_raw_replay(&replay.data_base64),
        TerminalControlEvent::Exited { descriptor, .. } => {
            if let Some(exit) = &descriptor.exit {
                eprintln!(
                    "terminal exited: reason={:?} code={:?}",
                    exit.reason, exit.code
                );
            }
            Ok(())
        }
        TerminalControlEvent::ResyncRequired { reason, .. }
        | TerminalControlEvent::Detached { reason, .. } => {
            eprintln!("terminal attachment ended: {reason}");
            Ok(())
        }
        TerminalControlEvent::MetadataChanged { .. }
        | TerminalControlEvent::AgentActivityChanged { .. } => Ok(()),
    }
}

fn decode_server_bytes(data_base64: &str) -> Result<Vec<u8>, ControlError> {
    BASE64_STANDARD.decode(data_base64).map_err(|error| {
        ControlError::new(
            "control.instance.handshake_failed",
            format!("The terminal stream contains invalid base64: {error}"),
        )
    })
}

fn render_stream_error(error: &ControlError) -> ExitCode {
    if print_stream_record(&StreamRecord::Error(error)).is_err() {
        render_raw_error(error);
    }
    ExitCode::FAILURE
}

fn render_raw_error(error: &ControlError) {
    let rendered = serde_json::to_string(error)
        .unwrap_or_else(|_| "{\"code\":\"cli.render_failed\"}".to_string());
    eprintln!("{rendered}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::args::{RuntimeRootArgs, TerminalTargetArgs};

    fn write_args(data: Option<&str>, base64: Option<&str>) -> TerminalWriteArgs {
        TerminalWriteArgs {
            terminal_id: "00000000-0000-4000-8000-000000000001".parse().unwrap(),
            data: data.map(str::to_owned),
            base64: base64.map(str::to_owned),
            stdin: false,
            target: TerminalTargetArgs {
                instance: "test-instance".to_string(),
                runtime: RuntimeRootArgs { runtime_root: None },
            },
        }
    }

    #[test]
    fn terminal_input_preserves_literal_and_base64_bytes_exactly() {
        let literal = write_args(Some("literal\\nnot-an-escape"), None);
        assert_eq!(
            terminal_input(&literal).unwrap(),
            b"literal\\nnot-an-escape"
        );

        let encoded = BASE64_STANDARD.encode([0, 0xff, b'\n', b'\\']);
        let base64 = write_args(None, Some(&encoded));
        assert_eq!(terminal_input(&base64).unwrap(), [0, 0xff, b'\n', b'\\']);
    }

    #[test]
    fn terminal_input_rejects_invalid_base64_and_the_established_byte_budget() {
        let invalid = terminal_input(&write_args(None, Some("not base64!"))).unwrap_err();
        assert_eq!(invalid.code.as_str(), "terminal.input.invalid_base64");

        let oversized = "x".repeat(TERMINAL_CONTROL_WRITE_MAX_BYTES + 1);
        let error = terminal_input(&write_args(Some(&oversized), None)).unwrap_err();
        assert_eq!(error.code.as_str(), "terminal.input.too_large");
    }

    #[test]
    fn streaming_record_is_one_self_contained_json_line() {
        let error = ControlError::new("terminal.test", "line framing");
        let rendered = serde_json::to_string(&StreamRecord::Error(&error)).unwrap();
        assert!(!rendered.contains('\n'));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&rendered).unwrap()["type"],
            "error"
        );
    }

    #[test]
    fn report_target_uses_explicit_values_before_host_environment() {
        let explicit_terminal: TerminalId = "00000000-0000-4000-8000-000000000001".parse().unwrap();
        let (terminal_id, instance) = resolve_report_target(
            Some(explicit_terminal),
            Some("explicit".to_string()),
            Some("00000000-0000-4000-8000-000000000002"),
            Some("environment"),
        )
        .unwrap();
        assert_eq!(terminal_id, explicit_terminal);
        assert_eq!(instance, "explicit");
    }

    #[test]
    fn report_target_resolves_host_environment_and_rejects_missing_or_invalid_values() {
        let (terminal_id, instance) = resolve_report_target(
            None,
            None,
            Some("00000000-0000-4000-8000-000000000003"),
            Some("host-instance"),
        )
        .unwrap();
        assert_eq!(
            terminal_id,
            "00000000-0000-4000-8000-000000000003".parse().unwrap()
        );
        assert_eq!(instance, "host-instance");

        assert_eq!(
            resolve_report_target(None, None, None, Some("instance"))
                .unwrap_err()
                .code
                .as_str(),
            "cli.usage"
        );
        assert_eq!(
            resolve_report_target(None, None, Some("secret-invalid-value"), Some("instance"))
                .unwrap_err()
                .code
                .as_str(),
            "terminal.id.invalid"
        );
    }

    #[test]
    fn finite_report_result_exposes_authoritative_identity_state_source_and_time() {
        let terminal_id: TerminalId = "00000000-0000-4000-8000-000000000004".parse().unwrap();
        let rendered = serde_json::to_value(shipctl_core::instance::TerminalAgentReportResult {
            terminal_id,
            activity: shipctl_core::terminal::TerminalAgentActivity {
                revision: 9,
                state: shipctl_core::terminal::TerminalAgentState::Blocked,
                message: Some("waiting".to_string()),
                updated_at_ms: 42,
                source: TerminalAgentReportSource {
                    identifier: "codex".to_string(),
                    version: "1".to_string(),
                },
                attention: Some(shipctl_core::terminal::TerminalAgentAttention {
                    kind: shipctl_core::terminal::TerminalAgentAttentionKind::Blocked,
                    revision: 9,
                }),
            },
        })
        .unwrap();

        assert_eq!(rendered["terminalId"], terminal_id.to_string());
        assert_eq!(rendered["activity"]["state"], "blocked");
        assert_eq!(rendered["activity"]["revision"], 9);
        assert_eq!(rendered["activity"]["source"]["identifier"], "codex");
        assert_eq!(rendered["activity"]["updatedAtMs"], 42);
    }
}
