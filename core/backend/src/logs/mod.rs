//! Application log records: the shape the UI writes and the CLI reads.
//!
//! The UI is a desktop application, so its diagnostics belong in a file rather
//! than on the terminal of whatever started it. This capability owns both ends
//! of that file: [`record`] defines one line, [`reader`] turns lines back into
//! records for `shipctl logs`, and [`compat`] notices a file an older build
//! wrote in a format neither side can read.

pub mod compat;
pub mod reader;
pub mod record;

pub use compat::{cleanup_message, inspect_all, IncompatibleLog};
pub use reader::{parse_since, read, LogPage, LogQuery, LogTail};
pub use record::{
    app_log_dir, format_timestamp, now_timestamp, parse_timestamp, LogLevel, LogRecord,
    LOG_FILE_STEM, NOTICE_LOG_FILE_STEM,
};
