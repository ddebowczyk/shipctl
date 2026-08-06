import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ModuleHostServices, ShepModule } from "@shep/module-api";
import { createServer, type ViteDevServer } from "vite";

import type { BuiltinPanelLoaders } from "../../src/core/modules/builtinPanelAdapters.ts";
import {
  hydratePanelReference,
  PANEL_REFERENCE_SCHEMA_VERSION,
} from "../../src/core/modules/panelPersistence.ts";

type ModuleComposition = typeof import("../../src/core/modules/moduleComposition.ts");

let vite: ViteDevServer;
let createEnabledPanelRegistry: ModuleComposition["createEnabledPanelRegistry"];
let moduleProjectNavigationContributions: ModuleComposition["moduleProjectNavigationContributions"];
let moduleSettingsContributions: ModuleComposition["moduleSettingsContributions"];
let notifyModulesFilesystemChanged: ModuleComposition["notifyModulesFilesystemChanged"];

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../..", import.meta.url)),
    server: { middlewareMode: true },
  });
  ({
    createEnabledPanelRegistry,
    moduleProjectNavigationContributions,
    moduleSettingsContributions,
    notifyModulesFilesystemChanged,
  } = await vite.ssrLoadModule(
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
  projectNavigation: [
    {
      id: "fixture.project-navigation",
      moduleId: "shep.fixture",
      panelId: "fixture.panel",
      load: async () => ({ default: () => null }),
    },
  ],
  settings: [
    {
      id: "fixture.settings",
      moduleId: "shep.fixture",
      load: async () => ({ default: () => null }),
    },
  ],
};

const services = {
  settings: {
    getSnapshot: () => ({ values: {}, isSaving: false, error: null }),
    subscribe: () => () => undefined,
    update: async () => undefined,
  },
  skills: {
    getSnapshot: () => ({ byProject: {} }),
    subscribe: () => () => undefined,
    install: async () => undefined,
  },
  notices: { push: () => undefined },
} satisfies ModuleHostServices;

test("enabled profile contributes module panels", () => {
  const registry = createEnabledPanelRegistry(builtinPanelLoaders, [fixtureModule]);
  assert.equal(registry.has("fixture.panel"), true);
});

test("default profile enables the extracted TODO panel", () => {
  const registry = createEnabledPanelRegistry(builtinPanelLoaders);
  assert.equal(registry.has("todos.board"), true);
});

test("module surfaces compose without feature-specific host branches", () => {
  assert.deepEqual(
    moduleProjectNavigationContributions([fixtureModule]).map(({ id }) => id),
    ["fixture.project-navigation"],
  );
  assert.deepEqual(
    moduleSettingsContributions([fixtureModule]).map(({ id }) => id),
    ["fixture.settings"],
  );
});

test("project lifecycle dispatch isolates module failures", async () => {
  const calls: string[][] = [];
  const modules: ShepModule[] = [
    {
      id: "fixture.failing",
      version: "0",
      projectLifecycle: {
        onFilesystemChanged: () => {
          throw new Error("fixture failure");
        },
      },
    },
    {
      id: "fixture.working",
      version: "0",
      projectLifecycle: {
        onFilesystemChanged: (paths) => {
          calls.push([...paths]);
        },
      },
    },
  ];

  await notifyModulesFilesystemChanged(["/fixture"], services, modules);
  assert.deepEqual(calls, [["/fixture"]]);
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
