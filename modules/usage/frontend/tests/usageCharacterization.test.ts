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
  const adapter = source("../src/index.ts");
  const client = source("../src/usageSourcesClient.ts");
  const dataClient = source("../src/usageSettingsDataClient.ts");
  const completion = source("../src/ingestCompleted.ts");
  const panel = source("../src/UsagePanel.tsx");
  const store = source("../src/usageStore.ts");

  assert.doesNotMatch(store, /useRepoStore|activeRepoPath|projectPath/);
  assert.doesNotMatch(shell, /useUsageStore|useUsageSettingsStore|refreshUsageData/);
  assert.match(adapter, /useUsageSettingsStore\.getState\(\)\.loadSettings\(\)/);
  assert.match(adapter, /cron: "\* \* \* \* \* Etc\/UTC"/);
  assert.match(adapter, /target: \{ kind: "channel", endpoint: USAGE_REFRESH_CHANNEL \}/);
  assert.doesNotMatch(adapter, /delayMs|intervalMs|setTimeout|setInterval/);
  assert.match(adapter, /await activeUsageSourcesClient\(\)\.refreshUsageData\(\);[\s\S]*await fetchUsageSnapshots\(\)/);
  assert.match(adapter, /const usageSources = usageSourcesClientFor\(activation\)/);
  assert.match(adapter, /configureUsageSourcesClient\(usageSources\)/);
  assert.match(adapter, /usageSources\.subscribeChanges/);
  assert.match(adapter, /configureUsageSourcesClient\(null\)/);
  assert.match(client, /activation\.services\.require\(usageSourcesService\)/);
  assert.match(dataClient, /activation\.services\.require\(pluginDataService\)/);
  assert.doesNotMatch(dataClient, /@tauri-apps|invoke\(/);
  assert.match(adapter, /usage\.ingest-completed/);
  assert.match(adapter, /publishes:[\s\S]*usage\.ingest-completed/);
  assert.match(adapter, /semantic Usage Sources observer performs the refresh/);
  assert.match(panel, /subscribeUsageIngestCompleted\(fetchOverview\)/);
  assert.doesNotMatch(adapter, /["']usage-ingest-complete["']/);
  assert.match(completion, /Promise\.allSettled/);
  assert.match(adapter, /USAGE_SURFACE_ID = "core\.usage"/);
  assert.match(adapter, /surfaceId: USAGE_SURFACE_ID/);
  assert.match(adapter, /slot: "terminal\.after"/);
});

test("usage refresh exposes a strict, bounded scheduler-directed message contract", () => {
  const adapter = source("../src/index.ts");
  const manifest = source("../../module.yaml");
  const schema = JSON.parse(
    source("../../messages/refresh-request.schema.json"),
  ) as Record<string, unknown>;

  assert.match(adapter, /USAGE_REFRESH_CHANNEL: DirectedChannel<UsageRefreshRequest>/);
  assert.match(adapter, /id: "usage\.refresh-request"/);
  assert.match(adapter, /provides: \[USAGE_INGEST_COMPLETED_CONTRACT, USAGE_REFRESH_REQUEST_CONTRACT\]/);
  assert.match(
    adapter,
    /handles: \[\{[\s\S]*channel: USAGE_REFRESH_CHANNEL,[\s\S]*capacity: 1,[\s\S]*requiredGrant: "message\.send\.usage\.refresh-request",[\s\S]*schedulerAllowed: true,[\s\S]*handle: refreshUsageAndSnapshots,/,
  );
  assert.match(
    adapter,
    /async function refreshUsageAndSnapshots\(\) \{\s*await activeUsageSourcesClient\(\)\.refreshUsageData\(\);\s*await fetchUsageSnapshots\(\);\s*\}/,
  );
  assert.match(adapter, /one pending[\s\S]*refresh coalescing semantics/);

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

test("native cache, unavailable states, and capability-owned config remain bounded", () => {
  const usage = source("../../backend/src/usage/mod.rs");
  const config = source("../../../../core/backend/src/workspace/config.rs");
  const loader = source("../../../../core/backend/src/workspace/loader.rs");

  assert.match(usage, /COOLDOWN_SUCCESS_SECS: u64 = 300/);
  assert.match(usage, /COOLDOWN_ERROR_BASE_SECS: u64 = 30/);
  assert.match(usage, /COOLDOWN_ERROR_MAX_SECS: u64 = 300/);
  assert.match(usage, /PROVIDER_REFRESH_RUNNING\.swap\(true, Ordering::SeqCst\)/);
  assert.match(usage, /eprintln!\("Claude provider API error \(using cache\): \{e\}"\)/);
  assert.match(usage, /"unavailable"\.to_string\(\)/);
  assert.match(usage, /error = if cached_data\.is_none\(\) && !cache\.antigravity\.last_error\.is_empty\(\)/);

  assert.doesNotMatch(config, /pub usage: UsageSettings|struct UsageSettings|ProviderBudgetConfig/);
  assert.match(config, /fn usage_document_is_opaque_capability_data/);
  assert.match(loader, /pub fn replace_global_capability_data/);
  assert.doesNotMatch(loader, /load_usage_settings|save_usage_settings/);
});

test("native ownership seam includes ingestion, query DB, and provider subprocess access", () => {
  const host = source("../../../../src-tauri/src/lib.rs");
  const installer = source("../../../../src-tauri/src/modules/mod.rs");
  const adapter = source("../../host/src/lib.rs");
  const commands = [
    "platform",
    "projects",
    "settings",
    "terminal_host",
    "appearance",
  ].map((capability) => source(`../../../../core/tauri/src/${capability}.rs`)).join("\n");
  const client = source("../src/usageSourcesClient.ts");
  const trustedAdapter = source("../../../../core/frontend/platform/usageSources.ts");
  const packageManifest = source("../package.json");
  const plugin = source("../../backend/src/lib.rs");
  const usage = source("../../backend/src/usage/mod.rs");
  const providers = source("../../backend/src/usage/providers.rs");

  assert.doesNotMatch(host, /\.manage\(UsageDb::open\(\)/);
  assert.doesNotMatch(host, /usage::run_background_ingest\(&db\)/);
  assert.match(
    installer,
    /shipctl_module_usage_host::install\([\s\S]*plugin_data\.clone\(\)[\s\S]*message_bridges\.clone\(\)[\s\S]*paths\.usage_database\.clone\(\)/,
  );
  assert.match(adapter, /builder\.plugin\(shipctl_module_usage::init\([\s\S]*host_services\(plugin_data, messages\)[\s\S]*database_path/);
  assert.match(plugin, /plugin::Builder::new\(PLUGIN_NAME\)/);
  assert.match(plugin, /app\.manage\(UsagePluginState/);
  assert.match(plugin, /spawn_ingest\(state\.db\.clone\(\), state\.services\.clone\(\)\)/);
  assert.match(plugin, /trait UsageIngestNotifier/);
  assert.doesNotMatch(plugin, /["']usage-ingest-complete["']/);
  assert.match(plugin, /pub fn start_background_ingest<R: Runtime>/);
  assert.match(
    host,
    /ControlServer::start[\s\S]*modules::start_background_tasks\(app\.handle\(\), reconcile_external_sources\)/,
  );
  assert.match(plugin, /"plugin:shipctl-usage\|get_all_usage_snapshots"/);
  assert.match(client, /activation\.services\.require\(usageSourcesService\)/);
  assert.doesNotMatch(client, /@tauri-apps|invoke\(/);
  assert.doesNotMatch(packageManifest, /@tauri-apps\/api/);
  assert.match(trustedAdapter, /plugin:shipctl-usage\|get_all_usage_snapshots/);
  assert.match(trustedAdapter, /plugin:shipctl-usage\|get_usage_overview/);
  assert.match(trustedAdapter, /plugin:shipctl-usage\|refresh_usage_data/);
  assert.match(trustedAdapter, /observeUsageSourceMessageFrame/);
  assert.doesNotMatch(commands, /get_all_usage_snapshots|get_usage_settings|refresh_usage_data/);
  assert.doesNotMatch(host, /commands::get_all_usage_snapshots/);
  assert.doesNotMatch(host, /commands::refresh_usage_data/);
  assert.doesNotMatch(host, /mod usage;/);
  assert.match(plugin, /trait GlobalCapabilityDataAuthority/);
  assert.doesNotMatch(plugin, /ProviderSettingsAuthority|get_observed_models_for_provider|Transitional/);
  assert.match(usage, /queries::usage_overview\(&conn, window\)/);
  assert.match(providers, /run_command\(\s*"curl"/);
  assert.match(providers, /find-generic-password/);
});
