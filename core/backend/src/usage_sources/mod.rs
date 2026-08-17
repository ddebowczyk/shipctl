//! Reviewed usage-source access and durable transcript ingestion.
//!
//! This permanent provider owns filesystem, credential, subprocess, network,
//! and SQLite authority. It returns normalized source facts only. Pricing,
//! aggregation, aliases, refresh workflow, and presentation belong to the
//! TypeScript Usage module.

#![forbid(unsafe_code)]

mod db;
mod helpers;
mod ingest;
mod providers;
mod snapshot;
mod types;

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

pub use db::UsageDb;
pub use snapshot::UsageSnapshotProvider;
pub use types::{
    UsageProviderObservation, UsageProviderWindow, UsageSourceDataset, UsageSourceRecord,
};

use helpers::{now_epoch_seconds, now_iso_string};
use types::UsageWindowSnapshot;

pub const USAGE_SOURCES_TRANSPORT_FAILED: &str = "usage-sources.transport-failed";
pub const USAGE_SOURCES_DENIED: &str = "usage-sources.denied";
pub const USAGE_SOURCES_INVALID_REQUEST: &str = "usage-sources.invalid-request";
pub const USAGE_SOURCES_ACTIVATION_DISPOSED: &str = "usage-sources.activation-disposed";

pub const USAGE_PROVIDERS: [&str; 6] =
    ["claude", "codex", "antigravity", "gemini", "opencode", "pi"];

