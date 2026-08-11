use std::env;
use std::io::{self, Read, Write};
use std::process::ExitCode;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::Serialize;
use shipctl_core::instance::{
    ControlError, TerminalControlEvent, TERMINAL_CONTROL_WRITE_MAX_BYTES,
};
use shipctl_core::terminal::input::TerminalInput;
use shipctl_core::terminal::painter;
use shipctl_core::terminal::projection::{
    ProjectedPoint, ProjectedRow, TerminalAnchorId, TerminalProjection,
};
use shipctl_core::terminal::{
    TerminalAgentReportRequest, TerminalAgentReportSource, TerminalDescriptor, TerminalId,
    TerminalLifecycle, TerminalTransport,
};

use crate::args::{
    TerminalAnchorArgs, TerminalAnchorIdArgs, TerminalAttachArgs, TerminalHistoryArgs,
    TerminalInputArgs, TerminalInspectArgs, TerminalReportArgs, TerminalWriteArgs,
    TerminalsCommand,
};
use crate::output::OutputFormat;

const TERMINALS_LISTED: &str = "terminal.control.listed";
const TERMINAL_INSPECTED: &str = "terminal.control.inspected";
const TERMINAL_PROJECTED: &str = "terminal.control.projected";
const TERMINAL_HISTORY_READ: &str = "terminal.control.history_read";
const TERMINAL_ANCHORED: &str = "terminal.control.anchored";
const TERMINAL_ANCHOR_RESOLVED: &str = "terminal.control.anchor_resolved";
const TERMINAL_ANCHOR_RELEASED: &str = "terminal.control.anchor_released";
const TERMINAL_WRITTEN: &str = "terminal.control.written";
const TERMINAL_INPUT_ENCODED: &str = "terminal.control.input_encoded";
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
        TerminalsCommand::Inspect(args) => run_inspect(args, output),
        TerminalsCommand::History(args) => run_history(args, output),
        TerminalsCommand::Anchor(args) => run_anchor(args, output),
        TerminalsCommand::ResolveAnchor(args) => run_resolve_anchor(args, output),
        TerminalsCommand::ReleaseAnchor(args) => run_release_anchor(args, output),
        TerminalsCommand::Write(args) => run_write(args, output),
        TerminalsCommand::Input(args) => run_input(args, output),
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

fn run_inspect(args: TerminalInspectArgs, output: OutputFormat) -> ExitCode {
    let operation = "terminals.inspect";
    let result = crate::instances::inspect_terminal(
        args.target.runtime.runtime_root.as_deref(),
        &args.target.instance,
        args.terminal_id,
    );
    let result = match result {
        Ok(result) => result,
        Err(error) => return crate::emit_failure(output, operation, &error, false),
    };
    if args.text {
        return print_viewport_text(&result.projection);
    }
    crate::emit_success(output, operation, TERMINAL_PROJECTED, false, result)
        .unwrap_or_else(|message| crate::emit_render_failure(output, operation, message))
}

/// Renders the viewport the way a reader sees it: one line per row, with the
/// padding the grid stores on the right of each row removed.
fn print_viewport_text(projection: &TerminalProjection) -> ExitCode {
    print_rows_text(&projection.viewport)
}

