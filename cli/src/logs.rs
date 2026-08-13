//! `shipctl logs` — read what the UI wrote.
//!
//! The UI is a desktop application and writes no diagnostics to the terminal.
//! This command is how those records are reached, either as a bounded page or
//! as a live stream.

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use glob::Pattern;
use serde::Serialize;
use shipctl_core::instance::ControlError;
use shipctl_core::logs::{
    app_log_dir, parse_since, read, LogLevel, LogQuery, LogRecord, LogTail, LOG_FILE_STEM,
    NOTICE_LOG_FILE_STEM,
};
use time::OffsetDateTime;

use crate::args::LogsArgs;
use crate::output::OutputFormat;

pub const OPERATION: &str = "logs";
const READ_CODE: &str = "logs.read";
const APP_IDENTIFIER: &str = env!("SHIPCTL_APP_IDENTIFIER");

/// How long to wait between checks for new records while following. A log is
/// appended by another process, so there is nothing to wait on but the file.
const FOLLOW_INTERVAL: Duration = Duration::from_millis(250);

/// One record, projected to the fixed columns a tabular format needs. The
/// variable payload cannot be a column, so it is rendered into `message`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogRow {
    ts: String,
    level: LogLevel,
    target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    instance: Option<String>,
    message: String,
}

impl From<&LogRecord> for LogRow {
    fn from(record: &LogRecord) -> Self {
        Self {
            ts: record.ts.clone(),
            level: record.level,
            target: record.target.clone(),
            instance: record.instance.clone(),
            message: record.summary(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogsView {
    file: PathBuf,
    /// Records returned, out of every record that matched. These differ when
    /// `--limit` truncated the page.
    count: usize,
    matched: usize,
    scanned: usize,
    /// Lines the reader could not parse, which a log written by an older build
    /// produces. Reported rather than hidden, so an empty page is never
    /// mistaken for an empty log.
    #[serde(skip_serializing_if = "is_zero")]
    unparsed: usize,
    records: Vec<LogRow>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    help: Vec<String>,
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}

/// `format_was_requested` distinguishes an explicit `--output` from the
/// default. A stream cannot carry an envelope, so `--follow` resolves to JSON
/// Lines on its own; asking for an enveloped format alongside it is a
/// contradiction worth reporting rather than silently overriding.
pub fn run(args: LogsArgs, format: OutputFormat, format_was_requested: bool) -> ExitCode {
    let (path, query) = match plan(&args) {
        Ok(plan) => plan,
        Err(error) => return crate::emit_failure(format, OPERATION, &error, false),
    };

    if args.follow {
        if format_was_requested && format.is_enveloped() {
            return usage_error(
                format,
                &format!(
                    "`--follow` streams records and cannot use the enveloped `{}` format. \
                     Drop `--output` or pass `--output jsonl`.",
                    format_name(format)
                ),
            );
        }
        return follow(&path, &query);
    }

    let page = match read(&path, &query) {
        Ok(page) => page,
        Err(error) => return crate::emit_failure(format, OPERATION, &error, false),
    };

    // A stream format carries the records alone: no envelope, no aggregates.
    if format == OutputFormat::Jsonl {
        return match crate::emit_success(format, OPERATION, READ_CODE, false, &page.records) {
            Ok(code) => code,
            Err(message) => crate::emit_render_failure(format, OPERATION, message),
        };
    }

    let view = LogsView {
        file: path.clone(),
        count: page.records.len(),
        matched: page.matched,
        scanned: page.scanned,
        unparsed: page.unparsed,
        records: page.records.iter().map(LogRow::from).collect(),
        help: help(&args, &page),
    };
    match crate::emit_success(format, OPERATION, READ_CODE, page.matched == 0, view) {
        Ok(code) => code,
        Err(message) => crate::emit_render_failure(format, OPERATION, message),
    }
}

/// Resolve the file to read and the filters to apply.
fn plan(args: &LogsArgs) -> Result<(PathBuf, LogQuery), ControlError> {
    let directory = match args.log_dir.clone() {
        Some(directory) => directory,
        None => app_log_dir(APP_IDENTIFIER).ok_or_else(|| {
            ControlError::new(
                "logs.directory_unavailable",
                "Could not resolve the application log directory. Pass `--log-dir <path>`.",
            )
        })?,
    };
    let stem = if args.notices {
        NOTICE_LOG_FILE_STEM
    } else {
        LOG_FILE_STEM
    };

    let minimum_level = args
        .level
        .as_deref()
        .map(str::parse::<LogLevel>)
        .transpose()
        .map_err(|message| ControlError::new("logs.level_invalid", message))?;

    let targets = args
        .target
        .iter()
        .map(|pattern| {
            Pattern::new(pattern).map_err(|error| {
                ControlError::new(
                    "logs.target_invalid",
                    format!("`{pattern}` is not a valid target glob: {error}"),
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    let since = args
        .since
        .as_deref()
        .map(|value| parse_since(value, OffsetDateTime::now_utc()))
        .transpose()
        .map_err(|message| ControlError::new("logs.since_invalid", message))?;

    Ok((
        directory.join(format!("{stem}.log")),
        LogQuery {
            minimum_level,
            targets,
            instance: args.instance.clone(),
            since,
            // A follow has no page to bound.
            limit: (!args.follow).then_some(args.limit),
        },
    ))
}

/// Suggestions that follow from what this read just showed.
fn help(args: &LogsArgs, page: &shipctl_core::logs::LogPage) -> Vec<String> {
    let mut help = Vec::new();
    if page.matched == 0 && page.scanned > 0 {
        help.push("Widen the read with `shipctl logs --level trace`".to_string());
    }
    if page.matched == 0 && page.scanned == 0 && !args.notices {
        help.push("Run `shipctl ui` to start an instance that writes records".to_string());
    }
    if page.matched > page.records.len() {
        help.push(format!(
            "Run `shipctl logs --limit {}` to see all matches",
            page.matched
        ));
    }
    if page.unparsed > 0 {
        help.push(
            "Lines from an older build are not readable; run `shipctl ui` to retire them"
                .to_string(),
        );
    }
    if !args.follow {
        help.push("Run `shipctl logs --follow` to stream new records".to_string());
    }
    help
}

fn follow(path: &Path, query: &LogQuery) -> ExitCode {
    let mut tail = match LogTail::at_end(path) {
        Ok(tail) => tail,
        Err(error) => return crate::emit_failure(OutputFormat::Jsonl, OPERATION, &error, false),
    };
    loop {
        let records = match tail.poll(query) {
            Ok(records) => records,
            Err(error) => {
                return crate::emit_failure(OutputFormat::Jsonl, OPERATION, &error, false)
            }
        };
        for record in &records {
            if let Err(code) = print_line(record) {
                return code;
            }
        }
        std::thread::sleep(FOLLOW_INTERVAL);
    }
}

/// Write one record and flush, so a consumer reading the pipe sees it now
/// rather than when a buffer happens to fill.
fn print_line(record: &LogRecord) -> Result<(), ExitCode> {
    let line = match record.to_line() {
        Ok(line) => line,
        Err(message) => {
            return Err(crate::emit_render_failure(
                OutputFormat::Jsonl,
                OPERATION,
                message,
            ))
        }
    };
    let mut stdout = io::stdout().lock();
    match writeln!(stdout, "{line}").and_then(|()| stdout.flush()) {
        Ok(()) => Ok(()),
        // A closed pipe is how `head` and friends end a stream. It is the
        // consumer's decision, not a failure of this command.
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Err(ExitCode::SUCCESS),
        Err(_) => Err(ExitCode::FAILURE),
    }
}

fn usage_error(format: OutputFormat, message: &str) -> ExitCode {
    crate::emit_usage_message(format, OPERATION, message)
}

fn format_name(format: OutputFormat) -> &'static str {
    match format {
        OutputFormat::Toon => "toon",
        OutputFormat::Json => "json",
        OutputFormat::Jsonl => "jsonl",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args() -> LogsArgs {
        LogsArgs {
            level: None,
            target: Vec::new(),
            instance: None,
            since: None,
            limit: 100,
            notices: false,
            follow: false,
            log_dir: Some(PathBuf::from("/logs")),
        }
    }

    #[test]
    fn the_default_read_targets_the_diagnostic_log() {
        let (path, query) = plan(&args()).unwrap();

        assert_eq!(path, PathBuf::from("/logs/shipctl.log"));
        assert_eq!(query.limit, Some(100));
        assert!(query.minimum_level.is_none());
        assert!(query.targets.is_empty());
    }

    #[test]
    fn notices_select_the_other_file() {
        let (path, _) = plan(&LogsArgs {
            notices: true,
            ..args()
        })
        .unwrap();

        assert_eq!(path, PathBuf::from("/logs/shipctl-notices.log"));
    }

    /// A follow has no page, so it must not carry a limit that would silently
    /// drop records from the stream.
    #[test]
    fn a_follow_carries_no_limit() {
        let (_, query) = plan(&LogsArgs {
            follow: true,
            ..args()
        })
        .unwrap();

        assert!(query.limit.is_none());
    }

    #[test]
    fn filters_reach_the_query() {
        let (_, query) = plan(&LogsArgs {
            level: Some("warn".to_string()),
            target: vec!["webview:*".to_string(), "shipctl::*".to_string()],
            instance: Some("test".to_string()),
            ..args()
        })
        .unwrap();

        assert_eq!(query.minimum_level, Some(LogLevel::Warn));
        assert_eq!(query.targets.len(), 2);
        assert!(query.targets[0].matches("webview:shipctl.terminal"));
        assert_eq!(query.instance.as_deref(), Some("test"));
    }

    #[test]
    fn bad_filter_values_are_named_by_their_own_error_code() {
        let level = plan(&LogsArgs {
            level: Some("verbose".to_string()),
            ..args()
        })
        .unwrap_err();
        assert_eq!(level.code.as_str(), "logs.level_invalid");

        let target = plan(&LogsArgs {
            target: vec!["web[".to_string()],
            ..args()
        })
        .unwrap_err();
        assert_eq!(target.code.as_str(), "logs.target_invalid");

        let since = plan(&LogsArgs {
            since: Some("yesterday".to_string()),
            ..args()
        })
        .unwrap_err();
        assert_eq!(since.code.as_str(), "logs.since_invalid");
    }

    #[test]
    fn a_relative_since_resolves_to_an_instant() {
        let (_, query) = plan(&LogsArgs {
            since: Some("15m".to_string()),
            ..args()
        })
        .unwrap();

        let since = query.since.expect("a since bound");
        let elapsed = OffsetDateTime::now_utc() - since;
        assert!(
            elapsed >= time::Duration::minutes(15),
            "expected at least 15 minutes back, got {elapsed}"
        );
        assert!(elapsed < time::Duration::minutes(16));
    }

    /// A truncated page must say how much it left out, and an empty log must
    /// point at the reason it is empty.
    #[test]
    fn help_follows_from_what_the_read_showed() {
        use shipctl_core::logs::LogPage;

        let truncated = LogPage {
            records: Vec::new(),
            matched: 500,
            scanned: 900,
            unparsed: 0,
        };
        assert!(help(&args(), &truncated)
            .iter()
            .any(|line| line.contains("--limit 500")));

        let empty_log = LogPage {
            records: Vec::new(),
            matched: 0,
            scanned: 0,
            unparsed: 0,
        };
        assert!(help(&args(), &empty_log)
            .iter()
            .any(|line| line.contains("shipctl ui")));

        let all_filtered = LogPage {
            records: Vec::new(),
            matched: 0,
            scanned: 40,
            unparsed: 0,
        };
        assert!(help(&args(), &all_filtered)
            .iter()
            .any(|line| line.contains("--level trace")));

        let legacy = LogPage {
            records: Vec::new(),
            matched: 0,
            scanned: 10,
            unparsed: 10,
        };
        assert!(help(&args(), &legacy)
            .iter()
            .any(|line| line.contains("older build")));
    }

    #[test]
    fn a_row_renders_a_payload_rather_than_leaving_the_column_blank() {
        let record = LogRecord::new(
            "2026-08-13T05:00:00.000Z".to_string(),
            LogLevel::Info,
            "webview:shipctl.terminal",
            Some("main"),
            r#"{"event":"input_observed"}"#,
        );

        let row = LogRow::from(&record);

        assert_eq!(row.message, r#"{"event":"input_observed"}"#);
        assert_eq!(row.instance.as_deref(), Some("main"));
    }
}
