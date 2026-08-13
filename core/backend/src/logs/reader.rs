//! Bounded and streaming reads over the application log.

use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use glob::Pattern;
use time::{Duration, OffsetDateTime};

use crate::instance::ControlError;

use super::record::{parse_timestamp, LogLevel, LogRecord};

/// What to keep out of a read. Every field is a narrowing filter; an empty
/// query matches every record.
#[derive(Clone, Debug, Default)]
pub struct LogQuery {
    /// Keep records at this severity or above.
    pub minimum_level: Option<LogLevel>,
    /// Keep records whose target matches any pattern. `*`, `?`, and `[...]`
    /// behave as in a shell glob.
    pub targets: Vec<Pattern>,
    /// Keep records produced by this instance.
    pub instance: Option<String>,
    /// Keep records at or after this moment.
    pub since: Option<OffsetDateTime>,
    /// Keep at most this many of the most recent matches.
    pub limit: Option<usize>,
}

impl LogQuery {
    fn matches(&self, record: &LogRecord) -> bool {
        if self.minimum_level.is_some_and(|floor| record.level < floor) {
            return false;
        }
        if !self.targets.is_empty()
            && !self
                .targets
                .iter()
                .any(|pattern| pattern.matches(&record.target))
        {
            return false;
        }
        if let Some(instance) = &self.instance {
            if record.instance.as_deref() != Some(instance.as_str()) {
                return false;
            }
        }
        if let Some(since) = self.since {
            match parse_timestamp(&record.ts) {
                Some(moment) if moment >= since => {}
                // A record whose timestamp cannot be read cannot be shown to
                // satisfy a time bound, so a time-bounded read excludes it.
                _ => return false,
            }
        }
        true
    }
}

/// The result of a bounded read.
#[derive(Clone, Debug)]
pub struct LogPage {
    /// The most recent matches, oldest first, capped by [`LogQuery::limit`].
    pub records: Vec<LogRecord>,
    /// Every record that matched, before the limit was applied.
    pub matched: usize,
    /// Every line read, including lines that did not match.
    pub scanned: usize,
    /// Lines that are not valid records. Log files written by an older build
    /// use a different format, so these are reported rather than treated as
    /// a failure.
    pub unparsed: usize,
}

/// Parse one line, or report it as unparseable.
fn parse_line(line: &str) -> Option<LogRecord> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    serde_json::from_str::<LogRecord>(line).ok()
}

fn unreadable(path: &Path, error: std::io::Error) -> ControlError {
    ControlError::new(
        "logs.read_failed",
        format!("Could not read the log file {}: {error}", path.display()),
    )
}

/// Read a bounded page from one log file.
///
/// A missing file is an empty page, not an error: the UI creates the file on
/// its first run, and "nothing has been logged" is a definitive answer to the
/// question the caller asked.
pub fn read(path: &Path, query: &LogQuery) -> Result<LogPage, ControlError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LogPage {
                records: Vec::new(),
                matched: 0,
                scanned: 0,
                unparsed: 0,
            })
        }
        Err(error) => return Err(unreadable(path, error)),
    };

    let mut page = LogPage {
        records: Vec::new(),
        matched: 0,
        scanned: 0,
        unparsed: 0,
    };
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| unreadable(path, error))?;
        if line.trim().is_empty() {
            continue;
        }
        page.scanned += 1;
        let Some(record) = parse_line(&line) else {
            page.unparsed += 1;
            continue;
        };
        if !query.matches(&record) {
            continue;
        }
        page.matched += 1;
        page.records.push(record);
        // Keep only the most recent window so a long log never has to be held
        // in memory in full.
        if let Some(limit) = query.limit {
            if page.records.len() > limit {
                page.records.remove(0);
            }
        }
    }
    Ok(page)
}

/// A cursor for streaming reads, positioned past everything already seen.
pub struct LogTail {
    path: PathBuf,
    offset: u64,
}

impl LogTail {
    /// Open a tail positioned at the end of the current file, so a follow
    /// reports only what happens from now on.
    pub fn at_end(path: &Path) -> Result<Self, ControlError> {
        let offset = match std::fs::metadata(path) {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(error) => return Err(unreadable(path, error)),
        };
        Ok(Self {
            path: path.to_path_buf(),
            offset,
        })
    }

