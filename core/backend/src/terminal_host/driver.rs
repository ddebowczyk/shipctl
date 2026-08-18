use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalColorTheme {
    pub foreground: String,
    pub background: String,
    pub palette: Vec<String>,
}

/// Native fallback for a terminal launched through the local control endpoint.
/// UI-created terminals apply the selected product theme directly. A control
/// caller never supplies colours: terminal appearance remains a host/UI concern
/// rather than an agent-controlled launch input.
impl Default for TerminalColorTheme {
    fn default() -> Self {
        Self {
            foreground: "#e6e6e6".to_string(),
            background: "#101010".to_string(),
            palette: vec![
                "#000000".to_string(),
                "#cc0000".to_string(),
                "#00cc00".to_string(),
                "#cccc00".to_string(),
                "#0000cc".to_string(),
                "#cc00cc".to_string(),
                "#00cccc".to_string(),
                "#cccccc".to_string(),
                "#666666".to_string(),
                "#ff0000".to_string(),
                "#00ff00".to_string(),
                "#ffff00".to_string(),
                "#0000ff".to_string(),
                "#ff00ff".to_string(),
                "#00ffff".to_string(),
                "#ffffff".to_string(),
            ],
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct TerminalDriverId(String);

impl TerminalDriverId {
    pub fn new(value: impl Into<String>) -> Result<Self, TerminalDriverError> {
        let value = value.into();
        if value.is_empty()
            || !value.bytes().enumerate().all(|(index, byte)| match byte {
                b'a'..=b'z' => true,
                b'0'..=b'9' | b'-' => index > 0,
                _ => false,
            })
        {
            return Err(TerminalDriverError::new("invalid terminal driver id"));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for TerminalDriverId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for TerminalDriverId {
    type Err = TerminalDriverError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

impl<'de> Deserialize<'de> for TerminalDriverId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDriverDescriptor {
    pub id: TerminalDriverId,
    pub native_interpretation: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalByteOccurrence {
    pub sequence: u64,
    pub bytes: Vec<u8>,
}

/// Immutable host facts supplied when a selected native driver is created.
/// The driver receives no PTY reader, writer, or geometry handle.
#[derive(Clone)]
pub struct TerminalDriverSessionRequest {
    pub columns: u16,
    pub rows: u16,
    pub color_theme: TerminalColorTheme,
    pub scrollback_bytes: usize,
}

/// A driver update can contain only module-owned events and bytes that the
/// host writes through its one ordered PTY writer.
#[derive(Clone, Debug, PartialEq)]
pub struct TerminalDriverUpdate {
    /// Module-owned provider events, already framed for that driver's client.
    pub events: Vec<JsonValue>,
    pub reply_bytes: Vec<u8>,
    /// Whether this output changed the driver's presentation.
    pub presentation_changed: bool,
}

impl TerminalDriverUpdate {
    pub fn empty() -> Self {
        Self {
            events: Vec::new(),
            reply_bytes: Vec::new(),
            presentation_changed: false,
        }
    }
}

/// One opaque answer from a selected driver. The host serialises the call with
/// PTY output, but never decodes the driver's presentation or input payload.
#[derive(Clone, Debug, PartialEq)]
pub struct TerminalDriverRequestResult {
    /// Opaque response payload that belongs to the selected driver's request
    /// schema.
    pub payload: JsonValue,
    /// Bytes the host must write to the child in the same actor turn as this
    /// request. This keeps driver-encoded input ordered with PTY output.
    pub reply_bytes: Vec<u8>,
    /// Whether the request changed the driver's presentation. The host uses
    /// this only to schedule delivery; it never decodes the presentation.
    pub presentation_changed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalObservation {
    Bell,
    Title { value: String },
    Activity,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalDriverError {
    message: String,
}

impl TerminalDriverError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for TerminalDriverError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.message.fmt(formatter)
    }
}

impl std::error::Error for TerminalDriverError {}

#[cfg(test)]
mod tests {
    use super::TerminalDriverId;

    #[test]
    fn driver_ids_are_stable_lowercase_names() {
        assert_eq!(
            TerminalDriverId::new("semantic-terminal").unwrap().as_str(),
            "semantic-terminal"
        );
        assert!(TerminalDriverId::new("Semantic").is_err());
        assert!(TerminalDriverId::new("thin_terminal").is_err());
    }
}
