use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotClassification {
    Portable,
    ReferenceOnly,
    Secret,
    LiveOnly,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SnapshotEntryDeclaration {
    pub id: &'static str,
    pub classification: SnapshotClassification,
    /// Physical paths, relative to the instance state root, whose existence is
    /// classified by this entry. Logical exclusions may leave this empty.
    pub source_paths: Vec<PathBuf>,
    /// Promotion path for a portable payload. Exclusions have no target.
    pub target_path: Option<PathBuf>,
    pub redaction: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapturedSnapshotEntry {
    pub id: &'static str,
    pub payload: Option<Vec<u8>>,
    pub decision: String,
}
