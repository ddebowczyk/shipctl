import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ModuleHostServices, ModuleMessages, ShipctlModule } from "@shipctl/module-api";
import { createServer, type ViteDevServer } from "vite";

import type { BuiltinGlobalSurfaceLoaders } from "../builtinGlobalSurfaceAdapters.ts";
import type { ModuleTaskScheduler } from "../moduleComposition.ts";
import {
  hydratePanelReference,
  PANEL_REFERENCE_SCHEMA_VERSION,
} from "../panelPersistence.ts";
import { matchesPanelShortcut } from "../panelShortcuts.ts";

type ModuleComposition = typeof import("../moduleComposition.ts");

let vite: ViteDevServer;
let createEnabledPanelRegistry: ModuleComposition["createEnabledPanelRegistry"];
let createEnabledGlobalSurfaceRegistry: ModuleComposition["createEnabledGlobalSurfaceRegistry"];
let activateModules: ModuleComposition["activateModules"];
let activateModulesWithMessages: ModuleComposition["activateModulesWithMessages"];
let moduleProjectNavigationContributions: ModuleComposition["moduleProjectNavigationContributions"];
let moduleScheduledTasks: ModuleComposition["moduleScheduledTasks"];
let moduleSidebarContributions: ModuleComposition["moduleSidebarContributions"];
let moduleProjectActionContributions: ModuleComposition["moduleProjectActionContributions"];
let enabledProjectActionContributions: ModuleComposition["enabledProjectActionContributions"];
let enabledProjectFactsProvider: ModuleComposition["enabledProjectFactsProvider"];
let enabledProjectLayoutContributions: ModuleComposition["enabledProjectLayoutContributions"];
let moduleProjectFactsProviders: ModuleComposition["moduleProjectFactsProviders"];
let moduleProjectLayoutContributions: ModuleComposition["moduleProjectLayoutContributions"];
let moduleSettingsContributions: ModuleComposition["moduleSettingsContributions"];
let moduleSkillsProvider: ModuleComposition["moduleSkillsProvider"];
let modulePanelMigrationAliases: ModuleComposition["modulePanelMigrationAliases"];
let notifyModulesFilesystemChanged: ModuleComposition["notifyModulesFilesystemChanged"];
let notifyModulesBeforeShutdown: ModuleComposition["notifyModulesBeforeShutdown"];
let notifyModulesProjectOpened: ModuleComposition["notifyModulesProjectOpened"];
let selectProjectFactsProvider: ModuleComposition["selectProjectFactsProvider"];

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { middlewareMode: true },
  });
  ({
    activateModules,
    activateModulesWithMessages,
    createEnabledPanelRegistry,
    createEnabledGlobalSurfaceRegistry,
    enabledProjectActionContributions,
    enabledProjectFactsProvider,
    enabledProjectLayoutContributions,
    moduleProjectActionContributions,
    moduleProjectFactsProviders,
    moduleProjectLayoutContributions,
    moduleProjectNavigationContributions,
    moduleScheduledTasks,
    moduleSidebarContributions,
    moduleSettingsContributions,
    moduleSkillsProvider,
    modulePanelMigrationAliases,
    notifyModulesFilesystemChanged,
    notifyModulesBeforeShutdown,
    notifyModulesProjectOpened,
    selectProjectFactsProvider,
  } = await vite.ssrLoadModule(
    "/core/frontend/host/moduleComposition.ts",
  ) as ModuleComposition);
});

after(async () => {
  await vite.close();
});

const builtinGlobalSurfaceLoaders: BuiltinGlobalSurfaceLoaders = {
  settings: async () => ({ default: () => null }),
};

const fixtureSkills = {
  getSnapshot: () => ({ byProject: {} }),
  subscribe: () => () => undefined,
  install: async () => undefined,
} satisfies ModuleHostServices["skills"];

