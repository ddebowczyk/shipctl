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
let createUsageSourcesClient;
let createUsageSourcePolicy;
let SemanticServiceRegistry;
let SemanticServiceTestHost;
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
  ({ createUsageSourcesClient } = await vite.ssrLoadModule(
    "/modules/usage/frontend/src/usageSourcesClient.ts",
  ));
  ({ createUsageSourcePolicy } = await vite.ssrLoadModule(
    "/modules/usage/frontend/src/usageSourcePolicy.ts",
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
const CAPTURED_EPOCH = Date.parse(CAPTURED_AT) / 1_000;
const WINDOWS = ["5h", "7d", "30d", "365d"];
const sourceIdArbitrary = fc.integer({ min: 0, max: 1_000_000 })
  .map((value) => `fixture-${value}`);
const sourceIdsArbitrary = fc.uniqueArray(sourceIdArbitrary, { minLength: 1, maxLength: 6 });
const windowArbitrary = fc.constantFrom(...WINDOWS);
const sensitiveArbitrary = fc.uuid().map((value) => `/private/shipctl-secret-${value}`);

function record(sourceId, overrides = {}) {
  return {
    grain: "message",
    sourceId,
    sessionId: `${sourceId}-session`,
    date: null,
    project: `${sourceId}-project`,
    model: `${sourceId}-model`,
    timestamp: CAPTURED_EPOCH - 7_200,
    tokensInput: 10,
    tokensOutput: 20,
    tokensCacheWrite: 1,
    tokensCacheRead: 2,
    tokensThoughts: 3,
    tokensTotal: 36,
    messageCount: 1,
    pricingProvider: sourceId,
    recordedCost: null,
    ...overrides,
  };
}

function dataset(records = []) {
  return { capturedAt: CAPTURED_AT, records };
}

function presentation(records = [], sourceIds = []) {
  return {
    ...dataset(records),
    providerObservations: sourceIds.map((provider) => ({
      provider,
      available: true,
      fetchedAt: CAPTURED_AT,
      summaryWindows: [],
      extraWindows: [],
    })),
  };
}

function admission(moduleId) {
  return {
    artifact: {
      contentDigest: "0".repeat(64),
      entryUrl: "shipctl://test/usage-sources",
      moduleId,
      version: "0.0.0",
    },
    effectiveGrants: [
      "usage-source.read",
      "usage-source.refresh",
      "usage-source.observe",
    ],
  };
}

function transportWith(overrides = {}) {
  return {
    inspectSources: async () => dataset(),
    refreshSources: async ({ input }) => ({ acceptedSourceIds: input.sourceIds }),
    readResource: async ({ input }) => {
      const { request } = input;
      switch (request.kind) {
        case "file": return { kind: "file", resourceId: request.resourceId, content: "" };
        case "tree": return { kind: "tree", resourceId: request.resourceId, files: [] };
        case "sqlite": return { kind: "sqlite", resourceId: request.resourceId, rows: [] };
        case "processes": return { kind: "processes", resourceId: request.resourceId, output: "" };
        case "listening-ports": return { kind: "listening-ports", resourceId: request.resourceId, output: "" };
        case "http": return { kind: "http", resourceId: request.resourceId, status: 200, body: "" };
        case "keychain-password": return { kind: "keychain-password", resourceId: request.resourceId, secret: "" };
      }
    },
    releaseActivation: async () => true,
    ...overrides,
  };
}

function productionService({ moduleId = "fixture-module", transport = transportWith() } = {}) {
  const registry = new SemanticServiceRegistry([
    createUsageSourcesServiceProvider({ transport }),
  ]);
  const identity = createTestActivationIdentity(moduleId);
  const activation = registry.activate(identity, admission(moduleId));
  return {
    activation,
    identity,
    service: activation.context.services.require(usageSourcesService),
  };
}

test("architecture.usage-sources-parity.property", async () => {
  await fc.assert(fc.property(
    sourceIdArbitrary,
    windowArbitrary,
    fc.integer({ min: 0, max: 1_000_000 }),
    fc.integer({ min: 3_600, max: 17_000 }),
    (sourceId, window, tokens, age) => {
      const raw = record(sourceId, {
        timestamp: CAPTURED_EPOCH - age,
        tokensInput: tokens,
        tokensOutput: tokens,
        tokensTotal: tokens * 2,
        recordedCost: tokens / 1_000_000,
      });
      const snapshots = projectUsageSnapshots(presentation([raw], [sourceId]), [sourceId]);
      const overview = projectUsageOverview(dataset([raw]), window);

      assert.deepEqual(snapshots.map((snapshot) => snapshot.provider), [sourceId]);
      assert.equal(snapshots[0].localDetails.tokensTotal, tokens * 2);
      assert.equal(overview.totalTokens, overview.providers.reduce((sum, item) => sum + item.tokens, 0));
      assert.equal(overview.totalCost, overview.totalCostDetail.amount);
      assert.equal(overview.trend.length, { "5h": 5, "7d": 7, "30d": 30, "365d": 365 }[window]);
      assert.equal(overview.topModels.length <= 25, true);
      assert.equal(overview.topProjects.length <= 25, true);
      assert.equal(JSON.stringify({ snapshots, overview }).includes("NaN"), false);
    },
  ), propertyParameters());

  const sourceId = "fixture-source";
  const rolled = record(sourceId, {
    grain: "daily",
    sessionId: null,
    date: "2026-08-10",
    timestamp: null,
    tokensTotal: 900,
    messageCount: 3,
  });
  const detailed = record(sourceId, { tokensTotal: 100 });
  const overview = projectUsageOverview(dataset([rolled, detailed]), "7d");
  assert.equal(overview.totalTokens, 100, "daily rollups do not duplicate detailed summaries");
  assert.equal(overview.trend.reduce((sum, bucket) => sum + bucket.tokens, 0), 900);
  assert.equal(overview.activeSessions, 3);

  const aliases = projectUsageProjectAliasReview(dataset([
    record(sourceId, { project: "unknown", tokensTotal: 7 }),
    record(sourceId, { project: "/private/project", tokensTotal: 11 }),
    record(sourceId, { project: "project", tokensTotal: 13 }),
  ]));
  assert.deepEqual(aliases.map(({ rawLabel }) => rawLabel), ["/private/project", "unknown"]);
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
          return dataset(request.input.sourceIds.map((sourceId) => record(sourceId)));
        },
        releaseActivation: async (request) => { releases.push(request); return true; },
      });
      const { activation, identity, service } = productionService({ transport });
      const outcome = await service.inspectSource.execute({ kind: "source-dataset", sourceIds });
      assert.equal(outcome.result.ok, true);
      assert.deepEqual(
        outcome.result.value.dataset.records.map(({ sourceId }) => sourceId).sort(),
        [...sourceIds].sort(),
      );
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].activation, {
        moduleId: identity.moduleId,
        activationId: identity.activationId,
        effectiveGrants: ["usage-source.read", "usage-source.refresh", "usage-source.observe"],
      });
      assert.equal(requests[0].correlationId, outcome.correlationId);
      assert.deepEqual(requests[0].input, { kind: "source-dataset", sourceIds });

      const resource = await service.readResource.execute({
        sourceId: sourceIds[0],
        request: { kind: "file", resourceId: "fixture-resource", relativePath: "fixture.json" },
      });
      assert.equal(resource.result.ok, true);
      await activation.dispose();
      assert.equal(releases.length, 1);
      assert.deepEqual(releases[0].activation, requests[0].activation);

      const failed = productionService({
        transport: transportWith({ inspectSources: async () => { throw new Error(sensitive); } }),
      });
      const failure = await failed.service.inspectSource.execute({
        kind: "source-dataset",
        sourceIds: [sourceIds[0]],
      });
      assert.equal(failure.result.ok, false);
      assert.equal(failure.result.error.code, "usage-sources.transport-failed");
      assert.equal(JSON.stringify(failure).includes(sensitive), false);
      await failed.activation.dispose();
    },
  ), propertyParameters());

  for (const input of [
    { kind: "source-dataset", sourceIds: [] },
    { kind: "source-dataset", sourceIds: ["invalid_source"] },
  ]) {
    let dispatches = 0;
    const { activation, service } = productionService({
      transport: transportWith({ inspectSources: async () => { dispatches += 1; return dataset(); } }),
    });
    const outcome = await service.inspectSource.execute(input);
    assert.equal(outcome.result.ok, false);
    assert.equal(outcome.result.error.code, "usage-sources.invalid-request");
    assert.equal(dispatches, 0);
    await activation.dispose();
  }

  const excessive = productionService({
    transport: transportWith({ inspectSources: async () => dataset([record("fixture-a"), record("fixture-b")]) }),
  });
  const outcome = await excessive.service.inspectSource.execute({
    kind: "source-dataset",
    sourceIds: ["fixture-a"],
  });
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.result.error.code, "usage-sources.invalid-request");
  await excessive.activation.dispose();
});

