//! The on-disk log record.
//!
//! The UI writes one JSON object per line and the CLI reads them back. Both
//! sides share this module so the written shape and the parsed shape can never
//! drift apart.
//!
//! A line is self-describing: `jq` can consume the file directly, without the
//! CLI and without a preprocessing step.

use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::macros::format_description;
use time::OffsetDateTime;

/// Fixed-width UTC instant.
///
/// RFC 3339 permits omitting subseconds, and `time` does omit them when they
/// are zero. That would break lexical ordering, because `.` sorts before `Z`:
/// `…:00Z` would compare greater than `…:00.500Z`. Pinning three digits keeps
/// string order and time order the same, which is what lets a reader sort and
/// range-compare timestamps without parsing them.
const TIMESTAMP: &[time::format_description::BorrowedFormatItem<'_>] =
    format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");

/// Severity, ordered least to most severe so a `--level` floor is a comparison.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "trace",
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

impl fmt::Display for LogLevel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for LogLevel {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "trace" => Ok(Self::Trace),
            "debug" => Ok(Self::Debug),
            "info" => Ok(Self::Info),
            "warn" | "warning" => Ok(Self::Warn),
            "error" => Ok(Self::Error),
            other => Err(format!(
                "Unknown log level `{other}`; use trace, debug, info, warn, or error"
            )),
        }
    }
}

impl From<log::Level> for LogLevel {
    fn from(level: log::Level) -> Self {
        match level {
            log::Level::Trace => Self::Trace,
            log::Level::Debug => Self::Debug,
            log::Level::Info => Self::Info,
            log::Level::Warn => Self::Warn,
            log::Level::Error => Self::Error,
        }
    }
}

/// One log line.
///
/// `message` and `payload` are exclusive. A log message that is already a JSON
/// object becomes `payload`, so a reader can filter on its fields directly
/// rather than parsing a string out of a string. Everything else stays a plain
/// `message`.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LogRecord {
    /// RFC 3339 UTC, millisecond precision. Lexical order is time order.
    pub ts: String,
    pub level: LogLevel,
    /// Emitting subsystem, for example `shipctl::startup` or
    /// `webview:shipctl.terminal`.
    pub target: String,
    /// Instance that produced the record. Absent in records written before the
    /// process learned its own name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
}

impl LogRecord {
    pub fn new(
        ts: String,
        level: LogLevel,
        target: &str,
        instance: Option<&str>,
        body: &str,
    ) -> Self {
        let payload = serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .filter(serde_json::Value::is_object);
        Self {
            ts,
            level,
            target: target.to_string(),
            instance: instance.map(str::to_string),
            message: if payload.is_some() {
                None
            } else {
                Some(body.to_string())
            },
            payload,
        }
    }

    /// A single uniform column for tabular output. The payload case is rendered
    /// compactly rather than omitted, so no row is blank.
    pub fn summary(&self) -> String {
        match (&self.message, &self.payload) {
            (Some(message), _) => message.clone(),
            (None, Some(payload)) => payload.to_string(),
            (None, None) => String::new(),
        }
    }

    pub fn to_line(&self) -> Result<String, String> {
        serde_json::to_string(self)
            .map_err(|error| format!("Could not encode a log record: {error}"))
    }
}

/// Format the current instant the way [`LogRecord::ts`] expects.
pub fn now_timestamp() -> String {
    format_timestamp(OffsetDateTime::now_utc())
}

pub fn format_timestamp(moment: OffsetDateTime) -> String {
    moment
        .to_offset(time::UtcOffset::UTC)
        .format(TIMESTAMP)
        .unwrap_or_default()
}

pub fn parse_timestamp(value: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(value, &Rfc3339).ok()
}

/// Directory the application writes its log files to.
///
/// This mirrors the platform rule Tauri applies for an application log
/// directory. The UI passes the resolved path to its log plugin rather than
/// letting the plugin derive its own, so this function is the single authority
/// and the CLI can never read a different directory than the UI writes.
pub fn app_log_dir(identifier: &str) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        dirs::home_dir().map(|home| home.join("Library/Logs").join(identifier))
    } else {
        dirs::config_dir().map(|config| config.join(identifier).join("logs"))
    }
}

