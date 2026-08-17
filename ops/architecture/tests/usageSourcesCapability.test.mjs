import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

let vite;
let createFakeUsageSourcesServiceProvider;
let createTestActivationIdentity;
let createUsageSourcesServiceProvider;
let SemanticServiceRegistry;
let SemanticServiceTestHost;
let usageSourcesClientFor;
let usageSourcesService;
let projectUsageOverview;
let projectUsageProjectAliasReview;
let projectUsageSnapshots;

function propertyParameters() {
  const configured = process.env.SHIPCTL_PROPERTY_SEED;
  if (configured === undefined) return {};
  const seed = Number(configured);
  if (!Number.isSafeInteger(seed)) throw new Error("SHIPCTL_PROPERTY_SEED must be a safe integer");
  return { seed };
}

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({ usageSourcesService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ));
  ({
    createFakeUsageSourcesServiceProvider,
    createTestActivationIdentity,
    SemanticServiceTestHost,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
  ({ createUsageSourcesServiceProvider } = await vite.ssrLoadModule(
    "/core/frontend/platform/usageSources.ts",
  ));
  ({ SemanticServiceRegistry } = await vite.ssrLoadModule(
    "/core/frontend/runtime/index.ts",
  ));
  ({ usageSourcesClientFor } = await vite.ssrLoadModule(
    "/modules/usage/frontend/src/usageSourcesClient.ts",
  ));
  ({
    projectUsageOverview,
    projectUsageProjectAliasReview,
    projectUsageSnapshots,
  } = await vite.ssrLoadModule("/modules/usage/frontend/src/usageProjection.ts"));
});

after(async () => {
  await vite?.close();
});

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CAPTURED_AT = "2026-08-16T12:00:00Z";
const CAPTURED_EPOCH = Date.parse(CAPTURED_AT) / 1000;
const PROVIDERS = ["claude", "codex", "antigravity", "gemini", "opencode", "pi"];
const WINDOWS = ["5h", "7d", "30d", "365d"];
const providerArbitrary = fc.constantFrom(...PROVIDERS);
const windowArbitrary = fc.constantFrom(...WINDOWS);
const sourceIdsArbitrary = fc.uniqueArray(providerArbitrary, { minLength: 1 });
const sensitiveArbitrary = fc.uuid().map((value) => `/private/shipctl-secret-${value}`);

function record(provider, overrides = {}) {
  return {
    grain: "message",
    provider,
    sessionId: `${provider}-session`,
    date: null,
    project: `${provider}-project`,
    model: `${provider}-model`,
    timestamp: CAPTURED_EPOCH - 7_200,
    tokensInput: 10,
    tokensOutput: 20,
    tokensCacheWrite: 1,
    tokensCacheRead: 2,
    tokensThoughts: 3,
    tokensTotal: 36,
    messageCount: 1,
    pricingProvider: provider,
    recordedCost: null,
    ...overrides,
  };
}

function dataset(records = [], providerObservations = []) {
  return { capturedAt: CAPTURED_AT, records, providerObservations };
}

function transportWith(overrides = {}) {
  return {
    inspectSources: async () => dataset(),
    refreshSources: async ({ input }) => ({ acceptedSourceIds: input.sourceIds }),
    releaseActivation: async () => true,
    ...overrides,
  };
}

function productionService({ moduleId = "shipctl.usage", transport = transportWith() } = {}) {
  const registry = new SemanticServiceRegistry([
    createUsageSourcesServiceProvider({ transport }),
  ]);
  const identity = createTestActivationIdentity(moduleId);
  const activation = registry.activate(identity);
  return {
    activation,
    identity,
    service: activation.context.services.require(usageSourcesService),
  };
}