test("architecture.usage-sources-ownership.property", async () => {
  const sourceId = "fixture-source";
  const trace = [];
  const policy = createUsageSourcePolicy({
    sourceIds: [sourceId],
    collectors: {
      [sourceId]: async (reader) => {
        const result = await reader.read({
          kind: "file",
          resourceId: "fixture-transcript",
          relativePath: "fixtures/usage.json",
        });
        if (result.kind !== "file") throw new Error("fixture resource kind mismatch");
        const parsed = JSON.parse(result.content);
        return {
          sourceId,
          records: [record(sourceId, { tokensTotal: parsed.tokensTotal })],
          observation: {
            provider: sourceId,
            available: true,
            fetchedAt: CAPTURED_AT,
            summaryWindows: [],
            extraWindows: [],
          },
        };
      },
    },
  });
  const host = new SemanticServiceTestHost([
    createFakeUsageSourcesServiceProvider({
      trace,
      readResource: ({ sourceId: requestedSource, request }) => {
        assert.equal(requestedSource, sourceId);
        assert.equal(request.kind, "file");
        return {
          kind: "file",
          resourceId: request.resourceId,
          content: JSON.stringify({ tokensTotal: 77 }),
        };
      },
    }),
  ]);
  const activation = host.activate(createTestActivationIdentity("fixture-module"));
  const client = createUsageSourcesClient(
    activation.context.services.require(usageSourcesService),
    policy,
  );
  let events = 0;
  const lease = await client.subscribeChanges(() => { events += 1; });
  await client.refreshUsageData();
  const snapshots = await client.getAllUsageSnapshots();
  const overview = await client.getUsageOverview("5h");

  assert.equal(events, 1);
  assert.deepEqual(snapshots.map(({ provider }) => provider), [sourceId]);
  assert.equal(snapshots[0].localDetails.tokensTotal, 77);
  assert.equal(overview.totalTokens, 77);
  assert.deepEqual(trace.map(({ operation }) => operation), [
    "read-resource",
    "refresh-sources",
    "inspect-source",
    "inspect-source",
  ]);
  assert.deepEqual(trace[0].request.input, {
    sourceId,
    request: {
      kind: "file",
      resourceId: "fixture-transcript",
      relativePath: "fixtures/usage.json",
    },
  });
  assert.deepEqual(trace[1].request.input.sourceIds, [sourceId]);
  assert.equal(trace[1].request.input.updates[0].records[0].tokensTotal, 77);
  await lease.dispose();
  await activation.dispose();

  const deniedHost = new SemanticServiceTestHost([
    createFakeUsageSourcesServiceProvider({ deniedGrants: ["usage-source.read"] }),
  ]);
  const deniedActivation = deniedHost.activate(createTestActivationIdentity("fixture-module"));
  const deniedClient = createUsageSourcesClient(
    deniedActivation.context.services.require(usageSourcesService),
    policy,
  );
  await assert.rejects(deniedClient.getAllUsageSnapshots(), /grant denied/);
  await deniedActivation.dispose();

  const [clientSource, policySource, nativeProvider] = await Promise.all([
    readFile(`${ROOT}/modules/usage/frontend/src/usageSourcesClient.ts`, "utf8"),
    readFile(`${ROOT}/modules/usage/frontend/src/usageSourcePolicy.ts`, "utf8"),
    readFile(`${ROOT}/core/backend/src/usage_sources/mod.rs`, "utf8"),
  ]);
  assert.match(clientSource, /readResource/);
  assert.match(policySource, /createUsageSourcePolicy/);
  assert.doesNotMatch(`${clientSource}\n${policySource}`, /@tauri-apps|invoke\(/);
  assert.doesNotMatch(nativeProvider, /tauri::|tauri_plugin|shipctl\.usage/);
  assert.doesNotMatch(nativeProvider, /claude|codex|gemini|antigravity|opencode/i);
});

test("architecture.usage-sources-closure.property", async () => {
  const [manifest, cargo, shell, moduleClient, policy] = await Promise.all([
    readFile(`${ROOT}/modules/usage/module.yaml`, "utf8"),
    readFile(`${ROOT}/src-tauri/Cargo.toml`, "utf8"),
    readFile(`${ROOT}/src-tauri/src/modules/mod.rs`, "utf8"),
    readFile(`${ROOT}/modules/usage/frontend/src/usageSourcesClient.ts`, "utf8"),
    readFile(`${ROOT}/modules/usage/frontend/src/usageSourcePolicy.ts`, "utf8"),
  ]);
  assert.doesNotMatch(
    manifest,
    /^(?:backend|host|tauri_plugin|cargo_feature|acl_capabilities):/m,
  );
  assert.doesNotMatch(`${cargo}\n${shell}`, /shipctl-module-usage|shipctl_module_usage|feature = "usage"/);
  assert.doesNotMatch(moduleClient, /source-snapshots|legacy-overview-projection|@tauri-apps/);
  assert.match(policy, /UsageSourceResourceReader/);
  await assert.rejects(access(`${ROOT}/modules/usage/backend`));
  await assert.rejects(access(`${ROOT}/modules/usage/host`));
  await assert.rejects(access(`${ROOT}/core/backend/src/usage_sources/providers.rs`));
  await assert.rejects(access(`${ROOT}/core/backend/src/usage_sources/ingest.rs`));
});