/// File name stem of the primary log, without the `.log` extension the log
/// plugin appends.
pub const LOG_FILE_STEM: &str = "shipctl";
/// File name stem of the user-facing notice log.
pub const NOTICE_LOG_FILE_STEM: &str = "shipctl-notices";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_json_object_message_becomes_a_filterable_payload() {
        let record = LogRecord::new(
            "2026-08-13T05:19:14.719Z".to_string(),
            LogLevel::Info,
            "webview:shipctl.terminal",
            Some("main"),
            r#"{"event":"input_observed","terminalId":"7724"}"#,
        );

        assert!(record.message.is_none());
        assert_eq!(
            record
                .payload
                .as_ref()
                .and_then(|payload| payload["event"].as_str()),
            Some("input_observed")
        );
    }

    #[test]
    fn a_plain_message_stays_a_message() {
        let record = LogRecord::new(
            "2026-08-13T05:19:14.719Z".to_string(),
            LogLevel::Warn,
            "shipctl::startup",
            None,
            "Shipctl UI starting",
        );

        assert_eq!(record.message.as_deref(), Some("Shipctl UI starting"));
        assert!(record.payload.is_none());
        assert!(record.instance.is_none());
    }

    /// A bare JSON scalar or array is not an object, so it must not be promoted
    /// into `payload` where a reader would expect field access to work.
    #[test]
    fn only_a_json_object_is_promoted() {
        for body in ["42", "\"text\"", "[1,2,3]", "null", "not json at all"] {
            let record = LogRecord::new(
                "2026-08-13T05:19:14.719Z".to_string(),
                LogLevel::Info,
                "t",
                None,
                body,
            );
            assert!(record.payload.is_none(), "{body} must stay a message");
            assert_eq!(record.message.as_deref(), Some(body));
        }
    }

    #[test]
    fn a_record_round_trips_through_its_line_form() {
        let record = LogRecord::new(
            now_timestamp(),
            LogLevel::Error,
            "shipctl::instance",
            Some("test"),
            r#"{"code":"boom"}"#,
        );

        let line = record.to_line().unwrap();
        let parsed: LogRecord = serde_json::from_str(&line).unwrap();

        assert_eq!(parsed, record);
        assert!(!line.contains('\n'));
    }

    /// Absent fields must not appear in the line at all, so a reader can use
    /// their presence as the signal.
    #[test]
    fn absent_fields_are_omitted_from_the_line() {
        let record = LogRecord::new(
            "2026-08-13T05:19:14.719Z".to_string(),
            LogLevel::Info,
            "t",
            None,
            "plain",
        );

        let line = record.to_line().unwrap();

        assert!(!line.contains("instance"));
        assert!(!line.contains("payload"));
    }

    #[test]
    fn levels_order_from_least_to_most_severe() {
        assert!(LogLevel::Trace < LogLevel::Debug);
        assert!(LogLevel::Debug < LogLevel::Info);
        assert!(LogLevel::Info < LogLevel::Warn);
        assert!(LogLevel::Warn < LogLevel::Error);
    }

    #[test]
    fn level_parsing_accepts_the_documented_spellings_and_rejects_others() {
        assert_eq!("WARN".parse::<LogLevel>().unwrap(), LogLevel::Warn);
        assert_eq!("warning".parse::<LogLevel>().unwrap(), LogLevel::Warn);
        assert_eq!(" info ".parse::<LogLevel>().unwrap(), LogLevel::Info);
        assert!("verbose".parse::<LogLevel>().is_err());
    }

    #[test]
    fn timestamps_round_trip_and_sort_lexically() {
        let earlier = format_timestamp(OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap());
        let later = format_timestamp(OffsetDateTime::from_unix_timestamp(1_700_000_001).unwrap());

        assert!(earlier < later, "{earlier} must sort before {later}");
        assert!(parse_timestamp(&earlier).is_some());
        assert!(parse_timestamp("not a timestamp").is_none());
    }

    /// Subseconds are always present and always three digits. Dropping them at
    /// zero would put `…:00Z` after `…:00.500Z`, because `.` sorts before `Z`.
    #[test]
    fn a_whole_second_keeps_its_subsecond_digits_so_ordering_holds() {
        let whole = OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();
        let half = whole + time::Duration::milliseconds(500);

        let whole = format_timestamp(whole);
        let half = format_timestamp(half);

        assert!(whole.ends_with(".000Z"), "{whole} must keep three digits");
        assert_eq!(half, "2023-11-14T22:13:20.500Z");
        assert!(whole < half, "{whole} must sort before {half}");
    }

    /// A non-UTC input must be converted, not relabelled: the trailing `Z` is
    /// literal, so an unconverted offset would misreport the instant.
    #[test]
    fn a_non_utc_instant_is_converted_before_formatting() {
        let utc = OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();
        let shifted = utc.to_offset(time::UtcOffset::from_hms(5, 30, 0).unwrap());

        assert_eq!(format_timestamp(shifted), format_timestamp(utc));
    }
}
