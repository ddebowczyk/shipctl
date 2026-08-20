import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  AcceptedPluginAdmission,
  ConfigurationContribution,
  ConfigurationValidation,
  ModuleJsonValue,
} from "@shipctl/module-api";
import type { LegacyConfigurationReader } from "../runtime.ts";
import { createServer, type ViteDevServer } from "vite";

type RuntimeModule = typeof import("../runtime.ts");

let vite: ViteDevServer;
let ConfigurationRuntime: typeof RuntimeModule["ConfigurationRuntime"];
let ConfigurationRuntimeError: typeof RuntimeModule["ConfigurationRuntimeError"];
let pluginDataService: typeof import("@shipctl/module-api").pluginDataService;
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
  ({ ConfigurationRuntime, ConfigurationRuntimeError } = await vite.ssrLoadModule(
    "/core/frontend/configuration/runtime.ts",
  ) as RuntimeModule);
  ({ pluginDataService } = await vite.ssrLoadModule("/module-api/frontend/src/index.ts"));
  ({
    createFakePluginDataServiceProvider,
    createTestActivationIdentity,
    SemanticServiceTestHost,
  } = await vite.ssrLoadModule("/module-api/frontend/src/testing.ts"));
});

after(async () => {
  await vite?.close();
});

interface FixtureSettings extends Record<string, ModuleJsonValue> {
  enabled: boolean;
}

const SCOPE = { kind: "global" } as const;
const MODULE_ID = "shipctl.fixture";
const ALL_GRANTS = ["plugin-data.read", "plugin-data.write", "plugin-data.migrate"] as const;

function admission(
  effectiveGrants: readonly typeof ALL_GRANTS[number][],
): AcceptedPluginAdmission {
  return {
    artifact: {
      contentDigest: "0".repeat(64),
      entryUrl: "shipctl://fixture/configuration",
      moduleId: MODULE_ID,
      version: "1",
    },
    effectiveGrants,
  };
}

function validation(value: unknown): ConfigurationValidation<FixtureSettings> {
  if (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).enabled === "boolean"
  ) {
    return { ok: true, value: { enabled: (value as FixtureSettings).enabled } };
  }
  return {
    ok: false,
    diagnostic: {
      code: "fixture.invalid-settings",
      message: "enabled must be a boolean",
      path: "enabled",
    },
  };
}

function contribution(schemaVersion = 2): ConfigurationContribution<FixtureSettings> {
  return {
    id: "shipctl.fixture.settings",
    moduleId: MODULE_ID,
    scope: "global",
    key: "settings",
    schemaVersion,
    defaults: { enabled: false },
    validate: validation,
    migrations: [{
      fromSchemaVersion: 1,
      migrationId: "shipctl.fixture.settings.v1-to-v2",
      migrate: validation,
    }],
    legacySource: { key: "legacy-settings", schemaVersion: 1 },
  };
}

function fixture(
  grants: readonly typeof ALL_GRANTS[number][],
  legacy: LegacyConfigurationReader,
) {
  const host = new SemanticServiceTestHost([createFakePluginDataServiceProvider()]);
  const activation = host.activate(
    createTestActivationIdentity(MODULE_ID),
    admission(grants),
  );
  const pluginData = activation.context.services.require(pluginDataService);
  const runtime = new ConfigurationRuntime({
    ownerModuleId: MODULE_ID,
    contributions: [contribution()],
    pluginData,
    legacy,
  });
  return { activation, pluginData, runtime };
}

test("configuration migrates a validated legacy record once and replays from durable data", async () => {
  let legacyReads = 0;
  const current = fixture(ALL_GRANTS, {
    read: async () => {
      legacyReads += 1;
      return { value: { enabled: true } };
    },
  });
  const settings = contribution();

  const migrated = await current.runtime.resolve(settings, SCOPE);
  assert.equal(migrated.changed, true);
  assert.equal(migrated.record.schemaVersion, 2);
  assert.equal(migrated.value.enabled, true);
  assert.deepEqual(migrated.record.migrations, [{
    migrationId: "shipctl.fixture.settings.v1-to-v2",
    fromSchemaVersion: 1,
    toSchemaVersion: 2,
  }]);

  const replay = await current.runtime.resolve(settings, SCOPE);
  assert.equal(replay.changed, false);
  assert.equal(replay.record.revision, migrated.record.revision);
  assert.equal(legacyReads, 1);

  await current.activation.dispose();
});

test("configuration rejects an invalid legacy schema without writing a record", async () => {
  const current = fixture(ALL_GRANTS, {
    read: async () => ({ value: { enabled: "yes" } }),
  });
  const settings = contribution();

  await assert.rejects(
    current.runtime.resolve(settings, SCOPE),
    (error: unknown) => error instanceof ConfigurationRuntimeError
      && error.code === "fixture.invalid-settings",
  );
  const stored = await current.pluginData.readRecord.execute({ scope: SCOPE, key: "settings" });
  assert.equal(stored.result.ok, true);
  if (stored.result.ok) assert.equal(stored.result.value, null);

  await current.activation.dispose();
});

test("configuration refuses an invalid contribution schema before it can bind durability", () => {
  const current = fixture(ALL_GRANTS, { read: async () => null });
  assert.throws(
    () => new ConfigurationRuntime({
      ownerModuleId: MODULE_ID,
      contributions: [contribution(0)],
      pluginData: current.pluginData,
      legacy: { read: async () => null },
    }),
    /invalid schema version/,
  );
  void current.activation.dispose();
});

test("configuration cannot bind another activation's namespace", () => {
  const current = fixture(ALL_GRANTS, { read: async () => null });
  assert.throws(
    () => new ConfigurationRuntime({
      ownerModuleId: MODULE_ID,
      contributions: [{ ...contribution(), moduleId: "shipctl.other" }],
      pluginData: current.pluginData,
      legacy: { read: async () => null },
    }),
    /belongs to shipctl.other, not shipctl.fixture/,
  );
  void current.activation.dispose();
});

test("configuration reports a denied durable write from its dynamic activation grants", async () => {
  const current = fixture(["plugin-data.read"], { read: async () => null });
  const settings = contribution();

  await assert.rejects(
    current.runtime.resolve(settings, SCOPE),
    (error: unknown) => error instanceof ConfigurationRuntimeError
      && error.code === "plugin-data.denied",
  );

  await current.activation.dispose();
});
