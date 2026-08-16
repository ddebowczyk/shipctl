import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  ModuleActivationContext,
  ModuleHostServices,
  ShipctlModule,
} from "@shipctl/module-api";
import { messagesService } from "@shipctl/module-api";
import type {
  FakeSchedulerClock as FakeSchedulerClockType,
  createFakeSchedulerServiceProvider as CreateFakeSchedulerServiceProvider,
} from "@shipctl/module-api/testing";
import { createServer, type ViteDevServer } from "vite";

import type { BuiltinGlobalSurfaceLoaders } from "../builtinGlobalSurfaceAdapters.ts";
import {
  hydratePanelReference,
  PANEL_REFERENCE_SCHEMA_VERSION,
} from "../panelPersistence.ts";
import { matchesPanelShortcut } from "../panelShortcuts.ts";

type ModuleComposition = typeof import("../moduleComposition.ts");
type StaticPluginRuntime = typeof import("../../runtime/cordis/staticPluginRuntime.ts");

let vite: ViteDevServer;
let createEnabledPanelRegistry: ModuleComposition["createEnabledPanelRegistry"];
let createEnabledGlobalSurfaceRegistry: ModuleComposition["createEnabledGlobalSurfaceRegistry"];
let activateStaticPluginsObserved: StaticPluginRuntime["activateStaticPluginsObserved"];
let createMessagesServiceProvider: typeof import("../../platform/messages.ts")["createMessagesServiceProvider"];
let createFakeSchedulerServiceProvider: typeof CreateFakeSchedulerServiceProvider;
let FakeSchedulerClock: typeof FakeSchedulerClockType;
let SemanticServiceRegistry: typeof import("../../runtime/semanticServiceRuntime.ts")["SemanticServiceRegistry"];
let discoverRelatedProjectPaths: ModuleComposition["discoverRelatedProjectPaths"];
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
    createEnabledPanelRegistry,
    createEnabledGlobalSurfaceRegistry,
    discoverRelatedProjectPaths,
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
  ({ activateStaticPluginsObserved } = await vite.ssrLoadModule(
    "/core/frontend/runtime/cordis/staticPluginRuntime.ts",
  ) as StaticPluginRuntime);
  ({ createMessagesServiceProvider } = await vite.ssrLoadModule(
    "/core/frontend/platform/messages.ts",
  ));
  ({ SemanticServiceRegistry } = await vite.ssrLoadModule(
    "/core/frontend/runtime/semanticServiceRuntime.ts",
  ));
  ({ createFakeSchedulerServiceProvider, FakeSchedulerClock } = await vite.ssrLoadModule(
    "/module-api/frontend/src/testing.ts",
  ));
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

test("module schedules use typed targets and activation-owned cleanup", async () => {
  const calls: string[] = [];
  const clock = new FakeSchedulerClock(0);
  clock.setOccurrences("scheduled.first", [1_000, 2_000]);
  clock.setOccurrences("scheduled.second", [1_000, 2_000]);
  const registry = new SemanticServiceRegistry([
    createFakeSchedulerServiceProvider({
      clock,
      deliver: (input) => {
        calls.push(input.scheduleId);
        return { outcome: "delivered", routeGeneration: 1 };
      },
    }),
  ]);
  const endpoint = {
    id: "scheduled.refresh",
    message: { id: "scheduled.refresh", version: 1 },
  } as const;
  const scheduledModule: ShipctlModule = {
    id: "shipctl.scheduled",
    version: "0",
    activate: () => {
      calls.push("activate");
      return { deactivate: () => { calls.push("deactivate"); } };
    },
    scheduledTasks: [
      {
        id: "scheduled.first",
        moduleId: "shipctl.scheduled",
        schedule: {
          cron: "* * * * * Etc/UTC",
          target: { kind: "channel", endpoint },
          payload: {},
        },
      },
      {
        id: "scheduled.second",
        moduleId: "shipctl.scheduled",
        schedule: {
          cron: "*/5 * * * * Etc/UTC",
          target: { kind: "channel", endpoint },
          payload: {},
        },
      },
    ],
  };

  assert.deepEqual(
    moduleScheduledTasks([scheduledModule]).map(({ id }) => id),
    ["scheduled.first", "scheduled.second"],
  );
  const activation = await activateStaticPluginsObserved(
    services,
    [scheduledModule],
    new Map(),
    registry,
  );
  assert.deepEqual(activation.failures, []);
  assert.deepEqual(calls, ["activate"]);
  await clock.advanceTo(1_000);
  assert.deepEqual(calls, ["activate", "scheduled.first", "scheduled.second"]);

  await activation.deactivate();
  await clock.advanceTo(2_000);
  assert.deepEqual(calls, ["activate", "scheduled.first", "scheduled.second", "deactivate"]);
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
        schedule: {
          cron: "* * * * * Etc/UTC",
          target: {
            kind: "channel",
            endpoint: { id: "invalid.task", message: { id: "invalid.task", version: 1 } },
          },
          payload: {},
        },
      }],
    }]),
    /belongs to shipctl\.owner, not shipctl\.invalid/,
  );
});