const fixtureModule: ShipctlModule = {
  id: "shipctl.fixture",
  version: "0.0.0",
  panels: [
    {
      id: "fixture.panel",
      moduleId: "shipctl.fixture",
      scope: "project",
      label: "Fixture",
      icon: { name: "test" },
      singleton: "per-project",
      migrationAlias: { kind: "fixture", label: "Migrated fixture" },
      load: async () => ({ default: () => null }),
    },
  ],
  globalSurfaces: [
    {
      id: "fixture.global-surface",
      moduleId: "shipctl.fixture",
      load: async () => ({ default: () => null }),
    },
  ],
  globalNavigation: [
    {
      id: "fixture.global-navigation",
      moduleId: "shipctl.fixture",
      surfaceId: "fixture.global-surface",
      label: "Fixture",
      icon: { name: "test" },
    },
  ],
  sidebar: [
    {
      id: "fixture.sidebar",
      moduleId: "shipctl.fixture",
      surfaceId: "fixture.global-surface",
      order: 10,
      load: async () => ({ default: () => null }),
    },
  ],
  projectNavigation: [
    {
      id: "fixture.project-navigation",
      moduleId: "shipctl.fixture",
      panelId: "fixture.panel",
      load: async () => ({ default: () => null }),
    },
  ],
  projectActions: [
    {
      id: "fixture.project-actions",
      moduleId: "shipctl.fixture",
      order: 5,
      getGroup: () => ({ label: "Fixture", actions: [] }),
    },
  ],
  projectLayout: [
    {
      id: "fixture.project-layout",
      moduleId: "shipctl.fixture",
      slot: "workspace.trailing",
      order: 5,
      load: async () => ({ default: () => null }),
    },
  ],
  projectFactsProvider: {
    id: "fixture.project-facts",
    moduleId: "shipctl.fixture",
    getFacts: () => ({ revision: { label: "main", state: "clean" } }),
  },
  settings: [
    {
      id: "fixture.settings",
      moduleId: "shipctl.fixture",
      load: async () => ({ default: () => null }),
    },
  ],
  skillsProvider: {
    id: "fixture.skills-provider",
    moduleId: "shipctl.fixture",
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
  globalData: {
    read: async () => undefined,
    replace: async () => undefined,
  },
  projectData: {
    read: async () => undefined,
    replace: async () => undefined,
  },
  terminalSessions: {
    list: () => [],
    getDimensions: () => ({ columns: 80, rows: 24 }),
    launch: async (request) => ({
      id: "fixture-session",
      projectPath: request.projectPath,
      ownerKey: request.ownerKey,
      label: request.label,
    }),
    launchManaged: async () => { throw new Error("not used"); },
    update: async (sessionId, patch) => ({
      id: sessionId,
      projectPath: "/fixture",
      ownerKey: "fixture",
      label: patch.label ?? "fixture",
      ownerMetadata: patch.ownerMetadata,
      presentation: patch.presentation,
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
  const registry = createEnabledPanelRegistry([fixtureModule]);
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
  const registry = createEnabledPanelRegistry();
  assert.equal(registry.has("todos.board"), true);
  assert.equal(registry.panel("todos.board")?.migrationAlias?.kind, "todos");
});

test("default profile enables the extracted Ports surface", () => {
  const registry = createEnabledGlobalSurfaceRegistry(builtinGlobalSurfaceLoaders);
  assert.equal(registry.has("ports.overview"), true);
  assert.equal(
    registry.navigation().some(({ id }) => id === "ports.global-navigation"),
    true,
  );
});

test("default profile composes Usage only through its module contributions", () => {
  const registry = createEnabledGlobalSurfaceRegistry(builtinGlobalSurfaceLoaders);
  assert.equal(registry.surface("core.usage")?.moduleId, "shipctl.usage");
  assert.equal(
    registry.navigation().find(({ id }) => id === "usage.global-navigation")?.surfaceId,
    "core.usage",
  );
  assert.equal(
    moduleSidebarContributions().find(({ id }) => id === "usage.sidebar")?.surfaceId,
    "core.usage",
  );
  assert.deepEqual(
    moduleSettingsContributions(undefined, "terminal.after").map(({ id }) => id),
    ["usage.settings"],
  );
});

test("default profile enables the extracted Commands surfaces", () => {
  const registry = createEnabledPanelRegistry();
  assert.equal(registry.has("core.commands"), true);
  assert.equal(registry.panel("core.commands")?.migrationAlias?.kind, "commands");
  assert.equal(
    moduleProjectNavigationContributions().some(
      ({ id, panelId }) => id === "commands.project-navigation" && panelId === "core.commands",
    ),
    true,
  );
});

test("modules own tab migration metadata", () => {
  const result = hydratePanelReference(
    { id: "panel-fixture", kind: "fixture", label: "Saved fixture" },
    {
      availablePanelIds: ["fixture.panel"],
      migrationAliases: modulePanelMigrationAliases([fixtureModule]),
    },
  );

  assert.equal(result.status, "available");
  assert.equal(result.source, "migrated");
  assert.equal(result.panelId, "fixture.panel");
  assert.equal(result.migrationKind, "fixture");
});

test("module surfaces compose without feature-specific host branches", () => {
  assert.deepEqual(
    moduleSidebarContributions([fixtureModule]).map(({ id }) => id),
    ["fixture.sidebar"],
  );
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
  assert.deepEqual(
    moduleSettingsContributions([fixtureModule], "projects.after").map(({ id }) => id),
    ["fixture.settings"],
  );
  assert.deepEqual(
    moduleSettingsContributions([fixtureModule], "terminal.after"),
    [],
  );
});

test("sidebar contributions are ordered, module-owned, and absent when disabled", () => {
  const earlier: ShipctlModule = {
    id: "shipctl.earlier",
    version: "0",
    globalSurfaces: [{
      id: "earlier.global-surface",
      moduleId: "shipctl.earlier",
      load: async () => ({ default: () => null }),
    }],
    sidebar: [{
      id: "earlier.sidebar",
      moduleId: "shipctl.earlier",
      surfaceId: "earlier.global-surface",
      order: -10,
      load: async () => ({ default: () => null }),
    }],
  };

  assert.deepEqual(
    moduleSidebarContributions([fixtureModule, earlier]).map(({ id }) => id),
    ["earlier.sidebar", "fixture.sidebar"],
  );
  assert.deepEqual(moduleSidebarContributions([]), []);
  assert.throws(
    () => moduleSidebarContributions([{
      ...earlier,
      id: "shipctl.other",
    }]),
    /belongs to shipctl\.earlier, not shipctl\.other/,
  );
  assert.throws(
    () => moduleSidebarContributions([{
      ...earlier,
      globalSurfaces: [],
    }]),
    /targets missing module surface earlier\.global-surface/,
  );
});

test("module scheduling supports startup, delayed, and periodic work with cleanup", async () => {
  const calls: string[] = [];
  const timeouts = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  const clearedTimeouts: number[] = [];
  const clearedIntervals: number[] = [];
  let nextHandle = 1;
  const scheduler: ModuleTaskScheduler = {
    setTimeout(callback) {
      const handle = nextHandle++;
      timeouts.set(handle, callback);
      return handle;
    },
    clearTimeout(handle) {
      clearedTimeouts.push(handle);
      timeouts.delete(handle);
    },
    setInterval(callback) {
      const handle = nextHandle++;
      intervals.set(handle, callback);
      return handle;
    },
    clearInterval(handle) {
      clearedIntervals.push(handle);
      intervals.delete(handle);
    },
  };
  const scheduledModule: ShipctlModule = {
    id: "shipctl.scheduled",
    version: "0",
    activate: () => {
      calls.push("activate");
      return { deactivate: () => { calls.push("deactivate"); } };
    },
    scheduledTasks: [
      {
        id: "scheduled.startup",
        moduleId: "shipctl.scheduled",
        schedule: { kind: "startup" },
        run: () => { calls.push("startup"); },
      },
      {
        id: "scheduled.delay",
        moduleId: "shipctl.scheduled",
        schedule: { kind: "delay", delayMs: 3_000 },
        run: () => { calls.push("delay"); },
      },
      {
        id: "scheduled.interval",
        moduleId: "shipctl.scheduled",
        schedule: { kind: "interval", intervalMs: 60_000 },
        run: () => { calls.push("interval"); },
      },
    ],
  };

  assert.deepEqual(
    moduleScheduledTasks([scheduledModule]).map(({ id }) => id),
    ["scheduled.startup", "scheduled.delay", "scheduled.interval"],
  );
  const deactivate = activateModules(services, [scheduledModule], scheduler);
  await Promise.resolve();
  assert.deepEqual(calls, ["activate", "startup"]);
  assert.equal(timeouts.size, 1);
  assert.equal(intervals.size, 1);

  timeouts.values().next().value?.();
  intervals.values().next().value?.();
  await Promise.resolve();
  assert.deepEqual(calls, ["activate", "startup", "delay", "interval"]);

  await deactivate();
  assert.deepEqual(calls, ["activate", "startup", "delay", "interval", "deactivate"]);
  assert.deepEqual(clearedTimeouts, [1]);
  assert.deepEqual(clearedIntervals, [2]);
});

test("disabled and invalid scheduled-task profiles fail safely", () => {
  assert.deepEqual(moduleScheduledTasks([]), []);
  assert.throws(
    () => moduleScheduledTasks([{
      id: "shipctl.invalid",
      version: "0",
      scheduledTasks: [{
        id: "invalid.task",
        moduleId: "shipctl.owner",
        schedule: { kind: "startup" },
        run: () => undefined,
      }],
    }]),
    /belongs to shipctl\.owner, not shipctl\.invalid/,
  );
});

test("partial scheduler registration is rolled back with module activation", async () => {
  const calls: string[] = [];
  const cleared: number[] = [];
  const scheduler: ModuleTaskScheduler = {
    setTimeout: () => 7,
    clearTimeout: (handle) => { cleared.push(handle); },
    setInterval: () => { throw new Error("scheduler unavailable"); },
    clearInterval: () => undefined,
  };
  const module: ShipctlModule = {
    id: "shipctl.rollback",
    version: "0",
    activate: () => ({ deactivate: () => { calls.push("deactivate"); } }),
    scheduledTasks: [
      {
        id: "rollback.delay",
        moduleId: "shipctl.rollback",
        schedule: { kind: "delay", delayMs: 1 },
        run: () => undefined,
      },
      {
        id: "rollback.interval",
        moduleId: "shipctl.rollback",
        schedule: { kind: "interval", intervalMs: 1 },
        run: () => undefined,
      },
    ],
  };

  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const deactivate = activateModules(services, [module], scheduler);
    await Promise.resolve();
    await deactivate();
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(cleared, [7]);
  assert.deepEqual(calls, ["deactivate"]);
});

test("module activation receives only its activation-scoped message facade", async () => {
  const messages = {} as ModuleMessages;
  let received: ModuleMessages | undefined;
  let receivedServices: ModuleHostServices | undefined;
  const module: ShipctlModule = {
    id: "shipctl.messages",
    version: "0",
    activate: (host) => {
      received = host.messages;
      receivedServices = host.services;
    },
  };
  const deactivate = activateModulesWithMessages(
    services,
    new Map([[module.id, messages]]),
    [module],
  );
  assert.equal(received, messages);
  assert.notEqual(receivedServices, services);
  assert.equal(receivedServices?.panels, services.panels);
  await deactivate();
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
      id: "shipctl.other",
    }]),
    /belongs to shipctl.fixture, not shipctl.other/,
  );
});

