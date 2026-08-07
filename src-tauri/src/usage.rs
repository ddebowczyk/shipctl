//! Transitional host aliases for flat Usage commands.
//!
//! The implementation is owned by the internal Usage plugin. These aliases
//! exist only until flat command compatibility is removed.

pub use shep_module_usage::{
    query_all_usage_snapshots as get_all_usage_snapshots,
    query_observed_models_for_provider as get_models_for_provider,
    query_project_alias_review_queue as get_project_alias_review_queue,
    query_usage_details as get_windowed_details, query_usage_overview as get_usage_overview,
    query_usage_snapshot as get_usage_snapshot, run_background_ingest, EnabledProviders,
    LocalUsageDetails, ProviderUsageSnapshot, UsageDb, UsageOverview, UsageProjectAliasReviewItem,
};