    /// Read whatever has been appended since the last call.
    ///
    /// A file that shrank was rotated or truncated, so the cursor restarts at
    /// the beginning rather than skipping the new file's opening records.
    pub fn poll(&mut self, query: &LogQuery) -> Result<Vec<LogRecord>, ControlError> {
        let mut file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(unreadable(&self.path, error)),
        };
        let length = file
            .metadata()
            .map_err(|error| unreadable(&self.path, error))?
            .len();
        if length < self.offset {
            self.offset = 0;
        }
        if length == self.offset {
            return Ok(Vec::new());
        }
        file.seek(SeekFrom::Start(self.offset))
            .map_err(|error| unreadable(&self.path, error))?;

        let mut reader = BufReader::new(file);
        let mut records = Vec::new();
        let mut consumed = self.offset;
        let mut line = String::new();
        loop {
            line.clear();
            let read = reader
                .read_line(&mut line)
                .map_err(|error| unreadable(&self.path, error))?;
            if read == 0 {
                break;
            }
            // A trailing fragment means the writer is mid-line. Leave the
            // cursor before it so the whole line is read on the next poll.
            if !line.ends_with('\n') {
                break;
            }
            consumed += read as u64;
            if let Some(record) = parse_line(&line) {
                if query.matches(&record) {
                    records.push(record);
                }
            }
        }
        self.offset = consumed;
        Ok(records)
    }
}

