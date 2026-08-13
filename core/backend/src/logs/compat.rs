//! Detecting a log file whose lines predate the current record format.
//!
//! A file written by an older build cannot be appended to coherently and cannot
//! be read back, so every read of it answers with a count of noise instead of
//! an answer.
//!
//! Nothing here deletes or moves anything. These files are the caller's, and a
//! program that quietly disposes of a file it did not like leaves the caller no
//! way to know what was lost. The rule is instead: notice, refuse, and say
//! exactly what has to be removed.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::record::LogRecord;

/// A log file this build can neither read nor extend.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IncompatibleLog {
    pub path: PathBuf,
    /// The line that failed to parse, for a message that shows rather than
    /// asserts.
    pub first_line: String,
}

/// Whether a file is readable as records.
///
/// The first populated line decides. A file the current writer created is in
/// the current format from its first line onward, so a readable first line
/// proves the file readable — and a line torn by a concurrent write is never
/// the first one. A missing or blank file is readable: there is nothing in it
/// to disagree with.
pub fn inspect(path: &Path) -> Result<Option<IncompatibleLog>, String> {
    let Some(first_line) = first_populated_line(path)? else {
        return Ok(None);
    };
    if serde_json::from_str::<LogRecord>(&first_line).is_ok() {
        return Ok(None);
    }
    Ok(Some(IncompatibleLog {
        path: path.to_path_buf(),
        first_line,
    }))
}

/// Every unreadable file among `paths`, in the order given.
pub fn inspect_all(paths: &[PathBuf]) -> Result<Vec<IncompatibleLog>, String> {
    paths
        .iter()
        .filter_map(|path| inspect(path).transpose())
        .collect()
}

/// What to tell whoever has to fix this. It names every file and the exact
/// command that clears them, because "an incompatible log file" is not
/// something a caller can act on and a path is.
pub fn cleanup_message(found: &[IncompatibleLog]) -> String {
    let mut message = format!(
        "{} log file(s) are in a format this build cannot read, \
         so new records could not be appended to them coherently. \
         Delete them and start again:",
        found.len()
    );
    for log in found {
        message.push_str(&format!("\n  rm {}", log.path.display()));
    }
    message
}

/// The first line with content, or `None` for a missing or blank file.
fn first_populated_line(path: &Path) -> Result<Option<String>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Could not read the log file {}: {error}",
                path.display()
            ))
        }
    };
    for line in BufReader::new(file).lines() {
        let line = line
            .map_err(|error| format!("Could not read the log file {}: {error}", path.display()))?;
        if !line.trim().is_empty() {
            return Ok(Some(line));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::{now_timestamp, LogLevel};

    fn write(path: &Path, contents: &str) {
        std::fs::write(path, contents).unwrap();
    }

    fn record_line() -> String {
        LogRecord::new(
            now_timestamp(),
            LogLevel::Info,
            "shipctl::startup",
            Some("main"),
            "up",
        )
        .to_line()
        .unwrap()
    }

    #[test]
    fn a_file_of_current_records_is_readable() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("shipctl.log");
        write(&path, &format!("{}\n", record_line()));

        assert_eq!(inspect(&path).unwrap(), None);
    }

    /// The exact shape a pre-0.7.4 build wrote. This is the case the whole
    /// module exists for, so it is pinned literally rather than described.
    #[test]
    fn a_file_written_by_an_older_build_is_reported_and_left_alone() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("shipctl.log");
        let legacy = "[2026-08-13][05:19:14][shipctl::startup][INFO] Shipctl UI starting";
        write(&path, &format!("{legacy}\n"));

        let found = inspect(&path).unwrap().expect("an incompatible log");

        assert_eq!(found.path, path);
        assert_eq!(found.first_line, legacy);
        assert!(path.exists(), "detection must never remove the file");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format!("{legacy}\n"),
            "detection must never alter the file"
        );
    }

    /// A line torn by a concurrent write lands at the end, never at the start,
    /// so a file that opens with a record stays readable.
    #[test]
    fn a_torn_trailing_line_does_not_condemn_the_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("shipctl.log");
        write(&path, &format!("{}\n{{\"ts\":\"2026-", record_line()));

        assert_eq!(inspect(&path).unwrap(), None);
    }

    /// Leading blank lines must not be mistaken for an unreadable file, and an
    /// entirely blank file has nothing to disagree with.
    #[test]
    fn blank_lines_do_not_decide_the_format() {
        let directory = tempfile::tempdir().unwrap();

        let blank = directory.path().join("blank.log");
        write(&blank, "\n\n  \n");
        assert_eq!(inspect(&blank).unwrap(), None);

        let padded = directory.path().join("padded.log");
        write(&padded, &format!("\n\n{}\n", record_line()));
        assert_eq!(inspect(&padded).unwrap(), None);
    }

    #[test]
    fn a_missing_file_is_not_an_error() {
        let directory = tempfile::tempdir().unwrap();

        assert_eq!(inspect(&directory.path().join("absent.log")).unwrap(), None);
    }

    #[test]
    fn inspecting_several_files_reports_only_the_unreadable_ones() {
        let directory = tempfile::tempdir().unwrap();
        let good = directory.path().join("good.log");
        let bad = directory.path().join("bad.log");
        write(&good, &format!("{}\n", record_line()));
        write(&bad, "plain text\n");

        let found = inspect_all(&[good, bad.clone(), directory.path().join("absent.log")]).unwrap();

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, bad);
    }

    /// The message has to carry the path, because that is the only part of it
    /// the reader can act on.
    #[test]
    fn the_cleanup_message_names_every_file_and_the_command_that_clears_it() {
        let found = vec![
            IncompatibleLog {
                path: PathBuf::from("/logs/shipctl.log"),
                first_line: "old".to_string(),
            },
            IncompatibleLog {
                path: PathBuf::from("/logs/shipctl-notices.log"),
                first_line: "old".to_string(),
            },
        ];

        let message = cleanup_message(&found);

        assert!(message.contains("rm /logs/shipctl.log"));
        assert!(message.contains("rm /logs/shipctl-notices.log"));
        assert!(message.contains('2'));
    }
}
