import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ModuleHostServices, ShepModule } from "@shep/module-api";
import { createServer, type ViteDevServer } from "vite";

import type { BuiltinPanelLoaders } from "../../src/core/modules/builtinPanelAdapters.ts";
import type { BuiltinGlobalSurfaceLoaders } from "../../src/core/modules/builtinGlobalSurfaceAdapters.ts";
import {
  hydratePanelReference,
  PANEL_REFERENCE_SCHEMA_VERSION,
} from "../../src/core/modules/panelPersistence.ts";

type ModuleComposition = typeof import("../../src/core/modules/moduleComposition.ts");

let vite: ViteDevServer;
let createEnabledPanelRegistry: ModuleComposition["createEnabledPanelRegistry"];
let createEnabledGlobalSurfaceRegistry: ModuleComposition["createEnabledGlobalSurfaceRegistry"];
let moduleProjectNavigationContributions: ModuleComposition["moduleProjectNavigationContributions"];
let moduleProjectActionContributions: ModuleComposition["moduleProjectActionContributions"];
let moduleSettingsContributions: ModuleComposition["moduleSettingsContributions"];
let moduleSkillsProvider: ModuleComposition["moduleSkillsProvider"];
let moduleLegacyPanelDefinitions: ModuleComposition["moduleLegacyPanelDefinitions"];
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
    createEnabledGlobalSurfaceRegistry,
    moduleProjectActionContributions,
    moduleProjectNavigationContributions,
    moduleSettingsContributions,
    moduleSkillsProvider,
    moduleLegacyPanelDefinitions,
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

const builtinGlobalSurfaceLoaders: BuiltinGlobalSurfaceLoaders = {
  settings: async () => ({ default: () => null }),
  usage: async () => ({ default: () => null }),
};

const fixtureSkills = {
  getSnapshot: () => ({ byProject: {} }),
  subscribe: () => () => undefined,
  install: async () => undefined,
} satisfies ModuleHostServices["skills"];

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
      legacyTab: { kind: "fixture", label: "Legacy fixture" },
      load: async () => ({ default: () => null }),
    },
  ],
  globalSurfaces: [
    {
      id: "fixture.global-surface",
      moduleId: "shep.fixture",
      load: async () => ({ default: () => null }),
    },
  ],
  globalNavigation: [
    {
      id: "fixture.global-navigation",
      moduleId: "shep.fixture",
      surfaceId: "fixture.global-surface",
      label: "Fixture",
      icon: { name: "test" },
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
  projectActions: [
    {
      id: "fixture.project-actions",
      moduleId: "shep.fixture",
      order: 5,
      getGroup: () => ({ label: "Fixture", actions: [] }),
    },
  ],
  settings: [
    {
      id: "fixture.settings",
      moduleId: "shep.fixture",
      load: async () => ({ default: () => null }),
    },
  ],
  skillsProvider: {
    id: "fixture.skills-provider",
    moduleId: "shep.fixture",
    port: fixtureSkills,
  },
};

const services = {
  settings: {
    getSnapshot: () => ({ values: {}, isSaving: false, error: null }),
    subscribe: () => () => undefined,
    update: async () => undefined,
  },
  skills: fixtureSkills,
  notices: { push: () => undefined },
  externalLinks: { open: async () => undefined },
} satisfies ModuleHostServices;

test("enabled profile contributes module panels", () => {
  const registry = createEnabledPanelRegistry(builtinPanelLoaders, [fixtureModule]);
  assert.equal(registry.has("fixture.panel"), true);
});

test("enabled profile composes global surfaces and navigation", () => {
  const registry = createEnabledGlobalSurfaceRegistry(
    builtinGlobalSurfaceLoaders,
    [fixtureModule],
  );
  assert.equal(registry.has("fixture.global-surface"), true);
  assert.deepEqual(
    registry.navigation().map(({ id, surfaceId }) => ({ id, surfaceId })),
    [
      { id: "fixture.global-navigation", surfaceId: "fixture.global-surface" },
      { id: "core.settings-navigation", surfaceId: "core.settings" },
      { id: "core.usage-navigation", surfaceId: "core.usage" },
    ],
  );
});

test("disabled profile removes module global surfaces and navigation", () => {
  const registry = createEnabledGlobalSurfaceRegistry(builtinGlobalSurfaceLoaders, []);
  assert.equal(registry.has("fixture.global-surface"), false);
  assert.equal(
    registry.navigation().some(({ id }) => id === "fixture.global-navigation"),
    false,
  );
});

test("default profile enables the extracted TODO panel", () => {
  const registry = createEnabledPanelRegistry(builtinPanelLoaders);
  assert.equal(registry.has("todos.board"), true);
  assert.equal(registry.panel("todos.board")?.legacyTab?.kind, "todos");
});

test("default profile enables the extracted Ports surface", () => {
  const registry = createEnabledGlobalSurfaceRegistry(builtinGlobalSurfaceLoaders);
  assert.equal(registry.has("ports.overview"), true);
  assert.equal(
    registry.navigation().some(({ id }) => id === "ports.global-navigation"),
    true,
  );
});

test("modules own legacy tab migration metadata", () => {
  const result = hydratePanelReference(
    { id: "panel-fixture", kind: "fixture", label: "Saved fixture" },
    {
      availablePanelIds: ["fixture.panel"],
      legacyPanels: moduleLegacyPanelDefinitions([fixtureModule]),
    },
  );

  assert.equal(result.status, "available");
  assert.equal(result.source, "legacy");
  assert.equal(result.panelId, "fixture.panel");
  assert.equal(result.legacyKind, "fixture");
});

test("module surfaces compose without feature-specific host branches", () => {
  assert.deepEqual(
    moduleProjectNavigationContributions([fixtureModule]).map(({ id }) => id),
    ["fixture.project-navigation"],
  );
  assert.deepEqual(
    moduleProjectActionContributions([fixtureModule]).map(({ id }) => id),
    ["fixture.project-actions"],
  );
  assert.deepEqual(
    moduleSettingsContributions([fixtureModule]).map(({ id }) => id),
    ["fixture.settings"],
  );
});

test("Skills provider selection is optional, singular, and module-owned", () => {
  assert.equal(moduleSkillsProvider([fixtureModule]), services.skills);
  assert.equal(moduleSkillsProvider([]), null);
  assert.throws(
    () => moduleSkillsProvider([fixtureModule, { ...fixtureModule, id: "shep.other" }]),
    /belongs to shep.fixture, not shep.other/,
  );
  assert.throws(
    () => moduleSkillsProvider([fixtureModule, fixtureModule]),
    /Only one enabled module/,
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
