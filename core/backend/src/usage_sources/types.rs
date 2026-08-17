use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageProviderWindow {
    pub provider: String,
    pub window_id: String,
    pub window: String,
    pub label: String,
    pub scope: String,
    pub limit: Option<f64>,
    pub used: Option<f64>,
    pub source_type: String,
    pub confidence: String,
    pub cost_kind: String,
    pub used_percent: Option<f64>,
    pub remaining_percent: Option<f64>,
    pub reset_at: Option<String>,
    pub token_total: Option<u64>,
    pub pace_status: Option<String>,
}

/// One normalized transcript row or one durable daily rollup.
///
/// Paths, cursor locations, and credential material never cross this boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSourceRecord {
    pub grain: String,
    pub provider: String,
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

/// Provider-reported quota facts after credential-bound source parsing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageProviderObservation {
    pub provider: String,
    pub available: bool,
    pub fetched_at: Option<String>,
    pub summary_windows: Vec<UsageProviderWindow>,
    pub extra_windows: Vec<UsageProviderWindow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSourceDataset {
    pub captured_at: String,
    pub records: Vec<UsageSourceRecord>,
    pub provider_observations: Vec<UsageProviderObservation>,
}

/// Compatibility name used inside the credential-bound provider parsers.
pub type UsageWindowSnapshot = UsageProviderWindow;
