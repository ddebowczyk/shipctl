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
import { matchesPanelShortcut } from "../../src/core/modules/panelShortcuts.ts";

type ModuleComposition = typeof import("../../src/core/modules/moduleComposition.ts");

let vite: ViteDevServer;
let createEnabledPanelRegistry: ModuleComposition["createEnabledPanelRegistry"];
let createEnabledGlobalSurfaceRegistry: ModuleComposition["createEnabledGlobalSurfaceRegistry"];
let moduleProjectNavigationContributions: ModuleComposition["moduleProjectNavigationContributions"];
let moduleProjectActionContributions: ModuleComposition["moduleProjectActionContributions"];
let enabledProjectActionContributions: ModuleComposition["enabledProjectActionContributions"];
let enabledProjectFactsProvider: ModuleComposition["enabledProjectFactsProvider"];
let enabledProjectLayoutContributions: ModuleComposition["enabledProjectLayoutContributions"];
let moduleProjectFactsProviders: ModuleComposition["moduleProjectFactsProviders"];
let moduleProjectLayoutContributions: ModuleComposition["moduleProjectLayoutContributions"];
let moduleSettingsContributions: ModuleComposition["moduleSettingsContributions"];
let moduleSkillsProvider: ModuleComposition["moduleSkillsProvider"];
let moduleLegacyPanelDefinitions: ModuleComposition["moduleLegacyPanelDefinitions"];
let notifyModulesFilesystemChanged: ModuleComposition["notifyModulesFilesystemChanged"];
let notifyModulesProjectOpened: ModuleComposition["notifyModulesProjectOpened"];
let selectProjectFactsProvider: ModuleComposition["selectProjectFactsProvider"];

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
    enabledProjectActionContributions,
    enabledProjectFactsProvider,
    enabledProjectLayoutContributions,
    moduleProjectActionContributions,
    moduleProjectFactsProviders,
    moduleProjectLayoutContributions,
    moduleProjectNavigationContributions,
    moduleSettingsContributions,
    moduleSkillsProvider,
    moduleLegacyPanelDefinitions,
    notifyModulesFilesystemChanged,
    notifyModulesProjectOpened,
    selectProjectFactsProvider,
  } = await vite.ssrLoadModule(
    "/src/core/modules/moduleComposition.ts",
  ) as ModuleComposition);
});

after(async () => {
  await vite.close();
});

const builtinPanelLoaders: BuiltinPanelLoaders = {
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
  projectLayout: [
    {
      id: "fixture.project-layout",
      moduleId: "shep.fixture",
      slot: "workspace.trailing",
      order: 5,
      load: async () => ({ default: () => null }),
    },
  ],
  projectFactsProvider: {
    id: "fixture.project-facts",
    moduleId: "shep.fixture",
    getFacts: () => ({ revision: { label: "main", state: "clean" } }),
  },
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
  panels: {
    open: () => "fixture-panel",
    reveal: () => undefined,
    close: () => undefined,
  },
  appearance: {
    getSnapshot: () => ({ themeId: "fixture", background: "#000000" }),
    subscribe: () => () => undefined,
  },
  projectData: {
    read: async () => undefined,
    replace: async () => undefined,
  },
  terminalSessions: {
    getDimensions: () => ({ columns: 80, rows: 24 }),
    launch: async (request) => ({
      id: "fixture-session",
      projectPath: request.projectPath,
      ownerKey: request.ownerKey,
      label: request.label,
    }),
    stop: async () => undefined,
    focus: async () => undefined,
    subscribe: () => () => undefined,
  },
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
    moduleProjectLayoutContributions([fixtureModule]).map(({ id }) => id),
    ["fixture.project-layout"],
  );
  assert.deepEqual(
    moduleSettingsContributions([fixtureModule]).map(({ id }) => id),
    ["fixture.settings"],
  );
});

test("project rails are optional, ordered, and absent from disabled composition", () => {
  assert.deepEqual(
    enabledProjectActionContributions([fixtureModule], []).map(({ id }) => id),
    ["fixture.project-actions"],
  );
  assert.deepEqual(
    enabledProjectLayoutContributions([fixtureModule], []).map(({ id }) => id),
    ["fixture.project-layout"],
  );
  assert.equal(
    enabledProjectFactsProvider([fixtureModule])?.id,
    "fixture.project-facts",
  );
  assert.deepEqual(enabledProjectActionContributions([], []), []);
  assert.deepEqual(enabledProjectLayoutContributions([], []), []);
  assert.equal(enabledProjectFactsProvider([]), null);
});

test("module panel shortcuts use the generic host matcher", () => {
  const commandG = {
    key: "g",
    metaKey: true,
    shiftKey: false,
    altKey: false,
  };

  assert.equal(matchesPanelShortcut(commandG, "⌘G"), true);
  assert.equal(matchesPanelShortcut({ ...commandG, metaKey: false }, "⌘G"), false);
  assert.equal(matchesPanelShortcut({ ...commandG, shiftKey: true }, "⌘G"), false);
  assert.equal(matchesPanelShortcut({ ...commandG, altKey: true }, "⌘G"), false);
});

test("project facts selection is singular and module-owned", () => {
  const [provider] = moduleProjectFactsProviders([fixtureModule]);
  assert.equal(selectProjectFactsProvider([provider]), provider);
  assert.equal(selectProjectFactsProvider([]), null);
  assert.throws(
    () => selectProjectFactsProvider([provider, provider]),
    /Only one enabled provider/,
  );
  assert.throws(
    () => moduleProjectFactsProviders([{
      ...fixtureModule,
      id: "shep.other",
    }]),
    /belongs to shep.fixture, not shep.other/,
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
  const calls: Array<readonly string[] | string> = [];
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
        onProjectOpened: (path) => {
          calls.push(path);
        },
        onFilesystemChanged: (paths) => {
          calls.push([...paths]);
        },
      },
    },
  ];

  await notifyModulesProjectOpened("/fixture", services, modules);
  await notifyModulesFilesystemChanged(["/fixture"], services, modules);
  assert.deepEqual(calls, ["/fixture", ["/fixture"]]);
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
