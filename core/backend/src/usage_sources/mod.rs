//! Permission-bounded usage-source storage and resource access.
//!
//! Product source identity, filesystem/keychain selection, payload parsing,
//! quota policy, and cache shape belong to the trusted TypeScript Usage
//! artifact. This permanent native capability owns only generic resource
//! boundaries, bounded persistence, and activation lifetime.

#![forbid(unsafe_code)]

mod collection;
mod db;
mod helpers;
mod snapshot;
mod types;

use std::collections::{BTreeSet, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

pub use db::UsageDb;
pub use snapshot::UsageSnapshotProvider;
pub use types::{
    UsageSourceDataset, UsageSourceFile, UsageSourceHttpHeader, UsageSourceRecord,
    UsageSourceResourceReadInput, UsageSourceResourceRequest, UsageSourceResourceResult,
    UsageSourceUpdate,
};

use helpers::now_iso_string;

pub const USAGE_SOURCES_TRANSPORT_FAILED: &str = "usage-sources.transport-failed";
pub const USAGE_SOURCES_DENIED: &str = "usage-sources.denied";
pub const USAGE_SOURCES_INVALID_REQUEST: &str = "usage-sources.invalid-request";
pub const USAGE_SOURCES_UNAVAILABLE: &str = "usage-sources.unavailable";
pub const USAGE_SOURCES_ACTIVATION_DISPOSED: &str = "usage-sources.activation-disposed";

const MAX_SOURCE_IDS: usize = 64;
const MAX_UPDATES: usize = 64;
const MAX_RECORDS_PER_UPDATE: usize = 100_000;
const MAX_TEXT_LENGTH: usize = 16 * 1024;

/// Grants passed from the trusted semantic-service binding. The native layer
/// knows this reusable capability vocabulary, but never a product module or
/// source allowlist.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub enum UsageSourcesGrant {
    #[serde(rename = "usage-source.read")]
    Read,
    #[serde(rename = "usage-source.refresh")]
    Refresh,
    #[serde(rename = "usage-source.observe")]
    Observe,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageSourcesActor {
    pub module_id: String,
    pub activation_id: String,
    pub effective_grants: BTreeSet<UsageSourcesGrant>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectUsageSourcesInput {
    #[serde(default)]
    pub source_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefreshUsageSourcesInput {
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub updates: Option<Vec<UsageSourceUpdate>>,
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

#[derive(Default)]
struct UsageSourcesState {
    released_activations: HashSet<(String, String)>,
}

struct UsageSourcesServiceInner {
    db: UsageDb,
    state: Mutex<UsageSourcesState>,
    refresh: Mutex<()>,
}

/// Permanent, Tauri-free authority for generic Usage source resources.
#[derive(Clone)]
pub struct UsageSourcesService {
    inner: Arc<UsageSourcesServiceInner>,
}

impl UsageSourcesService {
    pub fn open_at(
        path: &Path,
        durable_writes: crate::state::DurableWriteBarrier,
    ) -> Result<Self, String> {
        UsageDb::open_at_with_barrier(path, durable_writes).map(Self::new)
    }

    pub fn open_in_memory(durable_writes: crate::state::DurableWriteBarrier) -> Self {
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
        self.authorize(actor, UsageSourcesGrant::Read)?;
        let source_ids = normalized_source_ids(input.source_ids)?;
        let records = self.read_records(&source_ids)?;
        Ok(UsageSourceDataset {
            captured_at: now_iso_string(),
            records,
        })
    }

    /// Commit plugin-parsed source facts atomically. The source id is opaque to
    /// this layer: it is only a namespace for replacement and inspection.
    pub fn refresh_sources(
        &self,
        actor: &UsageSourcesActor,
        input: RefreshUsageSourcesInput,
    ) -> Result<UsageSourcesRefreshReceipt, UsageSourcesError> {
        self.authorize(actor, UsageSourcesGrant::Refresh)?;
        let source_ids = normalized_source_ids(input.source_ids)?;
        let _refresh = self
            .inner
            .refresh
            .lock()
            .expect("usage refresh lock poisoned");
        self.authorize(actor, UsageSourcesGrant::Refresh)?;
        if let Some(updates) = input.updates {
            self.commit_updates(&source_ids, &updates)?;
        }
        Ok(UsageSourcesRefreshReceipt {
            accepted_source_ids: source_ids,
        })
    }

    /// Execute exactly one declared generic resource read. The caller receives
    /// no home directory, raw native handle, Tauri API, or durable DB handle.
    pub fn read_resource(
        &self,
        actor: &UsageSourcesActor,
        input: UsageSourceResourceReadInput,
    ) -> Result<UsageSourceResourceResult, UsageSourcesError> {
        self.authorize(actor, UsageSourcesGrant::Read)?;
        if !valid_source_id(&input.source_id) {
            return Err(usage_error(
                USAGE_SOURCES_INVALID_REQUEST,
                "Usage source identity is invalid",
            ));
        }
        collection::read_resource(input.request).map_err(|message| {
            let code = if message.contains("unavailable") {
                USAGE_SOURCES_UNAVAILABLE
            } else {
                USAGE_SOURCES_INVALID_REQUEST
            };
            usage_error(code, message)
        })
    }

    pub fn release_activation(&self, actor: &UsageSourcesActor) -> Result<bool, UsageSourcesError> {
        self.authorize_active(actor)?;
        Ok(self
            .inner
            .state
            .lock()
            .expect("usage sources state poisoned")
            .released_activations
            .insert((actor.module_id.clone(), actor.activation_id.clone())))
    }

    fn authorize_active(&self, actor: &UsageSourcesActor) -> Result<(), UsageSourcesError> {
        // Admission and effective-grant checks are enforced by the trusted
        // TypeScript semantic-service binding. Native code receives no
        // product-module allowlist: it only revokes a disposed activation.
        if actor.module_id.trim().is_empty() || actor.activation_id.trim().is_empty() {
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

    fn authorize(
        &self,
        actor: &UsageSourcesActor,
        grant: UsageSourcesGrant,
    ) -> Result<(), UsageSourcesError> {
        self.authorize_active(actor)?;
        if actor.effective_grants.contains(&grant) {
            Ok(())
        } else {
            Err(usage_error(
                USAGE_SOURCES_DENIED,
                "The module activation lacks the required usage source grant",
            ))
        }
    }

    fn commit_updates(
        &self,
        source_ids: &[String],
        updates: &[UsageSourceUpdate],
    ) -> Result<(), UsageSourcesError> {
        if updates.is_empty() || updates.len() > MAX_UPDATES {
            return Err(usage_error(
                USAGE_SOURCES_INVALID_REQUEST,
                "Usage source updates are invalid",
            ));
        }
        let requested = source_ids.iter().collect::<HashSet<_>>();
        let update_ids = updates
            .iter()
            .map(|update| &update.source_id)
            .collect::<HashSet<_>>();
        if update_ids.len() != updates.len()
            || requested.len() != update_ids.len()
            || requested
                .iter()
                .any(|source_id| !update_ids.contains(source_id))
        {
            return Err(usage_error(
                USAGE_SOURCES_INVALID_REQUEST,
                "Usage source updates must exactly match their requested source identities",
            ));
        }
        for update in updates {
            validate_update(update)?;
        }

        let _write = self
            .inner
            .db
            .durable_writes
            .enter_update()
            .map_err(|error| usage_error(USAGE_SOURCES_TRANSPORT_FAILED, error.to_string()))?;
        let mut connection = self.inner.db.conn.lock().expect("usage database poisoned");
        let transaction = connection.transaction().map_err(database_error)?;
        for update in updates {
            transaction
                .execute(
                    "DELETE FROM usage_messages WHERE provider = ?1",
                    [&update.source_id],
                )
                .map_err(database_error)?;
            transaction
                .execute(
                    "DELETE FROM usage_daily WHERE provider = ?1",
                    [&update.source_id],
                )
                .map_err(database_error)?;
            for record in &update.records {
                match record.grain.as_str() {
                    "message" => {
                        transaction
                            .execute(
                                "INSERT INTO usage_messages (
                                provider, session_id, project, model, timestamp,
                                tokens_input, tokens_output, tokens_cache_write,
                                tokens_cache_read, tokens_thoughts, tokens_total,
                                pricing_provider, recorded_cost
                             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                                rusqlite::params![
                                    record.source_id,
                                    record.session_id,
                                    record.project,
                                    record.model,
                                    record.timestamp,
                                    record.tokens_input,
                                    record.tokens_output,
                                    record.tokens_cache_write,
                                    record.tokens_cache_read,
                                    record.tokens_thoughts,
                                    record.tokens_total,
                                    record.pricing_provider,
                                    record.recorded_cost,
                                ],
                            )
                            .map_err(database_error)?;
                    }
                    "daily" => {
                        transaction
                            .execute(
                                "INSERT INTO usage_daily (
                                provider, date, project, model,
                                tokens_input, tokens_output, tokens_cache_write,
                                tokens_cache_read, tokens_thoughts, tokens_total,
                                message_count, pricing_provider, recorded_cost
                             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                                rusqlite::params![
                                    record.source_id,
                                    record.date,
                                    record.project,
                                    record.model,
                                    record.tokens_input,
                                    record.tokens_output,
                                    record.tokens_cache_write,
                                    record.tokens_cache_read,
                                    record.tokens_thoughts,
                                    record.tokens_total,
                                    record.message_count,
                                    record.pricing_provider,
                                    record.recorded_cost,
                                ],
                            )
                            .map_err(database_error)?;
                    }
                    _ => unreachable!("update validated before storage"),
                }
            }
        }
        transaction.commit().map_err(database_error)?;
        drop(connection);

        Ok(())
    }

    fn read_records(
        &self,
        source_ids: &[String],
    ) -> Result<Vec<UsageSourceRecord>, UsageSourcesError> {
        let source_ids = source_ids.iter().collect::<HashSet<_>>();
        let connection = self.inner.db.conn.lock().expect("usage database poisoned");
        let mut records = Vec::new();
        let mut messages = connection
            .prepare(
                "SELECT provider, session_id, project, model, timestamp,
                        tokens_input, tokens_output, tokens_cache_write,
                        tokens_cache_read, tokens_thoughts, tokens_total,
                        COALESCE(pricing_provider, ''), recorded_cost
                 FROM usage_messages
                 ORDER BY timestamp, id",
            )
            .map_err(database_error)?;
        let rows = messages
            .query_map([], |row| {
                Ok(UsageSourceRecord {
                    grain: "message".to_string(),
                    source_id: row.get(0)?,
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
            if source_ids.contains(&record.source_id) {
                records.push(record);
            }
        }
        drop(messages);

        let mut daily = connection
            .prepare(
                "SELECT provider, date, project, model,
                        tokens_input, tokens_output, tokens_cache_write,
                        tokens_cache_read, tokens_thoughts, tokens_total,
                        message_count, COALESCE(pricing_provider, ''), recorded_cost
                 FROM usage_daily
                 ORDER BY date, id",
            )
            .map_err(database_error)?;
        let rows = daily
            .query_map([], |row| {
                Ok(UsageSourceRecord {
                    grain: "daily".to_string(),
                    source_id: row.get(0)?,
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
            if source_ids.contains(&record.source_id) {
                records.push(record);
            }
        }
        Ok(records)
    }
}

fn normalized_source_ids(source_ids: Vec<String>) -> Result<Vec<String>, UsageSourcesError> {
    if source_ids.is_empty()
        || source_ids.len() > MAX_SOURCE_IDS
        || source_ids
            .iter()
            .any(|source_id| !valid_source_id(source_id))
        || source_ids.iter().collect::<HashSet<_>>().len() != source_ids.len()
    {
        return Err(usage_error(
            USAGE_SOURCES_INVALID_REQUEST,
            "Usage source identity is invalid",
        ));
    }
    Ok(source_ids)
}

fn valid_source_id(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some(first) if first.is_ascii_lowercase())
        && value.len() <= 64
        && characters.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}

fn valid_text(value: &str) -> bool {
    value.len() <= MAX_TEXT_LENGTH && !value.chars().any(char::is_control)
}

fn validate_update(update: &UsageSourceUpdate) -> Result<(), UsageSourcesError> {
    if !valid_source_id(&update.source_id) || update.records.len() > MAX_RECORDS_PER_UPDATE {
        return Err(usage_error(
            USAGE_SOURCES_INVALID_REQUEST,
            "Usage source update is invalid",
        ));
    }
    for record in &update.records {
        let message = record.grain == "message";
        let daily = record.grain == "daily";
        if !(message || daily)
            || record.source_id != update.source_id
            || !valid_text(&record.pricing_provider)
            || record.tokens_input < 0
            || record.tokens_output < 0
            || record.tokens_cache_write < 0
            || record.tokens_cache_read < 0
            || record.tokens_thoughts < 0
            || record.tokens_total < 0
            || record.message_count < 0
            || (message && (record.session_id.is_none() || record.timestamp.is_none()))
            || (daily && record.date.is_none())
        {
            return Err(usage_error(
                USAGE_SOURCES_INVALID_REQUEST,
                "Usage source record is invalid",
            ));
        }
    }
    Ok(())
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

    fn actor(
        module_id: &str,
        activation_id: &str,
        grants: &[UsageSourcesGrant],
    ) -> UsageSourcesActor {
        UsageSourcesActor {
            module_id: module_id.to_string(),
            activation_id: activation_id.to_string(),
            effective_grants: grants.iter().copied().collect(),
        }
    }

    fn full_actor(module_id: &str, activation_id: &str) -> UsageSourcesActor {
        actor(
            module_id,
            activation_id,
            &[
                UsageSourcesGrant::Read,
                UsageSourcesGrant::Refresh,
                UsageSourcesGrant::Observe,
            ],
        )
    }

    fn message_record(source_id: &str, tokens: i64) -> UsageSourceRecord {
        UsageSourceRecord {
            grain: "message".to_string(),
            source_id: source_id.to_string(),
            session_id: Some("fixture-session".to_string()),
            date: None,
            project: Some("fixture-project".to_string()),
            model: Some("fixture-model".to_string()),
            timestamp: Some(42),
            tokens_input: tokens,
            tokens_output: 0,
            tokens_cache_write: 0,
            tokens_cache_read: 0,
            tokens_thoughts: 0,
            tokens_total: tokens,
            message_count: 1,
            pricing_provider: "fixture-pricing".to_string(),
            recorded_cost: None,
        }
    }

    #[test]
    fn empty_or_disposed_activations_are_denied_without_a_product_allowlist() {
        let service = UsageSourcesService::open_in_memory(Default::default());
        let empty = full_actor("", "activation-1");
        assert_eq!(
            service
                .inspect_sources(
                    &empty,
                    InspectUsageSourcesInput {
                        source_ids: vec!["fixture".to_string()]
                    }
                )
                .unwrap_err()
                .code,
            USAGE_SOURCES_DENIED
        );
        let active = full_actor("fixture.module", "activation-1");
        assert!(service
            .inspect_sources(
                &active,
                InspectUsageSourcesInput {
                    source_ids: vec!["fixture".to_string()]
                }
            )
            .is_ok());
        assert!(service.release_activation(&active).unwrap());
        assert_eq!(
            service
                .inspect_sources(
                    &active,
                    InspectUsageSourcesInput {
                        source_ids: vec!["fixture".to_string()]
                    }
                )
                .unwrap_err()
                .code,
            USAGE_SOURCES_ACTIVATION_DISPOSED
        );
    }

    #[test]
    fn refresh_replaces_only_plugin_declared_source_facts() {
        let service = UsageSourcesService::open_in_memory(Default::default());
        let active = full_actor("fixture.module", "activation-1");
        let source_id = "fixture-source".to_string();
        service
            .refresh_sources(
                &active,
                RefreshUsageSourcesInput {
                    source_ids: vec![source_id.clone()],
                    updates: Some(vec![UsageSourceUpdate {
                        source_id: source_id.clone(),
                        records: vec![message_record(&source_id, 42)],
                    }]),
                },
            )
            .unwrap();
        let dataset = service
            .inspect_sources(
                &active,
                InspectUsageSourcesInput {
                    source_ids: vec![source_id],
                },
            )
            .unwrap();
        assert_eq!(dataset.records.len(), 1);
        assert_eq!(dataset.records[0].tokens_total, 42);
    }

    #[test]
    fn inspection_never_exposes_paths_or_credential_material() {
        let dataset = UsageSourcesService::open_in_memory(Default::default())
            .inspect_sources(
                &full_actor("fixture.module", "activation-1"),
                InspectUsageSourcesInput {
                    source_ids: vec!["fixture".to_string()],
                },
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
        fn architecture_provider_usage_sources_parity_property_generic_source_ids_round_trip(
            suffix in "[a-z0-9]{1,16}",
            tokens in 0i64..1_000_000,
        ) {
            let source_id = format!("fixture-{suffix}");
            let service = UsageSourcesService::open_in_memory(Default::default());
            let active = full_actor("fixture.module", "parity");
            service.refresh_sources(
                &active,
                RefreshUsageSourcesInput {
                    source_ids: vec![source_id.clone()],
                    updates: Some(vec![UsageSourceUpdate {
                        source_id: source_id.clone(),
                        records: vec![message_record(&source_id, tokens)],
                    }]),
                },
            ).unwrap();
            let observed = service.inspect_sources(
                &active,
                InspectUsageSourcesInput { source_ids: vec![source_id.clone()] },
            ).unwrap();
            prop_assert_eq!(observed.records, vec![message_record(&source_id, tokens)]);
        }

        #[test]
        fn architecture_provider_usage_sources_authority_property_invalid_source_ids_are_rejected(
            invalid_source_id in prop_oneof![
                Just(String::new()),
                "[A-Z][a-z0-9]{0,16}",
                "[a-z]{1,12}_[a-z]{1,12}",
                "[a-z]{1,12}![a-z]{0,12}",
            ],
        ) {
            let service = UsageSourcesService::open_in_memory(Default::default());
            let active = full_actor("fixture.module", "authority");
            let error = service.inspect_sources(
                &active,
                InspectUsageSourcesInput { source_ids: vec![invalid_source_id] },
            ).unwrap_err();
            prop_assert_eq!(error.code, USAGE_SOURCES_INVALID_REQUEST);
        }

        #[test]
        fn architecture_provider_usage_sources_ownership_property_released_activations_are_revoked(
            suffix in "[a-z0-9]{1,16}",
        ) {
            let source_id = format!("fixture-{suffix}");
            let service = UsageSourcesService::open_in_memory(Default::default());
            let active = full_actor("fixture.module", "ownership");
            prop_assert!(service.release_activation(&active).unwrap());
            let error = service.inspect_sources(
                &active,
                InspectUsageSourcesInput { source_ids: vec![source_id] },
            ).unwrap_err();
            prop_assert_eq!(error.code, USAGE_SOURCES_ACTIVATION_DISPOSED);
        }
    }

    #[test]
    fn absent_grant_is_denied_before_any_native_usage_source_access() {
        let service = UsageSourcesService::open_in_memory(Default::default());
        let actor = actor("fixture.module", "activation-1", &[]);
        assert_eq!(
            service
                .inspect_sources(
                    &actor,
                    InspectUsageSourcesInput {
                        source_ids: vec!["fixture".to_string()]
                    }
                )
                .unwrap_err()
                .code,
            USAGE_SOURCES_DENIED,
        );
    }
}