/// Resolve `--since`: either an RFC 3339 instant or an offset back from `now`
/// written as `<count><unit>` with unit `s`, `m`, `h`, or `d`.
pub fn parse_since(value: &str, now: OffsetDateTime) -> Result<OffsetDateTime, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("A --since value cannot be empty".to_string());
    }
    if let Some(moment) = parse_timestamp(value) {
        return Ok(moment);
    }
    let (count, unit) = value.split_at(
        value
            .find(|character: char| !character.is_ascii_digit())
            .ok_or_else(|| format!("`{value}` needs a unit; use s, m, h, or d, as in `15m`"))?,
    );
    let count: i64 = count
        .parse()
        .map_err(|_| format!("`{value}` does not start with a whole number of units"))?;
    let span = match unit {
        "s" => Duration::seconds(count),
        "m" => Duration::minutes(count),
        "h" => Duration::hours(count),
        "d" => Duration::days(count),
        other => {
            return Err(format!(
                "Unknown --since unit `{other}`; use s, m, h, or d, as in `15m`"
            ))
        }
    };
    Ok(now - span)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::super::record::format_timestamp;
    use super::*;

    fn record(ts: &str, level: LogLevel, target: &str, instance: Option<&str>) -> LogRecord {
        LogRecord::new(ts.to_string(), level, target, instance, "body")
    }

    fn write_log(lines: &[&str]) -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("shipctl.log");
        let mut file = File::create(&path).unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
        (directory, path)
    }

    fn lines_of(records: &[LogRecord]) -> Vec<String> {
        records
            .iter()
            .map(|record| record.to_line().unwrap())
            .collect()
    }

    #[test]
    fn a_missing_file_reads_as_a_definitive_empty_page() {
        let page = read(Path::new("/nonexistent/shipctl.log"), &LogQuery::default()).unwrap();

        assert!(page.records.is_empty());
        assert_eq!(page.matched, 0);
        assert_eq!(page.scanned, 0);
        assert_eq!(page.unparsed, 0);
    }

    #[test]
    fn a_level_floor_keeps_that_level_and_everything_above_it() {
        let records = [
            record("2026-08-13T05:00:00.000Z", LogLevel::Debug, "a", None),
            record("2026-08-13T05:00:01.000Z", LogLevel::Info, "a", None),
            record("2026-08-13T05:00:02.000Z", LogLevel::Error, "a", None),
        ];
        let lines = lines_of(&records);
        let (_directory, path) = write_log(&lines.iter().map(String::as_str).collect::<Vec<_>>());

        let page = read(
            &path,
            &LogQuery {
                minimum_level: Some(LogLevel::Info),
                ..LogQuery::default()
            },
        )
        .unwrap();

        assert_eq!(page.matched, 2);
        assert_eq!(page.scanned, 3);
        assert_eq!(
            page.records.iter().map(|r| r.level).collect::<Vec<_>>(),
            vec![LogLevel::Info, LogLevel::Error]
        );
    }

    /// The keystroke firehose and the records worth keeping are both `info`,
    /// so target globbing is the filter that actually separates them.
    #[test]
    fn a_target_glob_separates_subsystems_at_one_level() {
        let records = [
            record(
                "2026-08-13T05:00:00.000Z",
                LogLevel::Info,
                "webview:shipctl.terminal",
                None,
            ),
            record(
                "2026-08-13T05:00:01.000Z",
                LogLevel::Info,
                "webview:shipctl.notice",
                None,
            ),
            record(
                "2026-08-13T05:00:02.000Z",
                LogLevel::Info,
                "shipctl::startup",
                None,
            ),
        ];
        let lines = lines_of(&records);
        let (_directory, path) = write_log(&lines.iter().map(String::as_str).collect::<Vec<_>>());

        let page = read(
            &path,
            &LogQuery {
                targets: vec![Pattern::new("webview:*").unwrap()],
                ..LogQuery::default()
            },
        )
        .unwrap();
        assert_eq!(page.matched, 2);

        let page = read(
            &path,
            &LogQuery {
                targets: vec![Pattern::new("shipctl::*").unwrap()],
                ..LogQuery::default()
            },
        )
        .unwrap();
        assert_eq!(page.matched, 1);
    }

    #[test]
    fn several_target_globs_union_rather_than_intersect() {
        let records = [
            record(
                "2026-08-13T05:00:00.000Z",
                LogLevel::Info,
                "webview:x",
                None,
            ),
            record(
                "2026-08-13T05:00:01.000Z",
                LogLevel::Info,
                "shipctl::y",
                None,
            ),
            record("2026-08-13T05:00:02.000Z", LogLevel::Info, "other", None),
        ];
        let lines = lines_of(&records);
        let (_directory, path) = write_log(&lines.iter().map(String::as_str).collect::<Vec<_>>());

        let page = read(
            &path,
            &LogQuery {
                targets: vec![
                    Pattern::new("webview:*").unwrap(),
                    Pattern::new("shipctl::*").unwrap(),
                ],
                ..LogQuery::default()
            },
        )
        .unwrap();

        assert_eq!(page.matched, 2);
    }

    /// Several instances write to one file, so the instance filter is what
    /// makes a second UI readable at all.
    #[test]
    fn an_instance_filter_separates_concurrent_instances() {
        let records = [
            record(
                "2026-08-13T05:00:00.000Z",
                LogLevel::Info,
                "a",
                Some("main"),
            ),
            record(
                "2026-08-13T05:00:01.000Z",
                LogLevel::Info,
                "a",
                Some("test"),
            ),
            record("2026-08-13T05:00:02.000Z", LogLevel::Info, "a", None),
        ];
        let lines = lines_of(&records);
        let (_directory, path) = write_log(&lines.iter().map(String::as_str).collect::<Vec<_>>());

        let page = read(
            &path,
            &LogQuery {
                instance: Some("test".to_string()),
                ..LogQuery::default()
            },
        )
        .unwrap();

        assert_eq!(page.matched, 1);
        assert_eq!(page.records[0].instance.as_deref(), Some("test"));
    }

    #[test]
    fn a_limit_keeps_the_most_recent_matches_and_still_counts_the_rest() {
        let records = (0..5)
            .map(|second| {
                record(
                    &format!("2026-08-13T05:00:0{second}.000Z"),
                    LogLevel::Info,
                    "a",
                    None,
                )
            })
            .collect::<Vec<_>>();
        let lines = lines_of(&records);
        let (_directory, path) = write_log(&lines.iter().map(String::as_str).collect::<Vec<_>>());

        let page = read(
            &path,
            &LogQuery {
                limit: Some(2),
                ..LogQuery::default()
            },
        )
        .unwrap();

        assert_eq!(page.matched, 5, "the total must survive the limit");
        assert_eq!(page.records.len(), 2);
        assert_eq!(page.records[0].ts, "2026-08-13T05:00:03.000Z");
        assert_eq!(page.records[1].ts, "2026-08-13T05:00:04.000Z");
    }

    /// Log files written by an earlier build use a plain-text format. They are
    /// counted and skipped, never a read failure.
    #[test]
    fn lines_from_an_older_format_are_counted_not_fatal() {
        let good = record("2026-08-13T05:00:00.000Z", LogLevel::Info, "a", None)
            .to_line()
            .unwrap();
        let (_directory, path) = write_log(&[
            "[2026-08-13][05:19:14][webview:shipctl.terminal][INFO] legacy line",
            &good,
        ]);

        let page = read(&path, &LogQuery::default()).unwrap();

        assert_eq!(page.scanned, 2);
        assert_eq!(page.unparsed, 1);
        assert_eq!(page.matched, 1);
    }

    #[test]
    fn a_time_bound_excludes_records_it_cannot_place() {
        let mut undateable = record("2026-08-13T05:00:05.000Z", LogLevel::Info, "a", None);
        undateable.ts = "whenever".to_string();
        let records = [
            record("2026-08-13T05:00:00.000Z", LogLevel::Info, "a", None),
            record("2026-08-13T05:00:10.000Z", LogLevel::Info, "a", None),
            undateable,
        ];
        let lines = lines_of(&records);
        let (_directory, path) = write_log(&lines.iter().map(String::as_str).collect::<Vec<_>>());

        let page = read(
            &path,
            &LogQuery {
                since: parse_timestamp("2026-08-13T05:00:05.000Z"),
                ..LogQuery::default()
            },
        )
        .unwrap();

        assert_eq!(page.matched, 1);
        assert_eq!(page.records[0].ts, "2026-08-13T05:00:10.000Z");
    }

    #[test]
    fn a_tail_starts_at_the_end_and_reports_only_what_arrives_after() {
        let existing = record("2026-08-13T05:00:00.000Z", LogLevel::Info, "a", None)
            .to_line()
            .unwrap();
        let (_directory, path) = write_log(&[&existing]);

        let mut tail = LogTail::at_end(&path).unwrap();
        assert!(tail.poll(&LogQuery::default()).unwrap().is_empty());

        let appended = record("2026-08-13T05:00:01.000Z", LogLevel::Info, "a", None)
            .to_line()
            .unwrap();
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(file, "{appended}").unwrap();

        let arrived = tail.poll(&LogQuery::default()).unwrap();
        assert_eq!(arrived.len(), 1);
        assert_eq!(arrived[0].ts, "2026-08-13T05:00:01.000Z");
        assert!(tail.poll(&LogQuery::default()).unwrap().is_empty());
    }

    /// A writer mid-line must not be read as a truncated record; the cursor
    /// waits for the newline.
    #[test]
    fn a_tail_holds_a_partial_line_until_it_is_complete() {
        let (_directory, path) = write_log(&[]);
        let mut tail = LogTail::at_end(&path).unwrap();

        let complete = record("2026-08-13T05:00:01.000Z", LogLevel::Info, "a", None)
            .to_line()
            .unwrap();
        let (head, rest) = complete.split_at(20);

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        write!(file, "{head}").unwrap();
        file.flush().unwrap();
        assert!(tail.poll(&LogQuery::default()).unwrap().is_empty());

        writeln!(file, "{rest}").unwrap();
        file.flush().unwrap();
        assert_eq!(tail.poll(&LogQuery::default()).unwrap().len(), 1);
    }

    #[test]
    fn a_truncated_file_restarts_the_tail_rather_than_skipping_records() {
        let first = record("2026-08-13T05:00:00.000Z", LogLevel::Info, "a", None)
            .to_line()
            .unwrap();
        let (_directory, path) = write_log(&[&first, &first, &first]);
        let mut tail = LogTail::at_end(&path).unwrap();

        let rotated = record("2026-08-13T06:00:00.000Z", LogLevel::Info, "a", None)
            .to_line()
            .unwrap();
        let mut file = File::create(&path).unwrap();
        writeln!(file, "{rotated}").unwrap();

        let arrived = tail.poll(&LogQuery::default()).unwrap();
        assert_eq!(arrived.len(), 1);
        assert_eq!(arrived[0].ts, "2026-08-13T06:00:00.000Z");
    }

    #[test]
    fn since_accepts_an_absolute_instant_and_a_relative_offset() {
        let now = OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();

        assert_eq!(
            format_timestamp(parse_since("15m", now).unwrap()),
            format_timestamp(now - Duration::minutes(15))
        );
        assert_eq!(
            format_timestamp(parse_since("2h", now).unwrap()),
            format_timestamp(now - Duration::hours(2))
        );
        assert_eq!(
            format_timestamp(parse_since("3d", now).unwrap()),
            format_timestamp(now - Duration::days(3))
        );
        assert_eq!(
            format_timestamp(parse_since("2026-08-13T05:00:00Z", now).unwrap()),
            "2026-08-13T05:00:00.000Z"
        );
    }

    #[test]
    fn since_rejects_what_it_cannot_place_in_time() {
        let now = OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();

        assert!(parse_since("", now).is_err());
        assert!(parse_since("15", now).is_err(), "a bare number has no unit");
        assert!(parse_since("15y", now).is_err(), "unsupported unit");
        assert!(parse_since("yesterday", now).is_err());
    }
}
