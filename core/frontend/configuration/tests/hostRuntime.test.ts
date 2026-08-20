import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createServer, type ViteDevServer } from "vite";

type HeadlessModule = typeof import("../headless.ts");

let vite: ViteDevServer;
let createHostConfigurationRuntime: HeadlessModule["createHostConfigurationRuntime"];
let createHostConfigurationServiceProvider: HeadlessModule["createHostConfigurationServiceProvider"];
let configurationService: typeof import("@shipctl/module-api").configurationService;
let createFakePluginDataServiceProvider: typeof import("@shipctl/module-api/testing").createFakePluginDataServiceProvider;
let createTestActivationIdentity: typeof import("@shipctl/module-api/testing").createTestActivationIdentity;
let SemanticServiceTestHost: typeof import("@shipctl/module-api/testing").SemanticServiceTestHost;

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../../", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({
    createHostConfigurationRuntime,
    createHostConfigurationServiceProvider,
  } = await vite.ssrLoadModule("/core/frontend/configuration/headless.ts") as HeadlessModule);
  ({ configurationService } = await vite.ssrLoadModule("/module-api/frontend/src/index.ts"));
  ({
    createFakePluginDataServiceProvider,
    createTestActivationIdentity,
    SemanticServiceTestHost,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
});

after(async () => {
  await vite?.close();
});

test("headless configuration service is Tauri-free and exposes data-only operations", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../runtimeService.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(source, /@tauri-apps|@shipctl\/core\/platform/);

  const runtime = createHostConfigurationRuntime({
    pluginDataServiceProvider: createFakePluginDataServiceProvider(),
    legacy: { read: async () => null },
  });
  const host = new SemanticServiceTestHost([
    createHostConfigurationServiceProvider({ runtime }),
  ]);
  const activation = host.activate(createTestActivationIdentity("shipctl.runtime-operations"));
  const service = activation.context.services.require(configurationService);

  const inspected = await service.inspectConfiguration.execute({ key: "editor" });
  assert.equal(inspected.result.ok, true);
  if (!inspected.result.ok) throw new Error(inspected.result.error.message);
  assert.deepEqual(inspected.result.value, {
    key: "editor",
    state: "default",
    value: { preferredEditor: null },
  });

  const resolved = await service.resolveConfiguration.execute({ key: "editor" });
  assert.equal(resolved.result.ok, true);
  if (!resolved.result.ok) throw new Error(resolved.result.error.message);
  assert.equal(resolved.result.value.changed, true);
  assert.equal(resolved.result.value.record.ownerModuleId, "shipctl.host");

  const updated = await service.updateConfiguration.execute({
    key: "editor",
    value: { preferredEditor: "zed" },
  });
  assert.equal(updated.result.ok, true);
  if (!updated.result.ok) throw new Error(updated.result.error.message);
  assert.deepEqual(updated.result.value.value, { preferredEditor: "zed" });

  await activation.dispose();
  await runtime.dispose();
});

test("runtime configuration migrates the retired legacy canvas value to the standard adapter", async () => {
  const runtime = createHostConfigurationRuntime({
    pluginDataServiceProvider: createFakePluginDataServiceProvider(),
    legacy: {
      read: async (_scope, key) => key === "ui" ? { value: { canvas: "legacy" } } : null,
    },
  });

  const resolved = await runtime.resolve("runtime");

  assert.equal(resolved.changed, true);
  assert.equal(resolved.record.schemaVersion, 3);
  assert.deepEqual(resolved.value, { canvasAdapter: "standard" });
  assert.deepEqual(resolved.record.migrations, [{
    migrationId: "shipctl.host.runtime.v1-to-v3",
    fromSchemaVersion: 1,
    toSchemaVersion: 3,
  }]);

  await runtime.dispose();
});

test("runtime configuration upgrades a persisted v2 legacy adapter record", async () => {
  const runtime = createHostConfigurationRuntime({
    pluginDataServiceProvider: createFakePluginDataServiceProvider({
      records: [{
        ownerModuleId: "shipctl.host",
        scope: { kind: "global" },
        key: "runtime",
        schemaVersion: 2,
        revision: 4,
        value: { canvasAdapter: "legacy" },
      }],
    }),
    legacy: { read: async () => null },
  });

  const resolved = await runtime.resolve("runtime");

  assert.equal(resolved.changed, true);
  assert.equal(resolved.record.schemaVersion, 3);
  assert.equal(resolved.record.revision, 5);
  assert.deepEqual(resolved.value, { canvasAdapter: "standard" });
  assert.deepEqual(resolved.record.migrations, [{
    migrationId: "shipctl.host.runtime.v2-to-v3",
    fromSchemaVersion: 2,
    toSchemaVersion: 3,
  }]);

  await runtime.dispose();
});
