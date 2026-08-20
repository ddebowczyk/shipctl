import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALL_USAGE_PROVIDERS,
  barTone,
  computePace,
  formatCost,
  formatPercent,
  formatReset,
  formatTokenCount,
  getPrimaryWindow,
  getProviderLabel,
  usageTone,
} from "../src/usageHelpers.ts";
import type {
  ProviderUsageSnapshot,
  UsageWindowSnapshot,
} from "../src/types.ts";

const source = (path: string) => readFileSync(
  fileURLToPath(new URL(path, import.meta.url)),
  "utf8",
);

const fixtures = JSON.parse(source("./fixtures/usageSnapshots.json")) as Record<
  string,
  ProviderUsageSnapshot
>;

test("provider catalogue, labels, and primary-window precedence remain stable", () => {
  assert.deepEqual(ALL_USAGE_PROVIDERS, [
    "claude",
    "codex",
    "antigravity",
    "gemini",
    "opencode",
    "pi",
  ]);
  assert.deepEqual(
    ALL_USAGE_PROVIDERS.map(getProviderLabel),
    ["Claude", "Codex", "Antigravity", "Gemini", "opencode", "pi"],
  );
  assert.equal(getPrimaryWindow(fixtures.ready)?.windowId, "claude-five-hour");
  assert.equal(getPrimaryWindow(fixtures.localOnly)?.window, "30d");
  assert.equal(getPrimaryWindow(fixtures.unavailable), null);
  assert.equal(getPrimaryWindow(null), null);
});

test("empty values and utilization thresholds keep their current presentation", () => {
  assert.equal(formatPercent(null), "n/a");
  assert.equal(formatTokenCount(null), "n/a");
  assert.equal(formatCost(null), "");
  assert.equal(formatCost(0), "$0");
  assert.equal(formatCost(0.001), "<$0.01");
  assert.equal(formatTokenCount(1_500), "2K");
  assert.equal(usageTone(null), "local");
  assert.equal(usageTone({ usedPercent: null } as UsageWindowSnapshot), "local");
  assert.equal(usageTone({ usedPercent: 49.9 } as UsageWindowSnapshot), "low");
  assert.equal(usageTone({ usedPercent: 50 } as UsageWindowSnapshot), "medium");
  assert.equal(usageTone({ usedPercent: 75 } as UsageWindowSnapshot), "high");
  assert.equal(usageTone({ usedPercent: 90 } as UsageWindowSnapshot), "critical");
  assert.equal(barTone({ status: "over", elapsedPct: 10 }, 40), "medium");
  assert.equal(barTone({ status: "over", elapsedPct: 10 }, 50), "high");
});

test("reset formatting and pace use provider reset timestamps without guessing", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-08-07T04:00:00Z");
  try {
    assert.equal(formatReset(null), "No reset");
    assert.equal(formatReset("not-a-date"), "No reset");
    assert.equal(formatReset("2026-08-07T06:00:00Z"), "2h 0m");
    assert.equal(formatReset(String(Date.parse("2026-08-07T04:30:00Z") / 1000)), "30m");

    const window = fixtures.ready.summaryWindows.find((entry) => entry.window === "5h")!;
    assert.deepEqual(computePace(window), { status: "under", elapsedPct: 60 });
    assert.equal(computePace({ ...window, resetAt: null }), null);
    assert.equal(computePace({ ...window, window: "30d" }), null);
  } finally {
    Date.now = originalNow;
  }
});

