import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createServer, type ViteDevServer } from "vite";
import type { WorkspaceCatalogSnapshot } from "@shipctl/module-api";
import type { PluginDataTransport } from "../../platform/pluginData.ts";

type ApplicationRuntimeModule = typeof import("../applicationRuntime.ts");
type LiveModuleSupervisorModule = typeof import("../liveModuleSupervisor.ts");
type SemanticRuntimeModule = typeof import("../semanticServiceRuntime.ts");
type WorkspaceCatalogModule = typeof import("../../workspace/catalog.ts");
type WorkspacePluginModule = typeof import("../../workspace/pluginRuntime.ts");
type WorkspacePluginDataModule = typeof import("../../workspace/pluginDataPersistence.ts");
type PlatformPluginDataModule = typeof import("../../platform/pluginData.ts");
type TestingPluginDataModule = typeof import("@shipctl/module-api/testing");
type RuntimeModule = typeof import("../index.ts");
type PluginApi = typeof import("@shipctl/module-api");

let vite: ViteDevServer;
let createApplicationRuntime: ApplicationRuntimeModule["createApplicationRuntime"];
let LiveModuleSupervisor: LiveModuleSupervisorModule["LiveModuleSupervisor"];
let SemanticServiceRegistry: SemanticRuntimeModule["SemanticServiceRegistry"];
let parseWorkspaceCatalogSnapshot: WorkspaceCatalogModule["parseWorkspaceCatalogSnapshot"];
let WorkspacePluginRuntime: WorkspacePluginModule["WorkspacePluginRuntime"];
let WORKSPACE_PLUGIN_ADMISSION: WorkspacePluginModule["WORKSPACE_PLUGIN_ADMISSION"];
let WORKSPACE_PLUGIN_MODULE_ID: WorkspacePluginDataModule["WORKSPACE_PLUGIN_MODULE_ID"];
let createPluginDataServiceProvider: PlatformPluginDataModule["createPluginDataServiceProvider"];
let createFakePluginDataServiceProvider: TestingPluginDataModule["createFakePluginDataServiceProvider"];
let activatePluginDefinitionsObserved: RuntimeModule["activatePluginDefinitionsObserved"];
let pluginApi: PluginApi;

before(async () => {
  vite = await createServer({
    server: { hmr: false, middlewareMode: true },
    appType: "custom",
  });
  ({ createApplicationRuntime } = await vite.ssrLoadModule(
    "/core/frontend/runtime/applicationRuntime.ts",
  ) as ApplicationRuntimeModule);
  ({ LiveModuleSupervisor } = await vite.ssrLoadModule(
    "/core/frontend/runtime/liveModuleSupervisor.ts",
  ) as LiveModuleSupervisorModule);
  ({ SemanticServiceRegistry } = await vite.ssrLoadModule(
    "/core/frontend/runtime/semanticServiceRuntime.ts",
  ) as SemanticRuntimeModule);
  ({ parseWorkspaceCatalogSnapshot } = await vite.ssrLoadModule(
    "/core/frontend/workspace/catalog.ts",
  ) as WorkspaceCatalogModule);
  ({ WorkspacePluginRuntime, WORKSPACE_PLUGIN_ADMISSION } = await vite.ssrLoadModule(
    "/core/frontend/workspace/pluginRuntime.ts",
  ) as WorkspacePluginModule);
  ({ WORKSPACE_PLUGIN_MODULE_ID } = await vite.ssrLoadModule(
    "/core/frontend/workspace/pluginDataPersistence.ts",
  ) as WorkspacePluginDataModule);
  ({ createPluginDataServiceProvider } = await vite.ssrLoadModule(
    "/core/frontend/platform/pluginData.ts",
  ) as PlatformPluginDataModule);
  ({ createFakePluginDataServiceProvider } = await vite.ssrLoadModule(
    "/module-api/frontend/src/testing.ts",
  ) as TestingPluginDataModule);
  ({ activatePluginDefinitionsObserved } = await vite.ssrLoadModule(
    "/core/frontend/runtime/index.ts",
  ) as RuntimeModule);
  pluginApi = await vite.ssrLoadModule("/module-api/frontend/src/index.ts") as PluginApi;
});

