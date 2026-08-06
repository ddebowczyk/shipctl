import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ShepModule } from "@shep/module-api";
import { createServer, type ViteDevServer } from "vite";

import type { BuiltinPanelLoaders } from "../../src/core/modules/builtinPanelAdapters.ts";
import {
  hydratePanelReference,
  PANEL_REFERENCE_SCHEMA_VERSION,
} from "../../src/core/modules/panelPersistence.ts";

type ModuleComposition = typeof import("../../src/core/modules/moduleComposition.ts");

let vite: ViteDevServer;
let createEnabledPanelRegistry: ModuleComposition["createEnabledPanelRegistry"];

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../..", import.meta.url)),
    server: { middlewareMode: true },
  });
  ({ createEnabledPanelRegistry } = await vite.ssrLoadModule(
    "/src/core/modules/moduleComposition.ts",
  ) as ModuleComposition);
});

after(async () => {
  await vite.close();
});

const builtinPanelLoaders: BuiltinPanelLoaders = {
  git: async () => ({ default: () => null }),
  commands: async () => ({ default: () => null }),
  launcher: async () => ({ default: () => null }),
  todos: async () => ({ default: () => null }),
};

const fixtureModule: ShepModule = {
  id: "shep.fixture",
  version: "0.0.0",
  panels: [
    {
      id: "fixture.panel",
      moduleId: "shep.fixture",
      scope: "project",
      label: "Fixture",
      icon: { name: "test" },
      singleton: "per-project",
      load: async () => ({ default: () => null }),
    },
  ],
};

test("enabled profile contributes module panels", () => {
  const registry = createEnabledPanelRegistry(builtinPanelLoaders, [fixtureModule]);
  assert.equal(registry.has("fixture.panel"), true);
});

test("disabled profile omits implementation and retains recoverable identity", () => {
  const registry = createEnabledPanelRegistry(builtinPanelLoaders, []);
  assert.equal(registry.has("fixture.panel"), false);

  const result = hydratePanelReference(
    {
      schemaVersion: PANEL_REFERENCE_SCHEMA_VERSION,
      instanceId: "fixture-1",
      panelId: "fixture.panel",
      label: "Fixture",
    },
    {
      availablePanelIds: registry.list().map(({ id }) => id),
      knownPanelIds: ["fixture.panel"],
    },
  );

  assert.equal(result.status, "unavailable");
  assert.equal(result.recovery?.reason, "disabled");
  assert.equal(result.recovery?.canRetry, true);
  assert.equal(result.recovery?.canRemove, true);
});