test("sidebar semantics preserve settings visibility, provider-only quotas, and zero fallback", () => {
  const sidebar = source("../src/SidebarUsage.tsx");

  assert.match(sidebar, /const WINDOWS:[\s\S]*key: "5h"[\s\S]*key: "7d"/);
  assert.match(sidebar, /if \(!config\.show \|\| !snap\) return/);
  assert.match(sidebar, /sw\.usedPercent != null && sw\.sourceType === "provider"/);
  assert.match(sidebar, /provider === "antigravity"[\s\S]*sort\(\(a, b\) => \(b\.usedPercent/);
  assert.match(sidebar, /provider !== "gemini"[\s\S]*window === "24h_pro"/);
  assert.match(sidebar, /Show providers with show=true even if \$0\/no activity/);
  assert.match(sidebar, /if \(items\.length === 0\) return null/);
  assert.match(sidebar, /onClick=\{open\}/);
});

test("snapshot and persisted-settings stores bound success and failure behavior", () => {
  const snapshots = source("../src/usageStore.ts");
  const settings = source("../src/usageSettingsStore.ts");

  assert.match(snapshots, /set\(\{ loading: true, error: null \}\)/);
  assert.match(snapshots, /Object\.fromEntries\(snapshots\.map\(\(snapshot\) => \[snapshot\.provider, snapshot\]\)\)/);
  assert.match(snapshots, /error instanceof Error \? error\.message : "Failed to fetch usage snapshots"/);
  assert.match(settings, /const prev = get\(\)\.settings/);
  assert.match(settings, /set\(\{ settings: next, isSaving: true \}\)/);
  assert.match(settings, /persistence\(\)\.read\(\)/);
  assert.match(settings, /persistence\(\)\.replace\(document as ModuleJsonValue\)/);
  assert.match(settings, /\.\.\.asRecord\(persistedDocument\[provider\]\)/);
  assert.match(settings, /settings: prev,[\s\S]*"Failed to save usage settings"/);
});

test("Usage remains global across project switches and refreshes through its declared route", () => {
  const shell = source("../../../../core/frontend/shell/AppShell.tsx");
  const runtimeLoader = source("../../../../core/frontend/host/runtimeModuleLoader.ts");
  const rootPackage = source("../../../../package.json");
  const manifest = source("../../module.yaml");
  const adapter = source("../src/index.ts");
  const contributions = source("../src/pluginContributions.ts");
  const artifact = source("../../artifact/src/index.ts");
  const client = source("../src/usageSourcesClient.ts");
  const dataClient = source("../src/usageSettingsDataClient.ts");
  const completion = source("../src/ingestCompleted.ts");
  const panel = source("../src/UsagePanel.tsx");
  const store = source("../src/usageStore.ts");

  assert.doesNotMatch(store, /useRepoStore|activeRepoPath|projectPath/);
  assert.doesNotMatch(shell, /useUsageStore|useUsageSettingsStore|refreshUsageData/);
  assert.doesNotMatch(runtimeLoader, /module-usage|usageModule/);
  assert.doesNotMatch(rootPackage, /@shipctl\/module-usage/);
  assert.match(manifest, /delivery: runtime-artifact/);
  assert.match(manifest, /artifact: modules\/usage\/artifact/);
  assert.match(manifest, /profile: null/);
  assert.doesNotMatch(adapter, /ShipctlModule|usageModule/);
  assert.match(contributions, /useUsageSettingsStore\.getState\(\)\.loadSettings\(\)/);
  assert.match(contributions, /cron: "\* \* \* \* \* Etc\/UTC"/);
  assert.match(contributions, /target: \{ kind: "channel", endpoint: USAGE_REFRESH_CHANNEL \}/);
  assert.doesNotMatch(contributions, /delayMs|intervalMs|setTimeout|setInterval/);
  assert.match(contributions, /await activeUsageSourcesClient\(\)\.refreshUsageData\(\);[\s\S]*await fetchUsageSnapshots\(\)/);
  assert.match(contributions, /const usageSources = usageSourcesClientFor\(activation\)/);
  assert.match(contributions, /configureUsageSourcesClient\(usageSources\)/);
  assert.match(contributions, /sourceSubscription = await usageSources\.subscribeChanges/);
  assert.match(contributions, /await sourceSubscription\?\.dispose\(\)/);
  assert.match(contributions, /configureUsageSourcesClient\(null\)/);
  assert.match(client, /activation\.services\.require\(usageSourcesService\)/);
  assert.match(dataClient, /activation\.services\.require\(pluginDataService\)/);
  assert.doesNotMatch(dataClient, /@tauri-apps|invoke\(/);
  assert.match(contributions, /usage\.ingest-completed/);
  assert.match(contributions, /publishes:[\s\S]*usage\.ingest-completed/);
  assert.match(contributions, /semantic Usage Sources observer performs the refresh/);
  assert.match(panel, /subscribeUsageIngestCompleted\(fetchOverview\)/);
  assert.doesNotMatch(contributions, /["']usage-ingest-complete["']/);
  assert.match(completion, /Promise\.allSettled/);
  assert.match(contributions, /USAGE_SURFACE_ID = "core\.usage"/);
  assert.match(contributions, /surfaceId: USAGE_SURFACE_ID/);
  assert.match(contributions, /slot: "terminal\.after"/);
  assert.match(artifact, /DirectShipctlPluginDefinition/);
  assert.match(artifact, /context\.own\(await activateUsageRuntime\(context\), USAGE_RUNTIME_EFFECT_ID\)/);
  assert.match(artifact, /context\.contributions\.scheduledTasks\.register/);
  assert.match(artifact, /context\.contributions\.messages\.register/);
});

test("usage refresh exposes a strict, bounded scheduler-directed message contract", () => {
  const contributions = source("../src/pluginContributions.ts");
  const manifest = source("../../module.yaml");
  const schema = JSON.parse(
    source("../../messages/refresh-request.schema.json"),
  ) as Record<string, unknown>;

  assert.match(contributions, /USAGE_REFRESH_CHANNEL: DirectedChannel<UsageRefreshRequest>/);
  assert.match(contributions, /id: "usage\.refresh-request"/);
  assert.match(contributions, /provides: \[USAGE_INGEST_COMPLETED_CONTRACT, USAGE_REFRESH_REQUEST_CONTRACT\]/);
  assert.match(
    contributions,
    /handles: \[\{[\s\S]*channel: USAGE_REFRESH_CHANNEL,[\s\S]*capacity: 1,[\s\S]*requiredGrant: "message\.send\.usage\.refresh-request",[\s\S]*schedulerAllowed: true,[\s\S]*handle: refreshUsageAndSnapshots,/,
  );
  assert.match(
    contributions,
    /export async function refreshUsageAndSnapshots\(\): Promise<void> \{\s*await activeUsageSourcesClient\(\)\.refreshUsageData\(\);\s*await fetchUsageSnapshots\(\);\s*\}/,
  );
  assert.match(contributions, /one pending[\s\S]*refresh coalescing semantics/);

  assert.deepEqual(schema, {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "shipctl-artifact:///modules/usage/messages/refresh-request.schema.json",
    type: "object",
    additionalProperties: false,
  });
  assert.match(
    manifest,
    /- id: usage\.refresh-request\n      version: 1\n      schema: modules\/usage\/messages\/refresh-request\.schema\.json\n      max_encoded_bytes: 2\n      redacted_fields: \[\]\n      compatible_versions:\n        - 1/,
  );
  assert.match(
    manifest,
    /handles:\n    - id: usage\.refresh-request\n      message:\n        id: usage\.refresh-request\n        version: 1\n      capacity: 1\n      required_grant: message\.send\.usage\.refresh-request\n      scheduler_allowed: true/,
  );
});

test("generic native resource bounds leave source policy and presentation in the Usage artifact", () => {
  const usage = source("../../../../core/backend/src/usage_sources/mod.rs");
  const resources = source("../../../../core/backend/src/usage_sources/collection.rs");
  const policy = source("../src/usageSourcePolicy.ts");
  const projection = source("../src/usageProjection.ts");
  const config = source("../../../../core/backend/src/workspace/config.rs");
  const loader = source("../../../../core/backend/src/workspace/loader.rs");

  assert.match(usage, /UsageSourcesGrant/);
  assert.match(usage, /effective_grants/);
  assert.match(resources, /home_relative_path/);
  assert.match(resources, /is_read_only_sqlite_query/);
  assert.match(resources, /read_keychain_password/);
  assert.match(policy, /Claude Code-credentials/);
  assert.match(policy, /\.codex\/auth\.json/);
  assert.match(policy, /retrieveUserQuota/);
  assert.match(policy, /opencode\.db/);
  assert.match(policy, /\.pi\/agent\/sessions/);
  assert.match(projection, /observation\?\.available \? "ready" : "partial"/);

  assert.doesNotMatch(usage, /UsageProvider|provider_windows|codex_provider_windows|claude_provider_windows/);

  assert.doesNotMatch(config, /pub usage: UsageSettings|struct UsageSettings|ProviderBudgetConfig/);
  assert.match(config, /fn usage_document_is_opaque_capability_data/);
  assert.match(loader, /pub fn replace_global_capability_data/);
  assert.doesNotMatch(loader, /load_usage_settings|save_usage_settings/);
});

test("native ownership seam exposes only the generic resource port", () => {
  const host = source("../../../../src-tauri/src/lib.rs");
  const installer = source("../../../../src-tauri/src/modules/mod.rs");
  const adapter = source("../../../../core/tauri/src/usage_sources.rs");
  const commands = [
    "platform",
    "projects",
    "configuration",
    "terminal_host",
    "appearance",
  ].map((capability) => source(`../../../../core/tauri/src/${capability}.rs`)).join("\n");
  const client = source("../src/usageSourcesClient.ts");
  const trustedAdapter = source("../../../../core/frontend/platform/usageSources.ts");
  const packageManifest = source("../package.json");
  const provider = source("../../../../core/backend/src/usage_sources/mod.rs");
  const resourceBoundary = source("../../../../core/backend/src/usage_sources/collection.rs");
  const policy = source("../src/usageSourcePolicy.ts");
  const projection = source("../src/usageProjection.ts");

  assert.match(host, /UsageSourcesService::open_at/);
  assert.match(host, /\.manage\(usage_sources\)/);
  assert.doesNotMatch(installer, /usage/i);
  assert.match(adapter, /inspect_usage_sources/);
  assert.match(adapter, /refresh_usage_sources/);
  assert.match(adapter, /read_usage_source_resource/);
  assert.match(provider, /UsageSourcesGrant/);
  assert.match(provider, /pub fn release_activation/);
  assert.match(client, /activation\.services\.require\(usageSourcesService\)/);
  assert.doesNotMatch(client, /@tauri-apps|invoke\(/);
  assert.doesNotMatch(packageManifest, /@tauri-apps\/api/);
  assert.match(trustedAdapter, /inspect_usage_sources/);
  assert.match(trustedAdapter, /refresh_usage_sources/);
  assert.match(trustedAdapter, /read_usage_source_resource/);
  assert.match(projection, /projectUsageOverview/);
  assert.match(projection, /projectUsageSnapshots/);
  assert.doesNotMatch(commands, /get_all_usage_snapshots|get_usage_settings|refresh_usage_data/);
  assert.match(resourceBoundary, /bounded_command\("curl"/);
  assert.match(resourceBoundary, /find-generic-password/);
  assert.match(policy, /UsageSourceResourceReader/);
  assert.match(policy, /createUsageSourcePolicy/);
  assert.doesNotMatch(provider, /UsageProvider|provider_windows|codex_provider_windows|claude_provider_windows/);
});
