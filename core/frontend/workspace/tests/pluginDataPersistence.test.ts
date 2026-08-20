import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  AcceptedPluginAdmission,
  PluginDataRecord,
} from "@shipctl/module-api";
import type { FakePluginDataTrace } from "@shipctl/module-api/testing";
import { createServer, type ViteDevServer } from "vite";

type PluginDataPersistenceModule = typeof import("../pluginDataPersistence.ts");
type ModuleApi = typeof import("@shipctl/module-api");
type TestingModule = typeof import("@shipctl/module-api/testing");

let vite: ViteDevServer;
let PluginDataWorkspacePersistence: PluginDataPersistenceModule["PluginDataWorkspacePersistence"];
let WORKSPACE_PLUGIN_DATA_KEY: PluginDataPersistenceModule["WORKSPACE_PLUGIN_DATA_KEY"];
let WORKSPACE_PLUGIN_MODULE_ID: PluginDataPersistenceModule["WORKSPACE_PLUGIN_MODULE_ID"];
let pluginDataService: ModuleApi["pluginDataService"];
let createFakePluginDataServiceProvider: TestingModule["createFakePluginDataServiceProvider"];
let createTestActivationIdentity: TestingModule["createTestActivationIdentity"];
let SemanticServiceTestHost: TestingModule["SemanticServiceTestHost"];

const ALL_GRANTS = ["plugin-data.read", "plugin-data.write", "plugin-data.migrate"] as const;
const WORKSPACE_ID = "fixture.legacy-workspace";
const SCOPE = { kind: "global" } as const;

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../../", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({
    PluginDataWorkspacePersistence,
    WORKSPACE_PLUGIN_DATA_KEY,
    WORKSPACE_PLUGIN_MODULE_ID,
  } = await vite.ssrLoadModule(
    "/core/frontend/workspace/pluginDataPersistence.ts",
  ) as PluginDataPersistenceModule);
  ({ pluginDataService } = await vite.ssrLoadModule("/module-api/frontend/src/index.ts") as ModuleApi);
  ({
    createFakePluginDataServiceProvider,
    createTestActivationIdentity,
    SemanticServiceTestHost,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts") as TestingModule);
});

after(async () => {
  await vite?.close();
});

function admission(): AcceptedPluginAdmission {
  return {
    artifact: {
      contentDigest: "0".repeat(64),
      entryUrl: "shipctl://fixture/workspace",
      moduleId: WORKSPACE_PLUGIN_MODULE_ID,
      version: "1",
    },
    effectiveGrants: ALL_GRANTS,
  };
}

function legacyWorkspaceRecord(): PluginDataRecord["value"] {
  return {
    storageSchemaVersion: 2,
    workspaceId: WORKSPACE_ID,
    revision: 7,
    originId: "legacy.workspace-writer",
    catalogRevision: 4,
    document: {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      profileId: "legacy.canvas-profile",
      instances: [{
        instanceId: "fixture.legacy-view",
        viewTypeId: "fixture.legacy-view",
        ownerModuleId: "fixture.legacy-owner",
        ownerActivationId: "fixture.legacy-owner@1#legacy",
        resource: { kind: "global" },
        label: "Legacy view",
        stateRef: { draft: "retired" },
        availability: { kind: "available" },
        lifecycle: "placed",
      }],
      root: {
        kind: "stack",
        stackId: "fixture.legacy-stack",
        instanceIds: ["fixture.legacy-view"],
        selectedInstanceId: "fixture.legacy-view",
      },
      floating: [],
      maximizedStackId: null,
    },
  } as PluginDataRecord["value"];
}

test("workspace persistence imports a legacy record once into its canonical plugin-data namespace", async () => {
  const trace: FakePluginDataTrace[] = [];
  const host = new SemanticServiceTestHost([createFakePluginDataServiceProvider({
    trace,
    records: [{
      ownerModuleId: WORKSPACE_PLUGIN_MODULE_ID,
      scope: SCOPE,
      key: WORKSPACE_PLUGIN_DATA_KEY(WORKSPACE_ID),
      schemaVersion: 1,
      revision: 0,
      value: legacyWorkspaceRecord(),
    }],
  })]);
  const activation = host.activate(
    createTestActivationIdentity(WORKSPACE_PLUGIN_MODULE_ID),
    admission(),
  );
  try {
    const pluginData = activation.context.services.require(pluginDataService);
    const persistence = new PluginDataWorkspacePersistence(pluginData);

    const imported = await persistence.load(WORKSPACE_ID);
    const replay = await persistence.load(WORKSPACE_ID);

    assert.ok(imported);
    assert.equal(imported.revision, 1);
    assert.equal(imported.catalogRevision, 4);
    assert.equal(imported.document.schemaVersion, 2);
    assert.equal((imported.document as { profileId?: unknown }).profileId, undefined);
    assert.equal(
      (imported.document.instances[0] as { stateRef?: unknown }).stateRef,
      undefined,
    );
    assert.deepEqual(replay, imported);
    assert.equal(trace.filter((entry) => entry.operation === "migrate").length, 1);

    const canonical = await pluginData.readRecord.execute({
      scope: SCOPE,
      key: WORKSPACE_PLUGIN_DATA_KEY(WORKSPACE_ID),
    });
    assert.equal(canonical.result.ok, true);
    if (canonical.result.ok) {
      assert.equal(canonical.result.value?.schemaVersion, 2);
      assert.equal(canonical.result.value?.revision, 1);
      assert.deepEqual(canonical.result.value?.migrations, [{
        migrationId: "workspace-document-record-v1-to-plugin-data-v2",
        fromSchemaVersion: 1,
        toSchemaVersion: 2,
      }]);
    }
  } finally {
    await activation.dispose();
  }
});