/// Rows as a reader sees them. History rows and viewport rows are the same
/// kind of row, which is why one renderer serves both.
fn print_rows_text(rows: &[ProjectedRow]) -> ExitCode {
    let mut stdout = io::stdout().lock();
    for row in rows {
        if writeln!(stdout, "{}", row.text().trim_end()).is_err() {
            return ExitCode::FAILURE;
        }
    }
    if stdout.flush().is_err() {
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

/// Read the rows behind the viewport.
///
/// An empty window is not a failure: history shrinks whenever the terminal
/// evicts, so a request that runs past what the host still keeps answers with
/// the rows that exist. It is reported as an empty result the way an empty
/// list is.
fn run_history(args: TerminalHistoryArgs, output: OutputFormat) -> ExitCode {
    let operation = "terminals.history";
    let result = crate::instances::history_terminal(
        args.target.runtime.runtime_root.as_deref(),
        &args.target.instance,
        args.terminal_id,
        args.start_row,
        args.rows,
    );
    let result = match result {
        Ok(result) => result,
        Err(error) => return crate::emit_failure(output, operation, &error, false),
    };
    if args.text {
        return print_rows_text(&result.window.rows);
    }
    let empty = result.window.rows.is_empty();
    crate::emit_success(output, operation, TERMINAL_HISTORY_READ, empty, result)
        .unwrap_or_else(|message| crate::emit_render_failure(output, operation, message))
}

/// Pin one cell.
///
/// The handle this prints outlives the row number the caller pinned: the host
/// moves the pin with its line through scrolling, eviction and reflow. It also
/// outlives this process, so a caller that wants the host to stop tracking it
/// releases it.
fn run_anchor(args: TerminalAnchorArgs, output: OutputFormat) -> ExitCode {
    let operation = "terminals.anchor";
    let result = crate::instances::anchor_terminal(
        args.target.runtime.runtime_root.as_deref(),
        &args.target.instance,
        args.terminal_id,
        args.space.into(),
        ProjectedPoint {
            column: args.column,
            row: args.row,
        },
    );
    match result {
        Ok(result) => crate::emit_success(output, operation, TERMINAL_ANCHORED, false, result)
            .unwrap_or_else(|message| crate::emit_render_failure(output, operation, message)),
        Err(error) => crate::emit_failure(output, operation, &error, false),
    }
}

/// Read where an anchored line is now.
///
/// A handle the host does not hold is reported as an empty result rather than
/// a failure: an anchor that was released, or that belonged to a terminal that
/// has since restarted, is a fact about the caller's handle.
fn run_resolve_anchor(args: TerminalAnchorIdArgs, output: OutputFormat) -> ExitCode {
    let operation = "terminals.resolve-anchor";
    let result = crate::instances::resolve_terminal_anchor(
        args.target.runtime.runtime_root.as_deref(),
        &args.target.instance,
        args.terminal_id,
        TerminalAnchorId(args.anchor),
    );
    match result {
        Ok(result) => {
            let empty = result.anchor.is_none();
            crate::emit_success(output, operation, TERMINAL_ANCHOR_RESOLVED, empty, result)
                .unwrap_or_else(|message| crate::emit_render_failure(output, operation, message))
        }
        Err(error) => crate::emit_failure(output, operation, &error, false),
    }
}

/// Drop an anchor. Releasing one the host does not hold is a successful no-op,
/// the way closing an already closed terminal is.
fn run_release_anchor(args: TerminalAnchorIdArgs, output: OutputFormat) -> ExitCode {
    let operation = "terminals.release-anchor";
    let result = crate::instances::release_terminal_anchor(
        args.target.runtime.runtime_root.as_deref(),
        &args.target.instance,
        args.terminal_id,
        TerminalAnchorId(args.anchor),
    );
    match result {
        Ok(result) => {
            let empty = !result.released;
            crate::emit_success(output, operation, TERMINAL_ANCHOR_RELEASED, empty, result)
                .unwrap_or_else(|message| crate::emit_render_failure(output, operation, message))
        }
        Err(error) => crate::emit_failure(output, operation, &error, false),
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

/// Report what a person did. The host answers with the bytes its current
/// modes made of it, and zero of them is an answer: a pointer move with no
/// tracking on reports nothing.
fn run_input(args: TerminalInputArgs, output: OutputFormat) -> ExitCode {
    let operation = "terminals.input";
    let input = match semantic_input(&args) {
        Ok(input) => input,
        Err(error) => return crate::emit_failure(output, operation, &error, false),
    };
    match crate::instances::input_terminal(
        args.target.runtime.runtime_root.as_deref(),
        &args.target.instance,
        args.terminal_id,
        input,
    ) {
        Ok(result) => crate::emit_success(
            output,
            operation,
            TERMINAL_INPUT_ENCODED,
            result.encoded_bytes == 0,
            result,
        )
        .unwrap_or_else(|message| crate::emit_render_failure(output, operation, message)),
        Err(error) => crate::emit_failure(output, operation, &error, false),
    }
}

fn semantic_input(args: &TerminalInputArgs) -> Result<TerminalInput, ControlError> {
    let text = match (&args.json, args.stdin) {
        (Some(text), false) => text.clone(),
        (None, true) => {
            let mut text = String::new();
            io::stdin().read_to_string(&mut text).map_err(|error| {
                ControlError::new(
                    "terminal.input.stdin_failed",
                    format!("Could not read the semantic input from stdin: {error}"),
                )
            })?;
            text
        }
        _ => {
            return Err(ControlError::new(
                "cli.usage",
                "Exactly one of --json or --stdin is required",
            ));
        }
    };
    serde_json::from_str(&text).map_err(|error| {
        ControlError::new(
            "terminal.input.invalid",
            format!("The semantic input is not one this host understands: {error}"),
        )
    })
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
    let encoding = TerminalTransport::from(args.encoding);
    let mut attachment = match crate::instances::attach_terminal(
        args.target.runtime.runtime_root.as_deref(),
        &args.target.instance,
        args.terminal_id,
        encoding,
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
        let baseline = raw_baseline(
            encoding,
            &attachment.state().replay.data_base64,
            attachment.state().state.as_deref(),
        );
        if let Err(error) = baseline.and_then(|bytes| write_raw_bytes(&bytes)) {
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
            write_raw_event(encoding, &event)
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

/// The bytes that put the caller's terminal into the state the attachment
/// starts from.
///
/// The host answers in the encoding the attachment asked for, so a baseline
/// missing the state a semantic attachment requested is a disagreement about
/// the encoding, not a frame to skip.
fn raw_baseline(
    encoding: TerminalTransport,
    replay_base64: &str,
    state: Option<&shipctl_core::terminal::wire::TerminalScreenSnapshot>,
) -> Result<Vec<u8>, ControlError> {
    match encoding {
        TerminalTransport::Legacy => decode_server_bytes(replay_base64),
        TerminalTransport::Semantic => match state {
            Some(snapshot) => Ok(painter::paint_snapshot(snapshot)),
            None => Err(ControlError::new(
                "terminal.attach.event_invalid",
                "The semantic terminal attachment was given no state to start from",
            )),
        },
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

fn write_raw_bytes(bytes: &[u8]) -> Result<(), ControlError> {
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(bytes)
        .and_then(|()| stdout.flush())
        .map_err(|error| {
            ControlError::new(
                "terminal.attach.output_failed",
                format!("Could not write terminal bytes to stdout: {error}"),
            )
        })
}

fn write_raw_event(
    encoding: TerminalTransport,
    event: &TerminalControlEvent,
) -> Result<(), ControlError> {
    match raw_event(encoding, event)? {
        Some(bytes) => write_raw_bytes(&bytes),
        None => Ok(()),
    }
}

/// What one event puts on the caller's terminal, or nothing when the event
/// changes no picture.
///
/// Each encoding refuses the other's frames. A byte frame on a semantic
/// attachment, or a screen frame on a byte one, means the host sent an encoding
/// this attachment did not ask for, and rendering it anyway would make the
/// caller's terminal a second authority over what the screen holds.
fn raw_event(
    encoding: TerminalTransport,
    event: &TerminalControlEvent,
) -> Result<Option<Vec<u8>>, ControlError> {
    let semantic = encoding == TerminalTransport::Semantic;
    match event {
        TerminalControlEvent::Output { data_base64, .. } if !semantic => {
            decode_server_bytes(data_base64).map(Some)
        }
        TerminalControlEvent::Replay { replay, .. } if !semantic => {
            decode_server_bytes(&replay.data_base64).map(Some)
        }
        TerminalControlEvent::Screen { state, .. } if semantic => {
            Ok(Some(painter::paint_snapshot(state)))
        }
        TerminalControlEvent::Effects { effects, .. } if semantic => {
            Ok(Some(painter::paint_effects(effects)))
        }
        TerminalControlEvent::Output { .. }
        | TerminalControlEvent::Replay { .. }
        | TerminalControlEvent::Screen { .. }
        | TerminalControlEvent::Effects { .. } => Err(ControlError::new(
            "terminal.attach.event_invalid",
            "The terminal attachment received the encoding it did not ask for",
        )),
        TerminalControlEvent::Exited { descriptor, .. } => {
            if let Some(exit) = &descriptor.exit {
                eprintln!(
                    "terminal exited: reason={:?} code={:?}",
                    exit.reason, exit.code
                );
            }
            Ok(None)
        }
        TerminalControlEvent::ResyncRequired { reason, .. }
        | TerminalControlEvent::Detached { reason, .. } => {
            eprintln!("terminal attachment ended: {reason}");
            Ok(None)
        }
        TerminalControlEvent::MetadataChanged { .. }
        | TerminalControlEvent::AgentActivityChanged { .. } => Ok(None),
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
    use std::sync::Arc;

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

    fn input_args(json: Option<&str>) -> TerminalInputArgs {
        TerminalInputArgs {
            terminal_id: "00000000-0000-4000-8000-000000000001".parse().unwrap(),
            json: json.map(str::to_owned),
            stdin: false,
            target: TerminalTargetArgs {
                instance: "test-instance".to_string(),
                runtime: RuntimeRootArgs { runtime_root: None },
            },
        }
    }

    /// The CLI carries meaning through untouched. It names no bytes of its
    /// own, and an event this host cannot read fails here rather than
    /// reaching the terminal as something else.
    #[test]
    fn a_semantic_input_crosses_the_cli_as_meaning_or_not_at_all() {
        let key = input_args(Some(
            r#"{"kind":"key","action":"press","code":"ArrowUp","mods":{"ctrl":true}}"#,
        ));
        assert_eq!(
            semantic_input(&key).unwrap(),
            TerminalInput::Key(shipctl_core::terminal::input::TerminalKeyEvent {
                action: shipctl_core::terminal::input::TerminalKeyAction::Press,
                code: "ArrowUp".to_string(),
                text: None,
                mods: shipctl_core::terminal::input::TerminalModifiers {
                    ctrl: true,
                    ..Default::default()
                },
                composing: false,
            })
        );

        let paste = input_args(Some(r#"{"kind":"paste","text":"pasted"}"#));
        assert_eq!(
            semantic_input(&paste).unwrap(),
            TerminalInput::Paste {
                text: "pasted".to_string()
            }
        );

        let unknown = input_args(Some(r#"{"kind":"telepathy"}"#));
        assert_eq!(
            semantic_input(&unknown).unwrap_err().code.as_str(),
            "terminal.input.invalid"
        );

        let neither = input_args(None);
        assert_eq!(
            semantic_input(&neither).unwrap_err().code.as_str(),
            "cli.usage"
        );
    }

    fn screen_event(
        state: Arc<shipctl_core::terminal::wire::TerminalScreenSnapshot>,
    ) -> TerminalControlEvent {
        TerminalControlEvent::Screen {
            terminal_id: TerminalId::default(),
            attachment_id: Default::default(),
            sequence: 3,
            revision: shipctl_core::terminal::TerminalRevision(4),
            state,
        }
    }

    fn effects_event() -> TerminalControlEvent {
        TerminalControlEvent::Effects {
            terminal_id: TerminalId::default(),
            attachment_id: Default::default(),
            sequence: 4,
            effects: vec![shipctl_core::terminal::effects::TerminalEffect::Bell],
        }
    }

    fn sample_state() -> Arc<shipctl_core::terminal::wire::TerminalScreenSnapshot> {
        match shipctl_core::terminal::contract::sample_event(
            shipctl_core::terminal::contract::TerminalEventKind::Screen,
        ) {
            shipctl_core::terminal::TerminalEvent::Screen { state, .. } => state,
            other => panic!("the screen sample is a screen event, got {other:?}"),
        }
    }

    /// The semantic path presents what the host holds, with no access to the
    /// bytes that produced it and no base64 anywhere in the attachment.
    #[test]
    fn a_semantic_attachment_paints_state_and_its_occurrences() {
        let state = sample_state();
        let expected_row = state.viewport[0].text().trim_end().to_string();
        assert!(
            !expected_row.is_empty(),
            "the sample must put something on screen for this test to mean anything"
        );

        let baseline = raw_baseline(TerminalTransport::Semantic, "", Some(&state)).unwrap();
        assert!(String::from_utf8_lossy(&baseline).contains(&expected_row));

        let painted = raw_event(TerminalTransport::Semantic, &screen_event(state))
            .unwrap()
            .expect("a screen frame changes the picture");
        assert!(String::from_utf8_lossy(&painted).contains(&expected_row));

        let effects = raw_event(TerminalTransport::Semantic, &effects_event())
            .unwrap()
            .expect("a bell is an occurrence the raw client reports");
        assert!(
            effects.ends_with(&[0x07]),
            "the bell is reliable without being coupled to replaceable screen state"
        );
    }

    /// Each encoding refuses the other's frames rather than rendering what it
    /// did not ask for.
    #[test]
    fn an_attachment_refuses_the_encoding_it_did_not_ask_for() {
        let bytes_frame = TerminalControlEvent::Output {
            terminal_id: TerminalId::default(),
            attachment_id: Default::default(),
            sequence: 1,
            revision: shipctl_core::terminal::TerminalRevision(2),
            data_base64: BASE64_STANDARD.encode(b"ok"),
        };
        assert_eq!(
            raw_event(TerminalTransport::Semantic, &bytes_frame)
                .unwrap_err()
                .code
                .as_str(),
            "terminal.attach.event_invalid"
        );
        assert_eq!(
            raw_event(TerminalTransport::Legacy, &screen_event(sample_state()))
                .unwrap_err()
                .code
                .as_str(),
            "terminal.attach.event_invalid"
        );
        assert_eq!(
            raw_baseline(TerminalTransport::Semantic, "", None)
                .unwrap_err()
                .code
                .as_str(),
            "terminal.attach.event_invalid"
        );

        // The byte path is what it was.
        assert_eq!(
            raw_event(TerminalTransport::Legacy, &bytes_frame).unwrap(),
            Some(b"ok".to_vec())
        );
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