after(async () => {
  await vite.close();
});

function workspaceCatalog(revision = 1): WorkspaceCatalogSnapshot {
  return parseWorkspaceCatalogSnapshot({
    schemaVersion: 2,
    revision,
    definitions: [{
      viewTypeId: "fixture.runtime-view",
      ownerModuleId: "fixture.runtime",
      ownerActivationId: "fixture.runtime@1.0.0#fixture",
      label: "Fixture runtime view",
      scope: "global",
      cardinality: "multiple",
      closeBehavior: "dispose",
      requiredCapabilityIds: [],
      placement: { defaultRegion: "primary", allowSplit: true },
      presentation: { loaderId: "fixture.runtime-view", exportName: "default" },
      migrationAliases: [],
    }],
  });
}

const unavailablePluginDataTransport: PluginDataTransport = {
  read: async () => { throw new Error("unknown command: fixture durable storage is offline"); },
  write: async () => { throw new Error("unknown command: fixture durable storage is offline"); },
  migrate: async () => { throw new Error("unknown command: fixture durable storage is offline"); },
};

function fixtureWorkspace(
  workspaceId: string,
  catalog: WorkspaceCatalogSnapshot,
  unavailable = false,
) {
  const workspace = new WorkspacePluginRuntime({ workspaceId, catalog });
  let deactivate: (() => Promise<void>) | null = null;
  return Object.freeze({
    get persistence() { return workspace.persistence; },
    diagnostics: () => workspace.diagnostics(),
    snapshot: () => workspace.snapshot(),
    subscribeCanvas: (listener: Parameters<typeof workspace.subscribeCanvas>[0]) => (
      workspace.subscribeCanvas(listener)
    ),
    subscribeDiagnostic: (listener: Parameters<typeof workspace.subscribeDiagnostic>[0]) => (
      workspace.subscribeDiagnostic(listener)
    ),
    submitCatalog: (nextCatalog: WorkspaceCatalogSnapshot) => workspace.submitCatalog(nextCatalog),
    async start() {
      if (deactivate !== null) return;
      const provider = unavailable
        ? createPluginDataServiceProvider({ transport: unavailablePluginDataTransport })
        : createFakePluginDataServiceProvider();
      const activation = await activatePluginDefinitionsObserved(
        undefined,
        [workspace.definition],
        new Map(),
        new SemanticServiceRegistry([provider]),
        false,
        new Map([[WORKSPACE_PLUGIN_MODULE_ID, WORKSPACE_PLUGIN_ADMISSION]]),
      );
      if (activation.failures.length > 0 || !activation.activeModuleIds.has(WORKSPACE_PLUGIN_MODULE_ID)) {
        await activation.deactivate();
        throw new Error(activation.failures[0]?.message ?? "Workspace plugin did not activate.");
      }
      deactivate = () => activation.deactivate();
    },
    async dispose() {
      const current = deactivate;
      deactivate = null;
      await current?.();
      await workspace.dispose();
    },
  });
}