test("Skills provider selection is optional, singular, and module-owned", () => {
  assert.equal(moduleSkillsProvider([fixtureModule]), services.skills);
  assert.equal(moduleSkillsProvider([]), null);
  assert.throws(
    () => moduleSkillsProvider([fixtureModule, { ...fixtureModule, id: "shipctl.other" }]),
    /belongs to shipctl.fixture, not shipctl.other/,
  );
  assert.throws(
    () => moduleSkillsProvider([fixtureModule, fixtureModule]),
    /Only one enabled module/,
  );
});

test("project lifecycle dispatch isolates module failures", async () => {
  const calls: Array<readonly string[] | string> = [];
  const modules: ShipctlModule[] = [
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

test("pre-shutdown lifecycle is ordered and stops before native shutdown on failure", async () => {
  const calls: string[] = [];
  const modules: ShipctlModule[] = [
    {
      id: "fixture.first",
      version: "0",
      beforeShutdown: async () => {
        await Promise.resolve();
        calls.push("first");
      },
    },
    {
      id: "fixture.failing",
      version: "0",
      beforeShutdown: () => {
        calls.push("failing");
        throw new Error("capture failed");
      },
    },
    {
      id: "fixture.skipped",
      version: "0",
      beforeShutdown: () => {
        calls.push("skipped");
      },
    },
  ];

  await assert.rejects(
    notifyModulesBeforeShutdown(services, modules),
    /capture failed/,
  );
  assert.deepEqual(calls, ["first", "failing"]);
});

test("disabled profile omits implementation and retains recoverable identity", () => {
  const registry = createEnabledPanelRegistry([]);
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
