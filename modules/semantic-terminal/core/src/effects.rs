//! Semantic occurrences reported by the native VT parser.
//!
//! These are module-owned values. The host can publish them in order, but it
//! does not interpret their parser-specific meaning.

use serde::{Deserialize, Serialize};

/// One occurrence reported while the semantic driver parsed output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TerminalEffect {
    Title {
        title: String,
    },
    WorkingDirectory {
        uri: String,
    },
    Bell,
    Clipboard {
        location: TerminalClipboardLocation,
        contents: Vec<TerminalClipboardContent>,
    },
}

/// Where the semantic parser asked a client to write clipboard data.
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

/// One owned clipboard representation from the semantic parser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalClipboardContent {
    pub mime: String,
    pub data: String,
}

#[cfg(test)]
mod tests {
    use super::TerminalClipboardLocation;

    #[test]
    fn maps_each_ghostty_clipboard_destination() {
        use libghostty_vt::terminal::ClipboardLocation as Source;

        assert_eq!(
            TerminalClipboardLocation::from(Source::Standard),
            TerminalClipboardLocation::Standard
        );
        assert_eq!(
            TerminalClipboardLocation::from(Source::Selection),
            TerminalClipboardLocation::Selection
        );
        assert_eq!(
            TerminalClipboardLocation::from(Source::Primary),
            TerminalClipboardLocation::Primary
        );
    }
}
