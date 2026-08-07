//! Usage persistence, local transcript ingestion, provider quotas, and queries.

#![forbid(unsafe_code)]

mod usage;

use std::sync::Arc;

use tauri::{plugin::TauriPlugin, Emitter, Manager, Runtime, State};

pub use usage::types::{
    LocalUsageDetails, ProviderUsageSnapshot, UsageOverview, UsageProjectAliasReviewItem,
};
pub use usage::{
    get_all_usage_snapshots as query_all_usage_snapshots,
    get_models_for_provider as query_observed_models_for_provider,
    get_project_alias_review_queue as query_project_alias_review_queue,
    get_usage_overview as query_usage_overview, get_usage_snapshot as query_usage_snapshot,
    get_windowed_details as query_usage_details, run_background_ingest, EnabledProviders, UsageDb,
};

pub const PLUGIN_NAME: &str = "shep-usage";
pub const GET_ALL_USAGE_SNAPSHOTS_COMMAND: &str = "plugin:shep-usage|get_all_usage_snapshots";
pub const GET_USAGE_SNAPSHOT_COMMAND: &str = "plugin:shep-usage|get_usage_snapshot";
pub const GET_USAGE_DETAILS_COMMAND: &str = "plugin:shep-usage|get_usage_details";
pub const GET_USAGE_OVERVIEW_COMMAND: &str = "plugin:shep-usage|get_usage_overview";
pub const GET_PROJECT_ALIAS_REVIEW_QUEUE_COMMAND: &str =
    "plugin:shep-usage|get_project_alias_review_queue";
pub const GET_OBSERVED_MODELS_FOR_PROVIDER_COMMAND: &str =
    "plugin:shep-usage|get_observed_models_for_provider";
pub const REFRESH_USAGE_DATA_COMMAND: &str = "plugin:shep-usage|refresh_usage_data";

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ProviderVisibility {
    pub claude: bool,
    pub codex: bool,
    pub gemini: bool,
    pub antigravity: bool,
}

/// Read-only host authority for the provider visibility stored in global config.
pub trait ProviderSettingsAuthority: Send + Sync {
    fn provider_visibility(&self) -> ProviderVisibility;
}

#[derive(Clone)]
pub struct HostServices {
    settings: Arc<dyn ProviderSettingsAuthority>,
}

impl HostServices {
    pub fn new(settings: Arc<dyn ProviderSettingsAuthority>) -> Self {
        Self { settings }
    }
}

struct UsagePluginState {
    db: UsageDb,
    services: HostServices,
}

fn enabled_providers(services: &HostServices) -> usage::EnabledProviders {
    let visibility = services.settings.provider_visibility();
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
async fn get_observed_models_for_provider(
    state: State<'_, UsagePluginState>,
    provider: String,
) -> Result<Vec<String>, String> {
    Ok(usage::get_models_for_provider(&state.db, &provider))
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

pub fn init<R: Runtime>(services: HostServices) -> TauriPlugin<R> {
    tauri::plugin::Builder::new(PLUGIN_NAME)
        .setup(move |app, _api| {
            let db = UsageDb::open().unwrap_or_else(|error| {
                eprintln!("Usage database failed to open ({error}), using in-memory fallback");
                UsageDb::open_in_memory()
            });
            app.manage(UsagePluginState {
                db: db.clone(),
                services: services.clone(),
            });
            // Transitional flat commands use this state until the compatibility
            // layer is removed in the next migration slice.
            app.manage(db.clone());
            spawn_ingest(db, app.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_all_usage_snapshots,
            get_usage_snapshot,
            get_usage_details,
            get_usage_overview,
            get_project_alias_review_queue,
            get_observed_models_for_provider,
            refresh_usage_data,
        ])
        .build()
}

#[cfg(test)]
mod tests {
    use super::{
        ProviderVisibility, GET_ALL_USAGE_SNAPSHOTS_COMMAND, PLUGIN_NAME,
        REFRESH_USAGE_DATA_COMMAND,
    };

    #[test]
    fn exposes_namespaced_usage_contract() {
        assert_eq!(PLUGIN_NAME, "shep-usage");
        assert_eq!(
            GET_ALL_USAGE_SNAPSHOTS_COMMAND,
            "plugin:shep-usage|get_all_usage_snapshots"
        );
        assert_eq!(
            REFRESH_USAGE_DATA_COMMAND,
            "plugin:shep-usage|refresh_usage_data"
        );
        assert_eq!(
            ProviderVisibility::default(),
            ProviderVisibility {
                claude: false,
                codex: false,
                gemini: false,
                antigravity: false,
            }
        );
    }
}