test("a Node fixture boots the extracted runtime and activates its semantic service", async () => {
  const moduleId = "fixture.runtime";
  const version = "1.0.0";
  const service = pluginApi.defineSemanticService<{ touch(): void }>("fixture.runtime-service", 1);
  let serviceReads = 0;
  let cleanups = 0;
  let bridgeClosed = false;
  const definition = pluginApi.defineShipctlPlugin({
    id: moduleId,
    version,
    role: "headless",
    requires: [service],
    activate: (context) => {
      context.services.require(service).touch();
      context.own(() => { cleanups += 1; });
    },
  });
  const application = Object.freeze({
    schemaVersion: 1,
    role: "headless" as const,
    requiredServices: Object.freeze([{ id: service.id, version: service.version }]),
    providedServices: Object.freeze([]),
    backgroundEffects: Object.freeze([]),
    contributions: Object.freeze([]),
  });
  const runtimeCatalog = Object.freeze({
    schemaVersion: 1 as const,
    registryRevision: 1,
    modules: Object.freeze([{
      schemaVersion: 1 as const,
      moduleId,
      version,
      contentDigest: "fixture-runtime-digest",
      entryPath: "/fixture/runtime/plugin.mjs",
      stylePaths: Object.freeze([]),
      manifest: {
        schemaVersion: 2,
        lifecycle: "live" as const,
        messages: Object.freeze({}),
        requestedGrants: Object.freeze([]),
        application,
      },
      capabilities: { definitions: Object.freeze([]) },
    }]),
  });
  const admission = Object.freeze({
    artifact: Object.freeze({
      contentDigest: "fixture-runtime-digest",
      entryUrl: "asset://fixture/runtime/plugin.mjs",
      moduleId,
      version,
    }),
    effectiveGrants: Object.freeze([]),
    application,
  });
  const runtime = createApplicationRuntime({
    workspace: fixtureWorkspace("fixture.runtime-workspace", workspaceCatalog()),
    initialFamily: Object.freeze({ registryRevision: 0 }),
    workspaceCatalog: () => workspaceCatalog(),
    createSupervisor: ({ publish, reportReconciliationFailure }) => new LiveModuleSupervisor({
      services: {},
      createSemanticServices: () => new SemanticServiceRegistry([{
        service,
        bind: () => ({ touch: () => { serviceReads += 1; } }),
      }]),
      getCatalog: async () => runtimeCatalog,
      observeRevisions: async () => () => undefined,
      openMessageBridge: async () => ({
        bridge: {
          bindingsFor: () => Object.freeze({}),
          reconcile: async () => undefined,
          deactivateActivation: () => undefined,
          close: async () => { bridgeClosed = true; },
        },
      }),
      createMessageActivations: () => Object.freeze([]),
      loadModules: async () => ({
        catalog: runtimeCatalog,
        modules: Object.freeze([]),
        definitions: Object.freeze([definition]),
        admissionsByModule: new Map([[moduleId, admission]]),
        failures: Object.freeze([]),
      }),
      publish: (family) => publish(Object.freeze({ registryRevision: family.registryRevision })),
      reportApplied: async () => undefined,
      reportRejected: reportReconciliationFailure,
    }),
  });

  await runtime.start();

  assert.equal(runtime.snapshot().lifecycle, "running");
  assert.equal(runtime.snapshot().family.registryRevision, 1);
  assert.equal(serviceReads, 1);
  assert.deepEqual(runtime.snapshot().diagnostics, []);

  await runtime.dispose();

  assert.equal(cleanups, 1);
  assert.equal(bridgeClosed, true);
});

test("a persistence outage remains explicit and every workspace write fails", async () => {
  let supervisorDisposed = false;
  const runtime = createApplicationRuntime({
    workspace: fixtureWorkspace("fixture.unavailable-workspace", workspaceCatalog(), true),
    initialFamily: Object.freeze({ revision: 0 }),
    workspaceCatalog: () => workspaceCatalog(),
    createSupervisor: () => ({
      start: async () => undefined,
      dispose: async () => { supervisorDisposed = true; },
    }),
  });

  await runtime.start();

  const started = runtime.snapshot();
  assert.equal(started.lifecycle, "running");
  assert.equal(started.persistence, "unavailable");
  assert.deepEqual(started.diagnostics.map(({ code }) => code), [
    "workspace.persistence-unavailable",
  ]);
  const canvas = started.workspaceCanvas;
  assert(canvas, "the runtime should still expose an inspectable canvas");

  await assert.rejects(
    () => canvas.execute({
      kind: "open",
      instanceId: "fixture.runtime-view.instance",
      viewTypeId: "fixture.runtime-view",
      resource: { kind: "global" },
    }),
    (error: unknown) => (
      error instanceof Error
      && "code" in error
      && error.code === "workspace.persistence-failed"
    ),
  );
  assert.deepEqual(runtime.snapshot().diagnostics.map(({ code }) => code), [
    "workspace.persistence-unavailable",
    "workspace.persistence-failed",
  ]);

  await runtime.dispose();
  assert.equal(supervisorDisposed, true);
});