const PROVIDER_QUOTA_SOURCES: [&str; 4] = ["claude", "codex", "antigravity", "gemini"];
const COOLDOWN_SUCCESS_SECS: u64 = 300;
const COOLDOWN_ERROR_BASE_SECS: u64 = 30;
const COOLDOWN_ERROR_MAX_SECS: u64 = 300;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageSourcesActor {
    pub module_id: String,
    pub activation_id: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectUsageSourcesInput {
    #[serde(default)]
    pub source_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefreshUsageSourcesInput {
    #[serde(default)]
    pub source_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSourcesRefreshReceipt {
    pub accepted_source_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSourcesError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone)]
enum ProviderCacheData {
    Claude(Vec<UsageWindowSnapshot>, Vec<UsageWindowSnapshot>),
    Codex(Vec<UsageWindowSnapshot>),
    Gemini(Vec<UsageWindowSnapshot>),
    Antigravity(Vec<UsageWindowSnapshot>, Vec<UsageWindowSnapshot>),
}

#[derive(Default)]
struct ProviderState {
    cache: Option<ProviderCacheData>,
    fetched_at: u64,
    consecutive_errors: u32,
    last_error: Option<String>,
}

impl ProviderState {
    fn cooldown_secs(&self) -> u64 {
        if self.consecutive_errors == 0 {
            return COOLDOWN_SUCCESS_SECS;
        }
        let backoff = COOLDOWN_ERROR_BASE_SECS
            .saturating_mul(1u64 << self.consecutive_errors.saturating_sub(1).min(4));
        backoff.min(COOLDOWN_ERROR_MAX_SECS)
    }

    fn is_stale(&self, now: u64) -> bool {
        now.saturating_sub(self.fetched_at) >= self.cooldown_secs()
    }

    fn record_success(&mut self, now: u64, cache: ProviderCacheData) {
        self.cache = Some(cache);
        self.fetched_at = now;
        self.consecutive_errors = 0;
        self.last_error = None;
    }

    fn record_error(&mut self, now: u64, error: String) {
        let changed = self.last_error.as_deref() != Some(error.as_str());
        self.fetched_at = now;
        self.consecutive_errors = self.consecutive_errors.saturating_add(1);
        self.last_error = Some(error.clone());
        if changed {
            log::warn!(target: "shipctl::usage_sources", "Usage provider refresh failed: {error}");
        }
    }
}

#[derive(Default)]
struct ProviderCache {
    claude: ProviderState,
    codex: ProviderState,
    gemini: ProviderState,
    antigravity: ProviderState,
}

impl ProviderCache {
    fn state(&self, provider: &str) -> Option<&ProviderState> {
        match provider {
            "claude" => Some(&self.claude),
            "codex" => Some(&self.codex),
            "gemini" => Some(&self.gemini),
            "antigravity" => Some(&self.antigravity),
            _ => None,
        }
    }

    fn state_mut(&mut self, provider: &str) -> Option<&mut ProviderState> {
        match provider {
            "claude" => Some(&mut self.claude),
            "codex" => Some(&mut self.codex),
            "gemini" => Some(&mut self.gemini),
            "antigravity" => Some(&mut self.antigravity),
            _ => None,
        }
    }
}

#[derive(Default)]
struct UsageSourcesState {
    released_activations: HashSet<(String, String)>,
    provider_cache: ProviderCache,
}

struct UsageSourcesServiceInner {
    db: UsageDb,
    state: Mutex<UsageSourcesState>,
    refresh: Mutex<()>,
}

/// Permanent, Tauri-free authority for reviewed usage sources.
#[derive(Clone)]
pub struct UsageSourcesService {
    inner: Arc<UsageSourcesServiceInner>,
}

impl UsageSourcesService {
    pub fn open_at(
        path: &Path,
        durable_writes: shipctl_module_api::DurableWriteBarrier,
    ) -> Result<Self, String> {
        UsageDb::open_at_with_barrier(path, durable_writes).map(Self::new)
    }

    pub fn open_in_memory(durable_writes: shipctl_module_api::DurableWriteBarrier) -> Self {
        Self::new(UsageDb::open_in_memory_with_barrier(durable_writes))
    }

    pub fn new(db: UsageDb) -> Self {
        Self {
            inner: Arc::new(UsageSourcesServiceInner {
                db,
                state: Mutex::new(UsageSourcesState::default()),
                refresh: Mutex::new(()),
            }),
        }
    }

    pub fn inspect_sources(
        &self,
        actor: &UsageSourcesActor,
        input: InspectUsageSourcesInput,
    ) -> Result<UsageSourceDataset, UsageSourcesError> {
        self.authorize(actor)?;
        let source_ids = normalized_source_ids(input.source_ids)?;
        let records = self.read_records(&source_ids)?;
        let state = self
            .inner
            .state
            .lock()
            .expect("usage sources state poisoned");
        let provider_observations = PROVIDER_QUOTA_SOURCES
            .into_iter()
            .filter(|provider| source_ids.contains(*provider))
            .filter_map(|provider| {
                state
                    .provider_cache
                    .state(provider)
                    .map(|provider_state| observation(provider, provider_state))
            })
            .collect();
        Ok(UsageSourceDataset {
            captured_at: now_iso_string(),
            records,
            provider_observations,
        })
    }

    pub fn refresh_sources(
        &self,
        actor: &UsageSourcesActor,
        input: RefreshUsageSourcesInput,
    ) -> Result<UsageSourcesRefreshReceipt, UsageSourcesError> {
        self.authorize(actor)?;
        let source_ids = normalized_source_ids(input.source_ids)?;
        let _refresh = self
            .inner
            .refresh
            .lock()
            .expect("usage refresh lock poisoned");
        self.authorize(actor)?;

        loop {
            let done = {
                let _write = self
                    .inner
                    .db
                    .durable_writes
                    .enter_update()
                    .map_err(|error| {
                        usage_error(USAGE_SOURCES_TRANSPORT_FAILED, error.to_string())
                    })?;
                let connection = self.inner.db.conn.lock().expect("usage database poisoned");
                ingest::ingest_sources(&connection, &source_ids)
            };
            if done {
                break;
            }
            std::thread::yield_now();
        }
        self.refresh_provider_observations(&source_ids);

        Ok(UsageSourcesRefreshReceipt {
            accepted_source_ids: USAGE_PROVIDERS
                .into_iter()
                .filter(|provider| source_ids.contains(*provider))
                .map(str::to_string)
                .collect(),
        })
    }

    pub fn release_activation(&self, actor: &UsageSourcesActor) -> Result<bool, UsageSourcesError> {
        self.authorize(actor)?;
        Ok(self
            .inner
            .state
            .lock()
            .expect("usage sources state poisoned")
            .released_activations
            .insert((actor.module_id.clone(), actor.activation_id.clone())))
    }

    fn authorize(&self, actor: &UsageSourcesActor) -> Result<(), UsageSourcesError> {
        if actor.activation_id.trim().is_empty()
            || !matches!(actor.module_id.as_str(), "core" | "shipctl.usage")
        {
            return Err(usage_error(
                USAGE_SOURCES_DENIED,
                "The module activation cannot access usage sources",
            ));
        }
        if self
            .inner
            .state
            .lock()
            .expect("usage sources state poisoned")
            .released_activations
            .contains(&(actor.module_id.clone(), actor.activation_id.clone()))
        {
            return Err(usage_error(
                USAGE_SOURCES_ACTIVATION_DISPOSED,
                "The module activation is no longer active",
            ));
        }
        Ok(())
    }

    fn read_records(
        &self,
        source_ids: &HashSet<String>,
    ) -> Result<Vec<UsageSourceRecord>, UsageSourcesError> {
        let connection = self.inner.db.conn.lock().expect("usage database poisoned");
        let mut records = Vec::new();
        let mut messages = connection
            .prepare(
                "SELECT provider, session_id, project, model, timestamp,
                        tokens_input, tokens_output, tokens_cache_write,
                        tokens_cache_read, tokens_thoughts, tokens_total,
                        COALESCE(pricing_provider, provider), recorded_cost
                 FROM usage_messages
                 ORDER BY timestamp, id",
            )
            .map_err(database_error)?;
        let rows = messages
            .query_map([], |row| {
                Ok(UsageSourceRecord {
                    grain: "message".to_string(),
                    provider: row.get(0)?,
                    session_id: row.get(1)?,
                    date: None,
                    project: row.get(2)?,
                    model: row.get(3)?,
                    timestamp: row.get(4)?,
                    tokens_input: row.get(5)?,
                    tokens_output: row.get(6)?,
                    tokens_cache_write: row.get(7)?,
                    tokens_cache_read: row.get(8)?,
                    tokens_thoughts: row.get(9)?,
                    tokens_total: row.get(10)?,
                    message_count: 1,
                    pricing_provider: row.get(11)?,
                    recorded_cost: row.get(12)?,
                })
            })
            .map_err(database_error)?;
        for row in rows {
            let record = row.map_err(database_error)?;
            if source_ids.contains(&record.provider) {
                records.push(record);
            }
        }
        drop(messages);

        let mut daily = connection
            .prepare(
                "SELECT provider, date, project, model,
                        tokens_input, tokens_output, tokens_cache_write,
                        tokens_cache_read, tokens_thoughts, tokens_total,
                        message_count, COALESCE(pricing_provider, provider), recorded_cost
                 FROM usage_daily
                 ORDER BY date, id",
            )
            .map_err(database_error)?;
        let rows = daily
            .query_map([], |row| {
                Ok(UsageSourceRecord {
                    grain: "daily".to_string(),
                    provider: row.get(0)?,
                    session_id: None,
                    date: row.get(1)?,
                    project: row.get(2)?,
                    model: row.get(3)?,
                    timestamp: None,
                    tokens_input: row.get(4)?,
                    tokens_output: row.get(5)?,
                    tokens_cache_write: row.get(6)?,
                    tokens_cache_read: row.get(7)?,
                    tokens_thoughts: row.get(8)?,
                    tokens_total: row.get(9)?,
                    message_count: row.get(10)?,
                    pricing_provider: row.get(11)?,
                    recorded_cost: row.get(12)?,
                })
            })
            .map_err(database_error)?;
        for row in rows {
            let record = row.map_err(database_error)?;
            if source_ids.contains(&record.provider) {
                records.push(record);
            }
        }
        Ok(records)
    }

    fn refresh_provider_observations(&self, source_ids: &HashSet<String>) {
        let now = now_epoch_seconds();
        for provider in PROVIDER_QUOTA_SOURCES {
            if !source_ids.contains(provider) {
                continue;
            }
            let stale = self
                .inner
                .state
                .lock()
                .expect("usage sources state poisoned")
                .provider_cache
                .state(provider)
                .is_some_and(|state| state.is_stale(now));
            if !stale {
                continue;
            }
            let result = match provider {
                "claude" => providers::claude_provider_windows()
                    .map(|(summary, extra)| ProviderCacheData::Claude(summary, extra)),
                "codex" => providers::codex_provider_windows().map(ProviderCacheData::Codex),
                "gemini" => providers::gemini_provider_windows().map(ProviderCacheData::Gemini),
                "antigravity" => providers::antigravity_provider_windows()
                    .map(|(summary, extra)| ProviderCacheData::Antigravity(summary, extra)),
                _ => continue,
            };
            let mut state = self
                .inner
                .state
                .lock()
                .expect("usage sources state poisoned");
            let provider_state = state
                .provider_cache
                .state_mut(provider)
                .expect("quota provider has cache state");
            match result {
                Ok(cache) => provider_state.record_success(now, cache),
                Err(error) => provider_state.record_error(now, error),
            }
        }
    }
}

fn normalized_source_ids(
    source_ids: Option<Vec<String>>,
) -> Result<HashSet<String>, UsageSourcesError> {
    let values =
        source_ids.unwrap_or_else(|| USAGE_PROVIDERS.iter().map(ToString::to_string).collect());
    if values.is_empty()
        || values
            .iter()
            .any(|source_id| !USAGE_PROVIDERS.contains(&source_id.as_str()))
    {
        return Err(usage_error(
            USAGE_SOURCES_INVALID_REQUEST,
            "Usage source identity is invalid",
        ));
    }
    Ok(values.into_iter().collect())
}

fn observation(provider: &str, state: &ProviderState) -> UsageProviderObservation {
    let (summary_windows, extra_windows) = match state.cache.as_ref() {
        Some(ProviderCacheData::Claude(summary, extra))
        | Some(ProviderCacheData::Antigravity(summary, extra)) => (summary.clone(), extra.clone()),
        Some(ProviderCacheData::Codex(summary)) | Some(ProviderCacheData::Gemini(summary)) => {
            (summary.clone(), Vec::new())
        }
        None => (Vec::new(), Vec::new()),
    };
    UsageProviderObservation {
        provider: provider.to_string(),
        available: state.cache.is_some(),
        fetched_at: (state.fetched_at > 0).then(now_iso_string),
        summary_windows,
        extra_windows,
    }
}

fn database_error(error: rusqlite::Error) -> UsageSourcesError {
    usage_error(USAGE_SOURCES_TRANSPORT_FAILED, error.to_string())
}

fn usage_error(code: &str, message: impl Into<String>) -> UsageSourcesError {
    UsageSourcesError {
        code: code.to_string(),
        message: message.into(),
        retryable: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn actor(module_id: &str, activation_id: &str) -> UsageSourcesActor {
        UsageSourcesActor {
            module_id: module_id.to_string(),
            activation_id: activation_id.to_string(),
        }
    }

    #[test]
    fn unauthorized_modules_cannot_observe_or_refresh_sources() {
        let service = UsageSourcesService::open_in_memory(Default::default());
        let denied = actor("shipctl.unknown", "activation-1");
        assert_eq!(
            service
                .inspect_sources(&denied, InspectUsageSourcesInput::default())
                .unwrap_err()
                .code,
            USAGE_SOURCES_DENIED
        );
        assert_eq!(
            service
                .refresh_sources(&denied, RefreshUsageSourcesInput::default())
                .unwrap_err()
                .code,
            USAGE_SOURCES_DENIED
        );
    }

    #[test]
    fn release_revokes_authority_without_deleting_durable_records() {
        let service = UsageSourcesService::open_in_memory(Default::default());
        let active = actor("shipctl.usage", "activation-1");
        service
            .inner
            .db
            .conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO usage_messages
                 (provider, session_id, timestamp, tokens_total, pricing_provider)
                 VALUES ('codex', 'session-1', 1, 42, 'openai')",
                [],
            )
            .unwrap();
        assert_eq!(
            service
                .inspect_sources(&active, InspectUsageSourcesInput::default())
                .unwrap()
                .records
                .len(),
            1
        );
        assert!(service.release_activation(&active).unwrap());
        assert_eq!(
            service
                .inspect_sources(&active, InspectUsageSourcesInput::default())
                .unwrap_err()
                .code,
            USAGE_SOURCES_ACTIVATION_DISPOSED
        );
        assert_eq!(
            service
                .inner
                .db
                .conn
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM usage_messages", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn inspection_never_exposes_paths_or_credential_material() {
        let dataset = UsageSourcesService::open_in_memory(Default::default())
            .inspect_sources(
                &actor("shipctl.usage", "activation-1"),
                InspectUsageSourcesInput::default(),
            )
            .unwrap();
        let json = serde_json::to_string(&dataset).unwrap();
        for forbidden in ["filePath", "cursor", "credential", "accessToken", "csrf"] {
            assert!(
                !json.contains(forbidden),
                "leaked native authority: {forbidden}"
            );
        }
    }

    proptest! {
        #[test]
        fn architecture_provider_usage_sources_parity_property(
            provider_index in 0usize..USAGE_PROVIDERS.len(),
            session_suffix in "[a-z0-9]{1,16}",
            tokens_input in 0i64..1_000_000,
            tokens_output in 0i64..1_000_000,
            recorded_cost in proptest::option::of(0u32..1_000_000),
        ) {
            let provider = USAGE_PROVIDERS[provider_index];
            let session_id = format!("session-{session_suffix}");
            let expected_cost = recorded_cost.map(|value| f64::from(value) / 100_000.0);
            let service = UsageSourcesService::open_in_memory(Default::default());
            service.inner.db.conn.lock().unwrap().execute(
                "INSERT INTO usage_messages (
                    provider, session_id, project, model, timestamp,
                    tokens_input, tokens_output, tokens_cache_write,
                    tokens_cache_read, tokens_thoughts, tokens_total,
                    pricing_provider, recorded_cost
                 ) VALUES (?1, ?2, 'fixture-project', 'fixture-model', 42,
                           ?3, ?4, 3, 5, 7, ?5, 'fixture-pricing', ?6)",
                rusqlite::params![
                    provider,
                    session_id,
                    tokens_input,
                    tokens_output,
                    tokens_input + tokens_output + 15,
                    expected_cost,
                ],
            ).unwrap();

            let observed = service.inspect_sources(
                &actor("shipctl.usage", "parity"),
                InspectUsageSourcesInput { source_ids: Some(vec![provider.to_string()]) },
            ).unwrap();

            prop_assert_eq!(observed.records, vec![UsageSourceRecord {
                grain: "message".to_string(),
                provider: provider.to_string(),
                session_id: Some(session_id),
                date: None,
                project: Some("fixture-project".to_string()),
                model: Some("fixture-model".to_string()),
                timestamp: Some(42),
                tokens_input,
                tokens_output,
                tokens_cache_write: 3,
                tokens_cache_read: 5,
                tokens_thoughts: 7,
                tokens_total: tokens_input + tokens_output + 15,
                message_count: 1,
                pricing_provider: "fixture-pricing".to_string(),
                recorded_cost: expected_cost,
            }]);
            prop_assert!(observed.provider_observations.iter().all(|item| item.provider == provider));
        }

        #[test]
        fn architecture_provider_usage_sources_authority_property(
            known_module in any::<bool>(),
            disposed in any::<bool>(),
            valid_scope in any::<bool>(),
            provider_index in 0usize..USAGE_PROVIDERS.len(),
        ) {
            let service = UsageSourcesService::open_in_memory(Default::default());
            let candidate = actor(
                if known_module { "shipctl.usage" } else { "shipctl.unknown" },
                "authority",
            );
            if known_module && disposed {
                service.release_activation(&candidate).unwrap();
            }
            let source_id = if valid_scope {
                USAGE_PROVIDERS[provider_index].to_string()
            } else {
                "foreign-source".to_string()
            };
            let result = service.inspect_sources(
                &candidate,
                InspectUsageSourcesInput { source_ids: Some(vec![source_id]) },
            );
            let expected_code = if !known_module {
                Some(USAGE_SOURCES_DENIED)
            } else if disposed {
                Some(USAGE_SOURCES_ACTIVATION_DISPOSED)
            } else if !valid_scope {
                Some(USAGE_SOURCES_INVALID_REQUEST)
            } else {
                None
            };
            match expected_code {
                Some(code) => prop_assert_eq!(result.unwrap_err().code, code),
                None => prop_assert!(result.is_ok()),
            }
        }

        #[test]
        fn architecture_provider_usage_sources_ownership_property(
            release_owner in any::<bool>(),
            tokens in 0i64..1_000_000,
        ) {
            let service = UsageSourcesService::open_in_memory(Default::default());
            let owner = actor("shipctl.usage", "owner");
            let peer = actor("shipctl.usage", "peer");
            service.inner.db.conn.lock().unwrap().execute(
                "INSERT INTO usage_messages
                 (provider, session_id, timestamp, tokens_total, pricing_provider)
                 VALUES ('codex', 'durable-session', 1, ?1, 'openai')",
                [tokens],
            ).unwrap();
            let (released, live) = if release_owner { (&owner, &peer) } else { (&peer, &owner) };

            service.release_activation(released).unwrap();
            prop_assert_eq!(
                service.inspect_sources(released, InspectUsageSourcesInput::default()).unwrap_err().code,
                USAGE_SOURCES_ACTIVATION_DISPOSED,
            );
            let live_records = service
                .inspect_sources(live, InspectUsageSourcesInput::default())
                .unwrap()
                .records;
            prop_assert_eq!(live_records.len(), 1);
            prop_assert_eq!(live_records[0].tokens_total, tokens);
            prop_assert_eq!(
                service.inner.db.conn.lock().unwrap().query_row(
                    "SELECT COUNT(*) FROM usage_messages",
                    [],
                    |row| row.get::<_, i64>(0),
                ).unwrap(),
                1,
            );
        }
    }
}
