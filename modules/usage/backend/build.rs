const COMMANDS: &[&str] = &[
    "get_all_usage_snapshots",
    "get_usage_snapshot",
    "get_usage_details",
    "get_usage_overview",
    "get_project_alias_review_queue",
    "get_observed_models_for_provider",
    "refresh_usage_data",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