test("partial scheduler registration is rolled back with module activation", async () => {
  const calls: string[] = [];
  const clock = new FakeSchedulerClock(0);
  clock.setOccurrences("rollback.first", [1_000]);
  const registry = new SemanticServiceRegistry([
    createFakeSchedulerServiceProvider({
      clock,
      deliver: () => {
        calls.push("delivered");
        return { outcome: "delivered", routeGeneration: 1 };
      },
    }),
  ]);
  const schedule = {
    cron: "* * * * * Etc/UTC",
    target: {
      kind: "channel" as const,
      endpoint: {
        id: "rollback.refresh",
        message: { id: "rollback.refresh", version: 1 },
      },
    },
    payload: {},
  };
  const module: ShipctlModule = {
    id: "shipctl.rollback",
    version: "0",
    activate: () => ({ deactivate: () => { calls.push("deactivate"); } }),
    scheduledTasks: [
      {
        id: "rollback.first",
        moduleId: "shipctl.rollback",
        schedule,
      },
      {
        id: "rollback.invalid",
        moduleId: "shipctl.rollback",
        schedule: { ...schedule, cron: "* * * * *" },
      },
    ],
  };

  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const activation = await activateStaticPluginsObserved(
      services,
      [module],
      new Map(),
      registry,
    );
    assert.deepEqual(activation.failures, [{ moduleId: module.id }]);
    await activation.deactivate();
  } finally {
    console.error = originalConsoleError;
  }

  await clock.advanceTo(1_000);
  assert.deepEqual(calls, ["deactivate"]);
});

test("module activation resolves only its activation-scoped message service", async () => {
  const activationId = "shipctl.messages@0#message-bridge";
  let received: unknown;
  let receivedServices: ModuleHostServices | undefined;
  let receivedActivation: ModuleActivationContext | undefined;
  const deactivated: string[] = [];
  const module: ShipctlModule = {
    id: "shipctl.messages",
    version: "0",
    messages: {},
    activate: (host) => {
      received = host.activation.services.require(messagesService);
      receivedServices = host.services;
      receivedActivation = host.activation;
    },
  };
  const client = {
    send: async () => ({}),
    publish: async () => ({}),
    request: async () => ({}),
  };
  const registry = new SemanticServiceRegistry([
    createMessagesServiceProvider({
      clientsByActivation: new Map([[activationId, {
        moduleId: module.id,
        activationId,
        client,
      }]]),
      deactivateActivation: (id) => { deactivated.push(id); },
    }),
  ]);
  const activation = await activateStaticPluginsObserved(
    services,
    [module],
    new Map([[module.id, activationId]]),
    registry,
  );
  assert.deepEqual(activation.failures, []);
  assert(received);
  assert.notEqual(receivedServices, services);
  assert.equal(receivedServices?.panels, services.panels);
  assert.deepEqual(receivedActivation?.identity, {
    moduleId: module.id,
    activationId,
  });
  await activation.deactivate();
  assert.deepEqual(deactivated, [activationId]);
});

test("surface composition exposes the exact active module context", async () => {
  let receivedActivation: ModuleActivationContext | undefined;
  const module: ShipctlModule = {
    id: "shipctl.surface-context",
    version: "0",
    activate: ({ activation }) => {
      receivedActivation = activation;
    },
  };
  const observed = await activateStaticPluginsObserved(
    services,
    [module],
  );
  assert.equal(
    observed.activationContextsByModule.get(module.id),
    receivedActivation,
  );
  await observed.deactivate();
  assert.equal(receivedActivation?.disposed, true);
});

test("related-project discovery receives only its owning module activation", async () => {
  const exactActivation = { disposed: false } as ModuleActivationContext;
  let receivedActivation: ModuleActivationContext | undefined;
  const module: ShipctlModule = {
    id: "shipctl.related-projects",
    version: "0",
    projectImport: {
      id: "fixture.related-projects",
      moduleId: "shipctl.related-projects",
      relatedPaths: async (_projectPath, _options, _services, activation) => {
        receivedActivation = activation;
        return ["/fixture-related"];
      },
    },
  };

  assert.deepEqual(
    await discoverRelatedProjectPaths(
      "/fixture",
      { expandRelated: true },
      services,
      new Map([[module.id, exactActivation]]),
      [module],
    ),
    ["/fixture-related"],
  );
  assert.equal(receivedActivation, exactActivation);

  receivedActivation = undefined;
  assert.deepEqual(
    await discoverRelatedProjectPaths(
      "/fixture",
      { expandRelated: true },
      services,
      new Map(),
      [module],
    ),
    [],
  );
  assert.equal(receivedActivation, undefined);
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
  const activationIds: string[] = [];
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
        onProjectOpened: (path, _services, activation) => {
          calls.push(path);
          activationIds.push(activation.identity.activationId);
        },
        onFilesystemChanged: (paths) => {
          calls.push([...paths]);
        },
      },
    },
  ];
  const observed = await activateStaticPluginsObserved(
    services,
    modules,
  );

  await notifyModulesProjectOpened(
    "/fixture",
    services,
    observed.activationContextsByModule,
    modules,
  );
  await notifyModulesFilesystemChanged(
    ["/fixture"],
    services,
    observed.activationContextsByModule,
    modules,
  );
  assert.deepEqual(calls, ["/fixture", ["/fixture"]]);
  assert.deepEqual(activationIds, [
    observed.activationContextsByModule.get("fixture.working")?.identity.activationId,
  ]);
  await observed.deactivate();
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
