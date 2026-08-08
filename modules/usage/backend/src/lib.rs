//! Usage persistence, local transcript ingestion, provider quotas, and queries.

#![forbid(unsafe_code)]

mod snapshot;
mod usage;

use shipctl_module_api::DurableWriteBarrier;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::{plugin::TauriPlugin, Emitter, Manager, Runtime, State};

pub use snapshot::UsageSnapshotProvider;
pub use usage::types::{
    LocalUsageDetails, ProviderUsageSnapshot, UsageOverview, UsageProjectAliasReviewItem,
};
pub use usage::{
    get_all_usage_snapshots as query_all_usage_snapshots,
    get_project_alias_review_queue as query_project_alias_review_queue,
    get_usage_overview as query_usage_overview, get_usage_snapshot as query_usage_snapshot,
    get_windowed_details as query_usage_details, run_background_ingest, EnabledProviders, UsageDb,
};

pub const PLUGIN_NAME: &str = "shipctl-usage";
pub const GET_ALL_USAGE_SNAPSHOTS_COMMAND: &str = "plugin:shipctl-usage|get_all_usage_snapshots";
pub const GET_USAGE_SNAPSHOT_COMMAND: &str = "plugin:shipctl-usage|get_usage_snapshot";
pub const GET_USAGE_DETAILS_COMMAND: &str = "plugin:shipctl-usage|get_usage_details";
pub const GET_USAGE_OVERVIEW_COMMAND: &str = "plugin:shipctl-usage|get_usage_overview";
pub const GET_PROJECT_ALIAS_REVIEW_QUEUE_COMMAND: &str =
    "plugin:shipctl-usage|get_project_alias_review_queue";
pub const REFRESH_USAGE_DATA_COMMAND: &str = "plugin:shipctl-usage|refresh_usage_data";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProviderVisibility {
    pub claude: bool,
    pub codex: bool,
    pub gemini: bool,
    pub antigravity: bool,
}

impl Default for ProviderVisibility {
    fn default() -> Self {
        Self {
            claude: true,
            codex: true,
            gemini: false,
            antigravity: true,
        }
    }
}

impl ProviderVisibility {
    fn from_capability_data(value: Option<&serde_json::Value>) -> Self {
        let mut visibility = Self::default();
        let Some(settings) = value.and_then(serde_json::Value::as_object) else {
            return visibility;
        };

        for (provider, target) in [
            ("claude", &mut visibility.claude),
            ("codex", &mut visibility.codex),
            ("gemini", &mut visibility.gemini),
            ("antigravity", &mut visibility.antigravity),
        ] {
            if let Some(show) = settings
                .get(provider)
                .and_then(|entry| entry.get("show"))
                .and_then(serde_json::Value::as_bool)
            {
                *target = show;
            }
        }
        visibility
    }
}

/// Read-only access to opaque global data. Usage owns the schema under `usage`.
pub trait GlobalCapabilityDataAuthority: Send + Sync {
    fn read(&self, capability_id: &str) -> Result<Option<serde_json::Value>, String>;
}

#[derive(Clone)]
pub struct HostServices {
    global_data: Arc<dyn GlobalCapabilityDataAuthority>,
}

impl HostServices {
    pub fn new(global_data: Arc<dyn GlobalCapabilityDataAuthority>) -> Self {
        Self { global_data }
    }
}

struct UsagePluginState {
    db: UsageDb,
    services: HostServices,
}

fn enabled_providers(services: &HostServices) -> usage::EnabledProviders {
    let data = services.global_data.read("usage").ok().flatten();
    let visibility = ProviderVisibility::from_capability_data(data.as_ref());
    usage::EnabledProviders {
        claude: visibility.claude,
        codex: visibility.codex,
        gemini: visibility.gemini,
        antigravity: visibility.antigravity,
    }
}

#[tauri::command]
async fn get_all_usage_snapshots(
    state: State<'_, UsagePluginState>,
) -> Result<Vec<ProviderUsageSnapshot>, String> {
    let enabled = enabled_providers(&state.services);
    Ok(usage::get_all_usage_snapshots(&state.db, &enabled))
}

