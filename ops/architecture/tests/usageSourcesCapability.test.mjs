import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

let vite;
let createFakeUsageSourcesServiceProvider;
let createTestActivationIdentity;
let createUsageSourcesServiceProvider;
let FakeUsageSourceChangeController;
let SemanticServiceRegistry;
let SemanticServiceTestHost;
let usageSourcesClientFor;
let usageSourcesService;

function propertyParameters() {
  const configured = process.env.SHIPCTL_PROPERTY_SEED;
  if (configured === undefined) return {};
  const seed = Number(configured);
  if (!Number.isSafeInteger(seed)) {
    throw new Error("SHIPCTL_PROPERTY_SEED must be a safe integer");
  }
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
    FakeUsageSourceChangeController,
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
});

after(async () => {
  await vite?.close();
});

const PROVIDERS = ["claude", "codex", "antigravity", "gemini", "opencode", "pi"];
const WINDOWS = ["5h", "7d", "30d", "365d"];
const providerArbitrary = fc.constantFrom(...PROVIDERS);
const windowArbitrary = fc.constantFrom(...WINDOWS);
const sourceIdsArbitrary = fc.uniqueArray(providerArbitrary, { minLength: 1 });
const sensitiveArbitrary = fc.uuid().map((value) => `/private/shipctl-secret-${value}`);

function snapshot(provider, overrides = {}) {
  return {
    provider,
    status: "ready",
    fetchedAt: "2026-08-16T12:00:00Z",
    summaryWindows: [],
    extraWindows: [],
    localDetails: null,
    error: null,
    ...overrides,
  };
}

function overview(window, provider = "claude") {
  const costDetail = {
    amount: null,
    kind: "unknown",
    basis: "none",
    confidence: "observed",
  };
  return {
    window,
    totalTokens: 0,
    totalCost: null,
    totalCostDetail: costDetail,
    activeProjects: 0,
    activeSessions: 0,
    providers: [{
      provider,
      tokens: 0,
      tokensInput: 0,
      tokensOutput: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      tokensThoughts: 0,
      cost: null,
      costDetail,
      sharePercent: 0,
      trend: [],
    }],
    trend: [],
    topModels: [],
    topProjects: [],
  };
}

function transportWith(overrides = {}) {
  return {
    inspectSnapshots: async () => [],
    inspectOverview: async ({ input }) => overview(input.window),
    refreshSources: async () => undefined,
    subscribeChanges: async () => () => undefined,
    ...overrides,
  };
}

