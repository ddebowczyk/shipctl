//! Things that happened during a parse and are not screen state.
//!
//! A bell is not a cell. A title change is not a row. These occurrences have an
//! order relative to the output around them, and a client that hears a bell
//! attributed to a later screen is told the wrong thing. So they travel as
//! their own ordered values beside the state, never folded into it.
//!
//! Every payload is copied out of the parser before the callback returns, for
//! the same reason the projection copies cells: nothing here may borrow memory
//! the parser still owns.

use serde::{Deserialize, Serialize};

/// One occurrence, as meaning.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TerminalEffect {
    /// The child set the window title.
    Title { title: String },
    /// The child reported its working directory. OSC 7 carries a URI, and it
    /// stays a URI here: turning it into a path is a host decision made where
    /// the host knows which machine the path belongs to.
    WorkingDirectory { uri: String },
    /// The child rang the bell.
    Bell,
    /// The child asked for the clipboard to be written.
    Clipboard {
        location: TerminalClipboardLocation,
        contents: Vec<TerminalClipboardContent>,
    },
}

/// Where a clipboard write is destined.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalClipboardLocation {
    Standard,
    Selection,
    Primary,
}

impl From<libghostty_vt::terminal::ClipboardLocation> for TerminalClipboardLocation {
    fn from(location: libghostty_vt::terminal::ClipboardLocation) -> Self {
        use libghostty_vt::terminal::ClipboardLocation as Source;
        match location {
            Source::Standard => Self::Standard,
            Source::Selection => Self::Selection,
            Source::Primary => Self::Primary,
        }
    }
}

/// One MIME representation of a clipboard write, owned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalClipboardContent {
    pub mime: String,
    pub data: String,
}