#[tauri::command]
async fn get_usage_snapshot(
    state: State<'_, UsagePluginState>,
    provider: String,
) -> Result<ProviderUsageSnapshot, String> {
    let enabled = enabled_providers(&state.services);
    usage::get_usage_snapshot(&state.db, &provider, &enabled)
}

#[tauri::command]
async fn get_usage_details(
    state: State<'_, UsagePluginState>,
    provider: String,
    window: String,
) -> Result<LocalUsageDetails, String> {
    usage::get_windowed_details(&state.db, &provider, &window)
}

#[tauri::command]
async fn get_usage_overview(
    state: State<'_, UsagePluginState>,
    window: String,
) -> Result<UsageOverview, String> {
    usage::get_usage_overview(&state.db, &window)
}

#[tauri::command]
async fn get_project_alias_review_queue(
    state: State<'_, UsagePluginState>,
) -> Result<Vec<UsageProjectAliasReviewItem>, String> {
    Ok(usage::get_project_alias_review_queue(&state.db))
}

#[tauri::command]
fn refresh_usage_data<R: Runtime>(state: State<'_, UsagePluginState>, app: tauri::AppHandle<R>) {
    spawn_ingest(state.db.clone(), app);
}

fn spawn_ingest<R: Runtime>(db: UsageDb, app: tauri::AppHandle<R>) {
    std::thread::spawn(move || {
        usage::run_background_ingest(&db);
        let _ = app.emit("usage-ingest-complete", ());
    });
}

pub fn init<R: Runtime>(
    services: HostServices,
    database_path: PathBuf,
    durable_writes: DurableWriteBarrier,
) -> TauriPlugin<R> {
    tauri::plugin::Builder::new(PLUGIN_NAME)
        .setup(move |app, _api| {
            let db = UsageDb::open_at_with_barrier(&database_path, durable_writes.clone())
                .unwrap_or_else(|error| {
                    eprintln!("Usage database failed to open ({error}), using in-memory fallback");
                    UsageDb::open_in_memory_with_barrier(durable_writes.clone())
                });
            app.manage(UsagePluginState {
                db: db.clone(),
                services: services.clone(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_all_usage_snapshots,
            get_usage_snapshot,
            get_usage_details,
            get_usage_overview,
            get_project_alias_review_queue,
            refresh_usage_data,
        ])
        .build()
}

/// Start external-source ingestion only after the host has published instance
/// readiness. This preserves the restored-state fingerprint at the readiness
/// boundary while allowing normal background reconciliation immediately after.
pub fn start_background_ingest<R: Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<UsagePluginState>();
    spawn_ingest(state.db.clone(), app.clone());
}

#[cfg(test)]
mod tests {
    use super::{
        ProviderVisibility, GET_ALL_USAGE_SNAPSHOTS_COMMAND, PLUGIN_NAME,
        REFRESH_USAGE_DATA_COMMAND,
    };

    #[test]
    fn exposes_namespaced_usage_contract() {
        assert_eq!(PLUGIN_NAME, "shipctl-usage");
        assert_eq!(
            GET_ALL_USAGE_SNAPSHOTS_COMMAND,
            "plugin:shipctl-usage|get_all_usage_snapshots"
        );
        assert_eq!(
            REFRESH_USAGE_DATA_COMMAND,
            "plugin:shipctl-usage|refresh_usage_data"
        );
        assert_eq!(
            ProviderVisibility::default(),
            ProviderVisibility {
                claude: true,
                codex: true,
                gemini: false,
                antigravity: true,
            }
        );
    }

    #[test]
    fn visibility_schema_is_owned_and_defaulted_by_usage() {
        let value = serde_json::json!({
            "claude": { "show": false, "future": "preserved by host" },
            "gemini": { "show": true },
            "codex": { "show": "invalid" }
        });

        assert_eq!(
            ProviderVisibility::from_capability_data(Some(&value)),
            ProviderVisibility {
                claude: false,
                codex: true,
                gemini: true,
                antigravity: true,
            }
        );
    }
}
