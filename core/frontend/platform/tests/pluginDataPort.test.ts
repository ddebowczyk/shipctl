import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { PluginDataService } from "@shipctl/module-api";
import type { PluginDataTransport } from "../pluginData.ts";
import { createServer, type ViteDevServer } from "vite";

type PlatformModule = typeof import("../pluginData.ts");
type ModuleApi = typeof import("@shipctl/module-api");
type RuntimeModule = typeof import("@shipctl/core/runtime");
type TestingModule = typeof import("@shipctl/module-api/testing");

let vite: ViteDevServer;
let createPluginDataServiceProvider: PlatformModule["createPluginDataServiceProvider"];
let pluginDataService: ModuleApi["pluginDataService"];
let SemanticServiceRegistry: RuntimeModule["SemanticServiceRegistry"];
let createTestActivationIdentity: TestingModule["createTestActivationIdentity"];

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({ createPluginDataServiceProvider } = await vite.ssrLoadModule(
    "/core/frontend/platform/pluginData.ts",
  ) as PlatformModule);
  ({ pluginDataService } = await vite.ssrLoadModule(
    "/module-api/frontend/src/index.ts",
  ) as ModuleApi);
  ({ SemanticServiceRegistry } = await vite.ssrLoadModule(
    "/core/frontend/runtime/index.ts",
  ) as RuntimeModule);
  ({ createTestActivationIdentity } = await vite.ssrLoadModule(
    "/module-api/frontend/src/testing.ts",
  ) as TestingModule);
});

after(async () => {
  await vite.close();
});

function acceptedAdmission(moduleId: string, effectiveGrants: readonly string[]) {
  const contentDigest = "0".repeat(64);
  return Object.freeze({
    artifact: Object.freeze({
      contentDigest,
      entryUrl: `asset://localhost/${contentDigest}/index.js`,
      moduleId,
      version: "1.0.0",
    }),
    effectiveGrants: Object.freeze([...effectiveGrants]),
  });
}

function activate(
  grants: readonly string[],
  transport: PluginDataTransport,
): { readonly activation: { dispose(): Promise<void> }; readonly service: PluginDataService } {
  const moduleId = "shipctl.fixture-plugin-data";
  const registry = new SemanticServiceRegistry([
    createPluginDataServiceProvider({ transport }),
  ]);
  const activation = registry.activate(
    createTestActivationIdentity(moduleId, `${moduleId}@digest#one`),
    acceptedAdmission(moduleId, grants),
  );
  return {
    activation,
    service: activation.context.services.require(pluginDataService),
  };
}

test("plugin-data port denies an excluded grant before the native transport", async () => {
  let writes = 0;
  const fixture = activate([], {
    read: async () => null,
    write: async () => {
      writes += 1;
      throw new Error("transport must not run");
    },
    migrate: async () => { throw new Error("transport must not run"); },
  });

  const outcome = await fixture.service.writeRecord.execute({
    scope: { kind: "global" },
    key: "settings",
    expectedRevision: null,
    schemaVersion: 1,
    value: { enabled: true },
  });

  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.result.error.code, "plugin-data.denied");
  assert.equal(writes, 0);
  await fixture.activation.dispose();
});

test("plugin-data port reports an unavailable native resource structurally", async () => {
  const fixture = activate(["plugin-data.read"], {
    read: async () => { throw new Error("unknown command"); },
    write: async () => { throw new Error("transport must not run"); },
    migrate: async () => { throw new Error("transport must not run"); },
  });

  const outcome = await fixture.service.readRecord.execute({
    scope: { kind: "global" },
    key: "settings",
  });

  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.result.error.code, "plugin-data.unavailable");
  await fixture.activation.dispose();
});

test("plugin-data forwards dynamic effective grants for an arbitrary artifact record", async () => {
  let nativeRequest: Parameters<PluginDataTransport["write"]>[0] | null = null;
  const fixture = activate([
    "plugin-data.read",
    "plugin-data.write",
    "unrelated.grant",
  ], {
    read: async () => null,
    write: async (request) => {
      nativeRequest = request;
      return {
        ownerModuleId: request.activation.moduleId,
        scope: request.input.scope,
        key: request.input.key,
        schemaVersion: request.input.schemaVersion,
        revision: 1,
        value: request.input.value,
        migrations: [],
      };
    },
    migrate: async () => { throw new Error("transport must not run"); },
  });

  const outcome = await fixture.service.writeRecord.execute({
    scope: { kind: "project", projectId: "not-registered-by-rust" },
    key: "new-schema-without-rust-policy",
    expectedRevision: null,
    schemaVersion: 37,
    value: { enabled: true },
  });

  assert.equal(outcome.result.ok, true);
  assert.ok(nativeRequest);
  assert.deepEqual(nativeRequest.activation.effectiveGrants, [
    "plugin-data.read",
    "plugin-data.write",
  ]);
  assert.equal(nativeRequest.input.key, "new-schema-without-rust-policy");
  await fixture.activation.dispose();
});