test("architecture.usage-sources-parity.property", async () => {
  await fc.assert(fc.property(
    providerArbitrary,
    windowArbitrary,
    fc.integer({ min: 0, max: 1_000_000 }),
    fc.integer({ min: 3_600, max: 17_000 }),
    (provider, window, tokens, age) => {
      const raw = record(provider, {
        timestamp: CAPTURED_EPOCH - age,
        tokensInput: tokens,
        tokensOutput: tokens,
        tokensTotal: tokens * 2,
        recordedCost: tokens / 1_000_000,
      });
      const source = dataset([raw]);
      const snapshots = projectUsageSnapshots(source);
      const overview = projectUsageOverview(source, window);

      assert.deepEqual(snapshots.map((snapshot) => snapshot.provider), PROVIDERS);
      assert.equal(snapshots.find((snapshot) => snapshot.provider === provider).localDetails.tokensTotal, tokens * 2);
      assert.equal(overview.totalTokens, overview.providers.reduce((sum, item) => sum + item.tokens, 0));
      assert.equal(overview.totalCost, overview.totalCostDetail.amount);
      assert.equal(overview.trend.length, { "5h": 5, "7d": 7, "30d": 30, "365d": 365 }[window]);
      assert.equal(overview.topModels.length <= 25, true);
      assert.equal(overview.topProjects.length <= 25, true);
      assert.equal(JSON.stringify({ snapshots, overview }).includes("NaN"), false);
    },
  ), propertyParameters());

  const rolled = record("claude", {
    grain: "daily",
    sessionId: null,
    date: "2026-08-10",
    timestamp: null,
    tokensTotal: 900,
    messageCount: 3,
  });
  const detailed = record("claude", { tokensTotal: 100 });
  const overview = projectUsageOverview(dataset([rolled, detailed]), "7d");
  assert.equal(overview.totalTokens, 100, "daily rollups do not duplicate detailed summaries");
  assert.equal(overview.trend.reduce((sum, bucket) => sum + bucket.tokens, 0), 900);
  assert.equal(overview.activeSessions, 3);

  const aliases = projectUsageProjectAliasReview(dataset([
    record("codex", { project: "unknown", tokensTotal: 7 }),
    record("claude", { project: "/private/project", tokensTotal: 11 }),
    record("pi", { project: "project", tokensTotal: 13 }),
  ]));
  assert.deepEqual(aliases.map(({ rawLabel }) => rawLabel), ["/private/project", "unknown"]);

  const nullSessions = projectUsageOverview(dataset([
    record("claude", { project: "null-session-project", sessionId: null }),
    record("claude", { project: "null-session-project", sessionId: null }),
  ]), "7d");
  assert.equal(nullSessions.activeSessions, 0);
  assert.equal(nullSessions.topProjects[0].sessions, 0);
});

test("architecture.usage-sources-authority.property", async () => {
  await fc.assert(fc.asyncProperty(
    sourceIdsArbitrary,
    sensitiveArbitrary,
    async (sourceIds, sensitive) => {
      const requests = [];
      const releases = [];
      const transport = transportWith({
        inspectSources: async (request) => {
          requests.push(request);
          return dataset(sourceIds.map((provider) => record(provider)));
        },
        releaseActivation: async (request) => { releases.push(request); return true; },
      });
      const { activation, identity, service } = productionService({ transport });
      const outcome = await service.inspectSource.execute({ kind: "source-dataset", sourceIds });
      assert.equal(outcome.result.ok, true);
      assert.deepEqual(
        outcome.result.value.sources.map(({ sourceId }) => sourceId).sort(),
        [...sourceIds].sort(),
      );
      assert.equal(requests.length, 1);
      assert.equal(requests[0].activation, identity);
      assert.equal(requests[0].correlationId, outcome.correlationId);
      assert.deepEqual(requests[0].input, { sourceIds });
      await activation.dispose();
      assert.equal(releases.length, 1);
      assert.equal(releases[0].activation, identity);

      const failed = productionService({
        transport: transportWith({ inspectSources: async () => { throw new Error(sensitive); } }),
      });
      const failure = await failed.service.inspectSource.execute({ kind: "source-dataset" });
      assert.equal(failure.result.ok, false);
      assert.equal(failure.result.error.code, "usage-sources.transport-failed");
      assert.equal(JSON.stringify(failure).includes(sensitive), false);
      await failed.activation.dispose();
    },
  ), propertyParameters());

  for (const input of [{ sourceIds: [] }, { sourceIds: ["foreign"] }]) {
    let dispatches = 0;
    const { activation, service } = productionService({
      transport: transportWith({ refreshSources: async () => { dispatches += 1; } }),
    });
    const outcome = await service.refreshSources.execute(input);
    assert.equal(outcome.result.ok, false);
    assert.equal(outcome.result.error.code, "usage-sources.invalid-request");
    assert.equal(dispatches, 0);
    await activation.dispose();
  }

  const excessive = productionService({
    transport: transportWith({
      inspectSources: async () => dataset([record("claude"), record("codex")]),
    }),
  });
  const outcome = await excessive.service.inspectSource.execute({
    kind: "source-dataset",
    sourceIds: ["claude"],
  });
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.result.error.code, "usage-sources.invalid-request");
  await excessive.activation.dispose();
});

