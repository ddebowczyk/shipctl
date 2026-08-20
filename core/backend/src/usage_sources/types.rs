use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One normalized transcript row or one durable daily rollup.
///
/// Paths, cursor locations, and credential material never cross this boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSourceRecord {
    pub grain: String,
    pub source_id: String,
    pub session_id: Option<String>,
    pub date: Option<String>,
    pub project: Option<String>,
    pub model: Option<String>,
    pub timestamp: Option<i64>,
    pub tokens_input: i64,
    pub tokens_output: i64,
    pub tokens_cache_write: i64,
    pub tokens_cache_read: i64,
    pub tokens_thoughts: i64,
    pub tokens_total: i64,
    pub message_count: i64,
    pub pricing_provider: String,
    pub recorded_cost: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSourceDataset {
    pub captured_at: String,
    pub records: Vec<UsageSourceRecord>,
}

/// One plugin-owned replacement for a source's normalized durable facts.
///
/// The native provider validates structural bounds and persists opaque facts;
/// it deliberately does not know how a product provider collected or parsed
/// those facts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageSourceUpdate {
    pub source_id: String,
    pub records: Vec<UsageSourceRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageSourceResourceReadInput {
    pub source_id: String,
    pub request: UsageSourceResourceRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageSourceHttpHeader {
    pub name: String,
    pub value: String,
}

/// A bounded, generic native resource read. No variant identifies a product
/// provider or dictates how a returned payload is interpreted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum UsageSourceResourceRequest {
    File {
        resource_id: String,
        relative_path: String,
        #[serde(default)]
        max_bytes: Option<usize>,
    },
    Tree {
        resource_id: String,
        relative_path: String,
        #[serde(default)]
        max_files: Option<usize>,
        #[serde(default)]
        max_bytes_per_file: Option<usize>,
        #[serde(default)]
        extensions: Option<Vec<String>>,
    },
    Sqlite {
        resource_id: String,
        relative_path: String,
        query: String,
        #[serde(default)]
        max_rows: Option<usize>,
    },
    Processes {
        resource_id: String,
    },
    #[serde(rename = "listening-ports")]
    ListeningPorts {
        resource_id: String,
    },
    Http {
        resource_id: String,
        url: String,
        method: String,
        #[serde(default)]
        headers: Option<Vec<UsageSourceHttpHeader>>,
        #[serde(default)]
        body: Option<String>,
        #[serde(default)]
        max_bytes: Option<usize>,
    },
    #[serde(rename = "keychain-password")]
    KeychainPassword {
        resource_id: String,
        service: String,
        #[serde(default)]
        account: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSourceFile {
    pub relative_path: String,
    pub content: String,
}

/// The serializable output of one generic resource read. Errors remain
/// resource-scoped and are mapped by the service to the stable public error
/// contract without exposing filesystem roots or credential values.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum UsageSourceResourceResult {
    File {
        resource_id: String,
        content: String,
    },
    Tree {
        resource_id: String,
        files: Vec<UsageSourceFile>,
    },
    Sqlite {
        resource_id: String,
        rows: Vec<serde_json::Map<String, Value>>,
    },
    Processes {
        resource_id: String,
        output: String,
    },
    #[serde(rename = "listening-ports")]
    ListeningPorts {
        resource_id: String,
        output: String,
    },
    Http {
        resource_id: String,
        status: u16,
        body: String,
    },
    #[serde(rename = "keychain-password")]
    KeychainPassword {
        resource_id: String,
        secret: String,
    },
}
