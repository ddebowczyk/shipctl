//! Narrow native contracts shared by the Shep host and internal modules.
//!
//! Contracts are added only when an extracted module needs a stable host
//! authority. Terminal transport DTOs live here so provider modules can launch
//! through the host PTY service without importing host implementation types.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum TerminalOutput {
    #[serde(rename = "data")]
    Data(String),
    #[serde(rename = "exit")]
    Exit { code: i32 },
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalColorTheme {
    pub foreground: String,
    pub background: String,
    pub palette: Vec<String>,
}
