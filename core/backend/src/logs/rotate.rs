//! Retiring a log file whose lines predate the current record format.
//!
//! The writer owns the file format, so the writer retires a file it can no
//! longer append to coherently. Without this, a log written by an older build
//! stays in place forever and every read reports it as unparseable lines —
//! a reader asking "what did the UI log?" gets a count of noise instead of an
//! answer.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::record::LogRecord;

/// Extension appended to a retired file. The retired copy is kept rather than
/// deleted: it is the only remaining record of what the previous build did.
pub const RETIRED_EXTENSION: &str = "legacy";

/// Move `path` aside when its contents are not readable as records.
///
/// Returns the path the old file was moved to, or `None` when the file is
/// absent, empty, or already in the current format. Deciding on the first
/// non-empty line is enough: a file the current writer created is in the
/// current format from its first line onward, so a readable first line proves
/// the whole file readable.
pub fn retire_incompatible(path: &Path) -> Result<Option<PathBuf>, String> {
    let Some(first) = first_populated_line(path)? else {
        return Ok(None);
    };
    if serde_json::from_str::<LogRecord>(&first).is_ok() {
        return Ok(None);
    }

    let retired = retired_path(path);
    std::fs::rename(path, &retired)
        .map_err(|error| format!("Could not retire the log file {}: {error}", path.display()))?;
    Ok(Some(retired))
}

/// Where a retired file goes: the same name with one extension added, so it
/// sits beside the live file and is never mistaken for it.
pub fn retired_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".");
    name.push(RETIRED_EXTENSION);
    path.with_file_name(name)
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

    #[test]
    fn a_file_of_current_records_stays_where_it_is() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("shipctl.log");
        let record = LogRecord::new(
            now_timestamp(),
            LogLevel::Info,
            "shipctl::startup",
            Some("main"),
            "up",
        );
        write(&path, &format!("{}\n", record.to_line().unwrap()));

        assert_eq!(retire_incompatible(&path).unwrap(), None);
        assert!(path.exists());
    }

    /// The exact shape a pre-0.7.4 build wrote. This is the case the whole
    /// module exists for, so it is pinned literally rather than described.
    #[test]
    fn a_file_written_by_an_older_build_is_moved_aside() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("shipctl.log");
        write(
            &path,
            "[2026-08-13][05:19:14][shipctl::startup][INFO] Shipctl UI starting\n",
        );

        let retired = retire_incompatible(&path).unwrap().expect("a retired path");

        assert_eq!(retired, directory.path().join("shipctl.log.legacy"));
        assert!(!path.exists(), "the live path must be free for the writer");
        assert!(retired.exists(), "the old records must survive the move");
    }

    /// Leading blank lines must not be mistaken for an unreadable file, and an
    /// entirely blank file has nothing worth moving.
    #[test]
    fn blank_lines_do_not_decide_the_format() {
        let directory = tempfile::tempdir().unwrap();

        let blank = directory.path().join("blank.log");
        write(&blank, "\n\n  \n");
        assert_eq!(retire_incompatible(&blank).unwrap(), None);
        assert!(blank.exists());

        let padded = directory.path().join("padded.log");
        let record = LogRecord::new(now_timestamp(), LogLevel::Warn, "t", None, "x");
        write(&padded, &format!("\n\n{}\n", record.to_line().unwrap()));
        assert_eq!(retire_incompatible(&padded).unwrap(), None);
    }

    #[test]
    fn a_missing_file_is_not_an_error() {
        let directory = tempfile::tempdir().unwrap();

        assert_eq!(
            retire_incompatible(&directory.path().join("absent.log")).unwrap(),
            None
        );
    }

    /// A second format change must still leave the live path free. The earlier
    /// retired file is replaced, which is the documented cost of keeping one
    /// predictable name rather than accumulating numbered copies.
    #[test]
    fn retiring_twice_replaces_the_earlier_retired_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("shipctl.log");

        write(&path, "old format one\n");
        retire_incompatible(&path).unwrap().unwrap();
        write(&path, "old format two\n");
        let retired = retire_incompatible(&path).unwrap().unwrap();

        assert!(!path.exists());
        assert_eq!(
            std::fs::read_to_string(retired).unwrap(),
            "old format two\n"
        );
    }
}