test("architecture.usage-sources-ownership.property", async () => {
  await fc.assert(fc.asyncProperty(
    providerArbitrary,
    sourceIdsArbitrary,
    async (provider, refreshed) => {
      const trace = [];
      const source = dataset([record(provider)]);
      const host = new SemanticServiceTestHost([
        createFakeUsageSourcesServiceProvider({ dataset: source, trace }),
      ]);
      const activation = host.activate(createTestActivationIdentity("shipctl.usage"));
      const client = usageSourcesClientFor(activation.context);
      let events = 0;
      const lease = await client.subscribeChanges(() => { events += 1; });

      const snapshots = await client.getAllUsageSnapshots();
      const overview = await client.getUsageOverview("5h");
      assert.equal(snapshots.find((value) => value.provider === provider).localDetails.tokensTotal, 36);
      assert.equal(overview.providers[0].provider, provider);
      await client.refreshUsageData(refreshed);
      assert.equal(events, 1);
      assert.deepEqual(trace.map(({ operation }) => operation), [
        "inspect-source",
        "inspect-source",
        "refresh-sources",
      ]);
      assert.deepEqual(trace.slice(0, 2).map(({ request }) => request.input), [
        { kind: "source-dataset" },
        { kind: "source-dataset" },
      ]);
      assert.deepEqual(trace[2].request.input, { sourceIds: refreshed });
      await lease.dispose();
      await activation.dispose();
    },
  ), propertyParameters());

  const deniedHost = new SemanticServiceTestHost([
    createFakeUsageSourcesServiceProvider({ deniedGrants: ["usage-source.read"] }),
  ]);
  const deniedActivation = deniedHost.activate(createTestActivationIdentity("shipctl.usage"));
  await assert.rejects(
    usageSourcesClientFor(deniedActivation.context).getAllUsageSnapshots(),
    /grant denied/,
  );
  await deniedActivation.dispose();

  const [client, projection, nativeProvider] = await Promise.all([
    readFile(`${ROOT}/modules/usage/frontend/src/usageSourcesClient.ts`, "utf8"),
    readFile(`${ROOT}/modules/usage/frontend/src/usageProjection.ts`, "utf8"),
    readFile(`${ROOT}/core/backend/src/usage_sources/mod.rs`, "utf8"),
  ]);
  assert.doesNotMatch(`${client}\n${projection}`, /@tauri-apps|invoke\(/);
  assert.doesNotMatch(nativeProvider, /tauri::|tauri_plugin/);
  assert.match(nativeProvider, /"core" \| "shipctl\.usage"/);
});

test("architecture.usage-sources-closure.property", async () => {
  const [manifest, cargo, shell, moduleClient] = await Promise.all([
    readFile(`${ROOT}/modules/usage/module.yaml`, "utf8"),
    readFile(`${ROOT}/src-tauri/Cargo.toml`, "utf8"),
    readFile(`${ROOT}/src-tauri/src/modules/mod.rs`, "utf8"),
    readFile(`${ROOT}/modules/usage/frontend/src/usageSourcesClient.ts`, "utf8"),
  ]);
  assert.doesNotMatch(
    manifest,
    /^(?:backend|host|tauri_plugin|cargo_feature|acl_capabilities):/m,
  );
  assert.doesNotMatch(`${cargo}\n${shell}`, /shipctl-module-usage|shipctl_module_usage|feature = "usage"/);
  assert.doesNotMatch(moduleClient, /source-snapshots|legacy-overview-projection|@tauri-apps/);
  await assert.rejects(access(`${ROOT}/modules/usage/backend`));
  await assert.rejects(access(`${ROOT}/modules/usage/host`));
});
