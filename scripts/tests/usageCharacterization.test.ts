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
} from "../../modules/usage/frontend/src/usageHelpers.ts";
import type {
  ProviderUsageSnapshot,
  UsageWindowSnapshot,
} from "../../modules/usage/frontend/src/types.ts";

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
  const sidebar = source("../../modules/usage/frontend/src/SidebarUsage.tsx");

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
  const snapshots = source("../../modules/usage/frontend/src/usageStore.ts");
  const settings = source("../../modules/usage/frontend/src/usageSettingsStore.ts");

  assert.match(snapshots, /set\(\{ loading: true, error: null \}\)/);
  assert.match(snapshots, /Object\.fromEntries\(snapshots\.map\(\(snapshot\) => \[snapshot\.provider, snapshot\]\)\)/);
  assert.match(snapshots, /error instanceof Error \? error\.message : "Failed to fetch usage snapshots"/);
  assert.match(settings, /const prev = get\(\)\.settings/);
  assert.match(settings, /set\(\{ settings: next, isSaving: true \}\)/);
  assert.match(settings, /await saveUsageSettings\(next\)/);
  assert.match(settings, /settings: prev,[\s\S]*"Failed to save usage settings"/);
});

test("Usage remains global across project switches and refreshes on module cadence", () => {
  const shell = source("../../src/components/layout/AppShell.tsx");
  const adapter = source("../../modules/usage/frontend/src/index.ts");
  const store = source("../../modules/usage/frontend/src/usageStore.ts");

  assert.doesNotMatch(store, /useRepoStore|activeRepoPath|projectPath/);
  assert.doesNotMatch(shell, /useUsageStore|useUsageSettingsStore|refreshUsageData/);
  assert.match(adapter, /useUsageSettingsStore\.getState\(\)\.loadSettings\(\)/);
  assert.match(adapter, /schedule: \{ kind: "delay", delayMs: 3_000 \}/);
  assert.match(adapter, /schedule: \{ kind: "interval", intervalMs: 60_000 \}/);
  assert.match(adapter, /await refreshUsageData\(\);[\s\S]*await fetchUsageSnapshots\(\)/);
  assert.match(adapter, /listen\("usage-ingest-complete", fetchUsageSnapshots\)/);
  assert.match(adapter, /USAGE_SURFACE_ID = "core\.usage"/);
  assert.match(adapter, /surfaceId: USAGE_SURFACE_ID/);
  assert.match(adapter, /slot: "terminal\.after"/);
});

test("native cache, unavailable states, and persisted config remain bounded", () => {
  const usage = source("../../modules/usage/backend/src/usage/mod.rs");
  const config = source("../../src-tauri/src/workspace/config.rs");
  const loader = source("../../src-tauri/src/workspace/loader.rs");

  assert.match(usage, /COOLDOWN_SUCCESS_SECS: u64 = 300/);
  assert.match(usage, /COOLDOWN_ERROR_BASE_SECS: u64 = 30/);
  assert.match(usage, /COOLDOWN_ERROR_MAX_SECS: u64 = 300/);
  assert.match(usage, /PROVIDER_REFRESH_RUNNING\.swap\(true, Ordering::SeqCst\)/);
  assert.match(usage, /eprintln!\("Claude provider API error \(using cache\): \{e\}"\)/);
  assert.match(usage, /"unavailable"\.to_string\(\)/);
  assert.match(usage, /error = if cached_data\.is_none\(\) && !cache\.antigravity\.last_error\.is_empty\(\)/);

  assert.match(config, /pub usage: UsageSettings/);
  assert.match(config, /rename = "budgetMode"/);
  assert.match(config, /rename = "monthlyBudget"/);
  assert.match(
    loader,
    /pub fn save_usage_settings[\s\S]*mutate_global_config\(\|config\|[\s\S]*config\.usage = settings\.clone\(\)/,
  );
});

test("native ownership seam includes ingestion, query DB, and provider subprocess access", () => {
  const host = source("../../src-tauri/src/lib.rs");
  const installer = source("../../src-tauri/src/enabled_modules.rs");
  const commands = source("../../src-tauri/src/commands.rs");
  const client = source("../../modules/usage/frontend/src/client.ts");
  const plugin = source("../../modules/usage/backend/src/lib.rs");
  const usage = source("../../modules/usage/backend/src/usage/mod.rs");
  const providers = source("../../modules/usage/backend/src/usage/providers.rs");

  assert.doesNotMatch(host, /\.manage\(UsageDb::open\(\)/);
  assert.doesNotMatch(host, /usage::run_background_ingest\(&db\)/);
  assert.match(installer, /shep_module_usage::init\([\s\S]*usage_module::host_services\(\)/);
  assert.match(plugin, /plugin::Builder::new\(PLUGIN_NAME\)/);
  assert.match(plugin, /app\.manage\(UsagePluginState/);
  assert.match(plugin, /spawn_ingest\(db, app\.clone\(\)\)/);
  assert.match(plugin, /"plugin:shep-usage\|get_all_usage_snapshots"/);
  assert.match(client, /invoke\("plugin:shep-usage\|get_all_usage_snapshots"\)/);
  assert.match(client, /invoke\("plugin:shep-usage\|refresh_usage_data"\)/);
  assert.match(commands, /pub async fn get_all_usage_snapshots/);
  assert.match(commands, /pub fn refresh_usage_data/);
  assert.doesNotMatch(host, /commands::get_all_usage_snapshots/);
  assert.doesNotMatch(host, /commands::refresh_usage_data/);
  assert.match(usage, /queries::usage_overview\(&conn, window\)/);
  assert.match(providers, /run_command\(\s*"curl"/);
  assert.match(providers, /find-generic-password/);
});
