import { invoke } from "@tauri-apps/api/core";

import type {
  LocalUsageDetails,
  ProviderUsageSnapshot,
  UsageOverview,
  UsageProjectAliasReviewItem,
} from "./types";

export function getAllUsageSnapshots(): Promise<ProviderUsageSnapshot[]> {
  return invoke("plugin:shipctl-usage|get_all_usage_snapshots");
}

export function getUsageSnapshot(provider: string): Promise<ProviderUsageSnapshot> {
  return invoke("plugin:shipctl-usage|get_usage_snapshot", { provider });
}

export function getUsageDetails(provider: string, window: string): Promise<LocalUsageDetails> {
  return invoke("plugin:shipctl-usage|get_usage_details", { provider, window });
}

export function getUsageOverview(window: string): Promise<UsageOverview> {
  return invoke("plugin:shipctl-usage|get_usage_overview", { window });
}

export function getProjectAliasReviewQueue(): Promise<UsageProjectAliasReviewItem[]> {
  return invoke("plugin:shipctl-usage|get_project_alias_review_queue");
}

export function refreshUsageData(): Promise<void> {
  return invoke("plugin:shipctl-usage|refresh_usage_data");
}
