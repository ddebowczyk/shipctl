import { invoke } from "@tauri-apps/api/core";

import type {
  LocalUsageDetails,
  ProviderUsageSnapshot,
  UsageOverview,
  UsageProjectAliasReviewItem,
  UsageSettings,
} from "./types";

export function getUsageSettings(): Promise<UsageSettings> {
  return invoke("get_usage_settings");
}

export function saveUsageSettings(settings: UsageSettings): Promise<void> {
  return invoke("save_usage_settings", { settings });
}

export function getAllUsageSnapshots(): Promise<ProviderUsageSnapshot[]> {
  return invoke("get_all_usage_snapshots");
}

export function getUsageSnapshot(provider: string): Promise<ProviderUsageSnapshot> {
  return invoke("get_usage_snapshot", { provider });
}

export function getUsageDetails(provider: string, window: string): Promise<LocalUsageDetails> {
  return invoke("get_usage_details", { provider, window });
}

export function getUsageOverview(window: string): Promise<UsageOverview> {
  return invoke("get_usage_overview", { window });
}

export function getProjectAliasReviewQueue(): Promise<UsageProjectAliasReviewItem[]> {
  return invoke("get_project_alias_review_queue");
}

export function refreshUsageData(): Promise<void> {
  return invoke("refresh_usage_data");
}