function productionService({
  moduleId = "shipctl.usage",
  transport = transportWith(),
  authorize,
} = {}) {
  const registry = new SemanticServiceRegistry([
    createUsageSourcesServiceProvider({ transport, authorize }),
  ]);
  const identity = createTestActivationIdentity(moduleId);
  const activation = registry.activate(identity);
  return {
    activation,
    identity,
    service: activation.context.services.require(usageSourcesService),
  };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("architecture.service-adapter.usage-sources.property", async () => {
  await fc.assert(fc.asyncProperty(
    providerArbitrary,
    fc.string(),
    sensitiveArbitrary,
    async (provider, status, sensitive) => {
      const requests = [];
      const raw = snapshot(provider, { status, error: sensitive });
      const { activation, identity, service } = productionService({
        transport: transportWith({
          inspectSnapshots: async (request) => {
            requests.push(request);
            return [raw];
          },
        }),
      });
      const outcome = await service.inspectSource.execute({ kind: "source-snapshots" });
      assert.equal(outcome.result.ok, true);
      assert.deepEqual(outcome.result.value.snapshots, [
        { ...raw, error: "Usage source is unavailable" },
      ]);
      assert.deepEqual(
        outcome.result.value.sources.map(({ sourceId, authority }) => ({ sourceId, authority })),
        PROVIDERS.map((sourceId) => ({ sourceId, authority: "host-managed" })),
      );
      assert.equal(JSON.stringify(outcome).includes(sensitive), false);
      assert.equal(requests[0].activation, identity);
      assert.equal(requests[0].correlationId, outcome.correlationId);
      assert.deepEqual(requests[0].input, { kind: "source-snapshots" });
      await activation.dispose();
    },
  ), propertyParameters());

  await fc.assert(fc.asyncProperty(
    windowArbitrary,
    providerArbitrary,
    async (window, provider) => {
      const requests = [];
      const raw = overview(window, provider);
      const { activation, identity, service } = productionService({
        transport: transportWith({
          inspectOverview: async (request) => {
            requests.push(request);
            return raw;
          },
        }),
      });
      const outcome = await service.inspectSource.execute({
        kind: "legacy-overview-projection",
        window,
      });
      assert.deepEqual(outcome.result, {
        ok: true,
        value: { kind: "legacy-overview-projection", overview: raw },
      });
      assert.equal(requests[0].activation, identity);
      assert.equal(requests[0].correlationId, outcome.correlationId);
      assert.deepEqual(requests[0].input, {
        kind: "legacy-overview-projection",
        window,
      });
      await activation.dispose();
    },
  ), propertyParameters());

  await fc.assert(fc.asyncProperty(
    sensitiveArbitrary,
    fc.constantFrom("permission denied", "unknown command", "unexpected failure"),
    async (sensitive, failure) => {
      const { activation, service } = productionService({
        transport: transportWith({
          inspectSnapshots: async () => { throw new Error(`${failure}: ${sensitive}`); },
        }),
      });
      const outcome = await service.inspectSource.execute({ kind: "source-snapshots" });
      assert.equal(outcome.result.ok, false);
      assert.equal(JSON.stringify(outcome).includes(sensitive), false);
      assert.equal(
        outcome.result.error.code,
        failure === "permission denied"
          ? "usage-sources.denied"
          : failure === "unknown command"
            ? "usage-sources.unavailable"
            : "usage-sources.transport-failed",
      );
      await activation.dispose();
    },
  ), propertyParameters());
});

test("architecture.service-request.usage-sources.property", async () => {
  await fc.assert(fc.asyncProperty(
    sourceIdsArbitrary,
    fc.constantFrom("inspect", "refresh"),
    fc.boolean(),
    fc.boolean(),
    async (sourceIds, operation, admitted, cancelled) => {
      const authorizations = [];
      const dispatches = [];
      const transport = transportWith({
        inspectSnapshots: async (request) => { dispatches.push(["inspect", request]); return []; },
        refreshSources: async (request) => { dispatches.push(["refresh", request]); },
      });
      const { activation, identity, service } = productionService({
        transport,
        authorize: (request) => { authorizations.push(request); return admitted; },
      });
      const options = { cancellation: { cancelled } };
      const outcome = operation === "inspect"
        ? await service.inspectSource.execute({ kind: "source-snapshots" }, options)
        : await service.refreshSources.execute({ sourceIds }, options);

      const expectedCode = cancelled
        ? "usage-sources.cancelled"
        : admitted
          ? null
          : "usage-sources.denied";
      assert.equal(outcome.result.ok, expectedCode === null);
      if (expectedCode !== null) assert.equal(outcome.result.error.code, expectedCode);
      assert.equal(authorizations.length, cancelled ? 0 : 1);
      assert.equal(dispatches.length, cancelled || !admitted ? 0 : 1);
      if (authorizations.length > 0) {
        assert.equal(authorizations[0].activation, identity);
        assert.equal(
          authorizations[0].grant,
          operation === "inspect" ? "usage-source.read" : "usage-source.refresh",
        );
        assert.deepEqual(
          authorizations[0].sourceIds,
          operation === "inspect" ? PROVIDERS : sourceIds,
        );
      }
      if (dispatches.length > 0) {
        assert.equal(dispatches[0][0], operation);
        assert.equal(dispatches[0][1].activation, identity);
        assert.equal(dispatches[0][1].correlationId, outcome.correlationId);
      }

      await activation.dispose();
      const before = { authorization: authorizations.length, dispatch: dispatches.length };
      const disposed = await service.refreshSources.execute({ sourceIds });
      assert.equal(disposed.result.ok, false);
      assert.equal(disposed.result.error.code, "usage-sources.activation-disposed");
      assert.deepEqual(
        { authorization: authorizations.length, dispatch: dispatches.length },
        before,
      );
    },
  ), propertyParameters());

  await fc.assert(fc.asyncProperty(
    fc.constantFrom(
      { sourceIds: [] },
      { sourceIds: ["foreign"] },
    ),
    async (input) => {
      let dispatches = 0;
      const { activation, service } = productionService({
        transport: transportWith({
          refreshSources: async () => { dispatches += 1; },
        }),
      });
      const outcome = await service.refreshSources.execute(input);
      assert.equal(outcome.result.ok, false);
      assert.equal(outcome.result.error.code, "usage-sources.invalid-request");
      assert.equal(dispatches, 0);
      await activation.dispose();
    },
  ), propertyParameters());

  await fc.assert(fc.asyncProperty(fc.string(), async (window) => {
    fc.pre(!WINDOWS.includes(window));
    let dispatches = 0;
    const { activation, service } = productionService({
      transport: transportWith({
        inspectOverview: async () => { dispatches += 1; return overview("5h"); },
      }),
    });
    const outcome = await service.inspectSource.execute({
      kind: "legacy-overview-projection",
      window,
    });
    assert.equal(outcome.result.ok, false);
    assert.equal(outcome.result.error.code, "usage-sources.invalid-request");
    assert.equal(dispatches, 0);
    await activation.dispose();
  }), propertyParameters());

  await fc.assert(fc.asyncProperty(
    fc.stringMatching(/^[a-z][a-z0-9-]*$/),
    async (moduleName) => {
      fc.pre(moduleName !== "usage");
      let dispatches = 0;
      const { activation, service } = productionService({
        moduleId: `shipctl.${moduleName}`,
        transport: transportWith({
          inspectSnapshots: async () => { dispatches += 1; return []; },
        }),
      });
      const outcome = await service.inspectSource.execute({ kind: "source-snapshots" });
      assert.equal(outcome.result.ok, false);
      assert.equal(outcome.result.error.code, "usage-sources.denied");
      assert.equal(dispatches, 0);
      await activation.dispose();
    },
  ), propertyParameters());
});

test("architecture.service-event.usage-sources.property", async () => {
  await fc.assert(fc.asyncProperty(
    sourceIdsArbitrary,
    fc.array(sourceIdsArbitrary),
    async (scope, published) => {
      let capturedActivation;
      let callback;
      let unlistenCount = 0;
      const { activation, identity, service } = productionService({
        transport: transportWith({
          subscribeChanges: async (candidate, listener) => {
            capturedActivation = candidate;
            callback = listener;
            return () => { unlistenCount += 1; };
          },
        }),
      });
      const received = [];
      const lease = await service.observeSource.subscribe(
        { sourceIds: scope },
        (event) => { received.push(event); },
      );
      assert.equal(capturedActivation, identity);
      assert.equal(lease.activation, identity);
      for (const sourceIds of published) callback({ sourceIds });
      await nextTurn();

      const expected = published
        .map((sourceIds) => sourceIds.filter((sourceId) => scope.includes(sourceId)))
        .filter((sourceIds) => sourceIds.length > 0);
      assert.deepEqual(received.map(({ value }) => value.sourceIds), expected);
      assert.deepEqual(received.map(({ sequence }) => sequence),
        expected.map((_, index) => index + 1));
      assert.equal(received.every(({ sourceId }) => (
        sourceId === "shipctl.usage-sources.changed"
      )), true);

      await lease.dispose();
      callback({ sourceIds: scope });
      await nextTurn();
      assert.equal(received.length, expected.length);
      assert.equal(unlistenCount, 1);
      await activation.dispose();
      assert.equal(unlistenCount, 1);
    },
  ), propertyParameters());

  await fc.assert(fc.asyncProperty(sourceIdsArbitrary, async (scope) => {
    let subscriptions = 0;
    const { activation, service } = productionService({
      transport: transportWith({
        subscribeChanges: async () => { subscriptions += 1; return () => undefined; },
      }),
      authorize: () => false,
    });
    await assert.rejects(
      service.observeSource.subscribe({ sourceIds: scope }, () => undefined),
      /access was denied/,
    );
    assert.equal(subscriptions, 0);
    await activation.dispose();
  }), propertyParameters());
});

test("architecture.usage-sources-service-fake.property", async () => {
  await fc.assert(fc.asyncProperty(
    providerArbitrary,
    windowArbitrary,
    sourceIdsArbitrary,
    async (provider, window, refreshed) => {
      const trace = [];
      const changes = new FakeUsageSourceChangeController();
      const rawSnapshot = snapshot(provider);
      const rawOverview = overview(window, provider);
      const host = new SemanticServiceTestHost([
        createFakeUsageSourcesServiceProvider({
          snapshots: [rawSnapshot],
          overviews: { [window]: rawOverview },
          trace,
          changes,
        }),
      ]);
      const activation = host.activate(createTestActivationIdentity("shipctl.usage"));
      const client = usageSourcesClientFor(activation.context);
      const events = [];
      const lease = await client.subscribeChanges((event) => { events.push(event); });

      assert.deepEqual(await client.getAllUsageSnapshots(), [rawSnapshot]);
      assert.deepEqual(await client.getUsageOverview(window), rawOverview);
      await client.refreshUsageData(refreshed);
      assert.deepEqual(events, [{
        sourceId: "shipctl.usage-sources.changed",
        sequence: 1,
        value: { sourceIds: refreshed },
      }]);
      assert.deepEqual(trace.map(({ operation }) => operation), [
        "inspect-source",
        "inspect-source",
        "refresh-sources",
      ]);
      assert.deepEqual(trace[2].request.input, { sourceIds: refreshed });
      assert.equal(JSON.stringify(trace).includes("@tauri-apps"), false);
      await lease.dispose();
      await activation.dispose();
    },
  ), propertyParameters());

  await fc.assert(fc.asyncProperty(providerArbitrary, async (provider) => {
    const host = new SemanticServiceTestHost([
      createFakeUsageSourcesServiceProvider({ deniedGrants: ["usage-source.read"] }),
    ]);
    const activation = host.activate(createTestActivationIdentity("shipctl.usage"));
    const client = usageSourcesClientFor(activation.context);
    await assert.rejects(client.getAllUsageSnapshots(), /grant denied/);
    await activation.dispose();
    assert.ok(provider);
  }), propertyParameters());
});
