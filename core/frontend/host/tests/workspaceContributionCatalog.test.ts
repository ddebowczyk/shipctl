import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type {
  ModuleActivationContext,
  ModuleActivationId,
  PluginContributionRegistries,
  ShipctlModule,
} from "@shipctl/module-api";
import { createServer, type ViteDevServer } from "vite";

import type { WorkspaceContributionSource } from "../workspaceContributionCatalog.ts";

type WorkspaceContributionCatalogModule = typeof import("../workspaceContributionCatalog.ts");
type AcceptedWorkspaceContributionEntriesModule = typeof import(
  "../acceptedWorkspaceContributionEntries.ts"
);
type CommandsContributionsModule = typeof import(
  "../../../../modules/commands/frontend/src/pluginContributions.ts"
);
type AssistantsContributionsModule = typeof import(
  "../../../../modules/assistants/frontend/src/pluginContributions.ts"
);
type PortsContributionsModule = typeof import(
  "../../../../modules/ports/frontend/src/pluginContributions.ts"
);
type TodosContributionsModule = typeof import(
  "../../../../modules/todos/frontend/src/pluginContributions.ts"
);
type GitContributionsModule = typeof import(
  "../../../../modules/git/frontend/src/pluginContributions.ts"
);
type UsageContributionsModule = typeof import(
  "../../../../modules/usage/frontend/src/pluginContributions.ts"
);

let vite: ViteDevServer;
let WorkspaceContributionCatalog: WorkspaceContributionCatalogModule["WorkspaceContributionCatalog"];
let WorkspaceContributionCatalogError: WorkspaceContributionCatalogModule["WorkspaceContributionCatalogError"];
let activeWorkspaceContributionEntries: AcceptedWorkspaceContributionEntriesModule["activeWorkspaceContributionEntries"];
let canvasSurfaceComponentKey: AcceptedWorkspaceContributionEntriesModule["canvasSurfaceComponentKey"];
let currentCanvasSurfaceActivation: AcceptedWorkspaceContributionEntriesModule["currentCanvasSurfaceActivation"];
let createDefaultWorkspaceCatalog: typeof import("../../workspace/profiles.ts")["createDefaultWorkspaceCatalog"];
let shippedViewModules: readonly ShipctlModule[];
let shippedRuntimeContributions: readonly WorkspaceContributionSource[];

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({ WorkspaceContributionCatalog, WorkspaceContributionCatalogError } = await vite.ssrLoadModule(
    "/core/frontend/host/workspaceContributionCatalog.ts",
  ) as WorkspaceContributionCatalogModule);
  ({
    activeWorkspaceContributionEntries,
    canvasSurfaceComponentKey,
    currentCanvasSurfaceActivation,
  } = await vite.ssrLoadModule(
    "/core/frontend/host/acceptedWorkspaceContributionEntries.ts",
  ) as AcceptedWorkspaceContributionEntriesModule);
  ({ createDefaultWorkspaceCatalog } = await vite.ssrLoadModule(
    "/core/frontend/workspace/profiles.ts",
  ) as typeof import("../../workspace/profiles.ts"));
  const [
    assistants,
    commands,
    git,
    ports,
    todos,
    usage,
  ] = await Promise.all([
    vite.ssrLoadModule("/modules/assistants/frontend/src/index.ts"),
    vite.ssrLoadModule("/modules/commands/frontend/src/pluginContributions.ts"),
    vite.ssrLoadModule("/modules/git/frontend/src/index.ts"),
    vite.ssrLoadModule("/modules/ports/frontend/src/pluginContributions.ts"),
    vite.ssrLoadModule("/modules/todos/frontend/src/pluginContributions.ts"),
    vite.ssrLoadModule("/modules/usage/frontend/src/pluginContributions.ts"),
  ]);
  const assistantsContributions = assistants as AssistantsContributionsModule;
  const commandsContributions = commands as CommandsContributionsModule;
  const gitContributions = git as GitContributionsModule;
  const portsContributions = ports as PortsContributionsModule;
  const todosContributions = todos as TodosContributionsModule;
  const usageContributions = usage as UsageContributionsModule;
  shippedViewModules = [];
  shippedRuntimeContributions = [
    {
      moduleId: assistantsContributions.ASSISTANTS_MODULE_ID,
      activation: activation(assistantsContributions.ASSISTANTS_MODULE_ID),
      panels: assistantsContributions.assistantsContributions.panels,
    },
    {
      moduleId: commandsContributions.COMMANDS_MODULE_ID,
      activation: activation(commandsContributions.COMMANDS_MODULE_ID),
      commands: commandsContributions.commandsContributions.commands,
      panels: commandsContributions.commandsContributions.panels,
      projectNavigation: commandsContributions.commandsContributions.projectNavigation,
    },
    {
      moduleId: portsContributions.PORTS_MODULE_ID,
      activation: activation(portsContributions.PORTS_MODULE_ID),
      globalSurfaces: portsContributions.portsContributions.globalSurfaces,
      globalNavigation: portsContributions.portsContributions.globalNavigation,
    },
    {
      moduleId: todosContributions.TODOS_MODULE_ID,
      activation: activation(todosContributions.TODOS_MODULE_ID),
      panels: todosContributions.todosContributions.panels,
      projectNavigation: todosContributions.todosContributions.projectNavigation,
      settings: todosContributions.todosContributions.settings,
    },
    {
      moduleId: gitContributions.GIT_MODULE_ID,
      activation: activation(gitContributions.GIT_MODULE_ID),
      panels: gitContributions.gitContributions.panels,
      projectNavigation: gitContributions.gitContributions.projectNavigation,
      projectLayout: gitContributions.gitContributions.projectLayout,
      projectActions: gitContributions.gitContributions.projectActions,
      settings: gitContributions.gitContributions.settings,
    },
    {
      moduleId: usageContributions.USAGE_MODULE_ID,
      activation: activation(usageContributions.USAGE_MODULE_ID),
      globalSurfaces: usageContributions.usageContributions.globalSurfaces,
      globalNavigation: usageContributions.usageContributions.globalNavigation,
      sidebar: usageContributions.usageContributions.sidebars,
      settings: usageContributions.usageContributions.settings,
    },
  ];
});

after(async () => {
  await vite.close();
});

function activation(moduleId: string, revision = "1"): ModuleActivationContext {
  const identity = {
    moduleId,
    activationId: `${moduleId}@1#${revision}` as ModuleActivationId,
  };
  return {
    identity,
    disposed: false,
    services: {
      has: () => false,
      require: () => { throw new Error("fixture does not use semantic services"); },
    },
    notices: { push: () => undefined },
    contributions: EMPTY_CONTRIBUTIONS,
    own: () => { throw new Error("fixture does not own resources"); },
  };
}

const EMPTY_CONTRIBUTIONS: PluginContributionRegistries = Object.freeze({
  commands: { register: () => { throw new Error("fixture does not register contributions"); } },
  configuration: { register: () => { throw new Error("fixture does not register contributions"); } },
  globalNavigation: { register: () => { throw new Error("fixture does not register contributions"); } },
  globalSurfaces: { register: () => { throw new Error("fixture does not register contributions"); } },
  messages: { register: () => { throw new Error("fixture does not register contributions"); } },
  panels: { register: () => { throw new Error("fixture does not register contributions"); } },
  projectActions: { register: () => { throw new Error("fixture does not register contributions"); } },
  projectFacts: { register: () => { throw new Error("fixture does not register contributions"); } },
  projectImports: { register: () => { throw new Error("fixture does not register contributions"); } },
  projectLayouts: { register: () => { throw new Error("fixture does not register contributions"); } },
  projectNavigation: { register: () => { throw new Error("fixture does not register contributions"); } },
  scheduledTasks: { register: () => { throw new Error("fixture does not register contributions"); } },
  settings: { register: () => { throw new Error("fixture does not register contributions"); } },
  sidebars: { register: () => { throw new Error("fixture does not register contributions"); } },
  skillsProviders: { register: () => { throw new Error("fixture does not register contributions"); } },
  terminalPresentations: { register: () => { throw new Error("fixture does not register contributions"); } },
});

const fixtureModule: ShipctlModule = {
  id: "shipctl.fixture",
  version: "1.0.0",
  commands: [{
    id: "fixture.command",
    moduleId: "shipctl.fixture",
    label: "Fixture command",
    run: () => undefined,
  }],
  panels: [{
    id: "fixture.panel",
    moduleId: "shipctl.fixture",
    scope: "project",
    label: "Fixture panel",
    icon: { name: "test" },
    singleton: "per-project",
    requiredCapabilities: ["fixture.read"],
    migrationAlias: { kind: "fixture-panel" },
    load: async () => ({ default: () => null }),
  }],
  globalSurfaces: [{
    id: "fixture.surface",
    moduleId: "shipctl.fixture",
    load: async () => ({ default: () => null }),
  }],
  globalNavigation: [{
    id: "fixture.navigation",
    moduleId: "shipctl.fixture",
    surfaceId: "fixture.surface",
    label: "Fixture",
    icon: { name: "test" },
  }],
  sidebar: [{
    id: "fixture.sidebar",
    moduleId: "shipctl.fixture",
    surfaceId: "fixture.surface",
    load: async () => ({ default: () => null }),
  }],
  projectNavigation: [{
    id: "fixture.project-navigation",
    moduleId: "shipctl.fixture",
    panelId: "fixture.panel",
    load: async () => ({ default: () => null }),
  }],
  projectLayout: [{
    id: "fixture.project-layout",
    moduleId: "shipctl.fixture",
    slot: "workspace.trailing",
    load: async () => ({ default: () => null }),
  }],
  projectActions: [{
    id: "fixture.project-action",
    moduleId: "shipctl.fixture",
    getGroup: () => null,
  }],
  settings: [{
    id: "fixture.settings",
    moduleId: "shipctl.fixture",
    load: async () => ({ default: () => null }),
  }],
};

function hostContributions(context: ModuleActivationContext) {
  return [{
    moduleId: "core",
    activation: context,
    globalSurfaces: [{
      id: "core.settings",
      moduleId: "core",
      load: async () => ({ default: () => null }),
    }],
    globalNavigation: [{
      id: "core.settings-navigation",
      moduleId: "core",
      surfaceId: "core.settings",
      label: "Settings",
      icon: { name: "settings" },
    }],
  }];
}

function catalogFor(
  modules: readonly ShipctlModule[] = [fixtureModule],
  registryRevision = 7,
  runtimeContributions: readonly WorkspaceContributionSource[] = [],
) {
  const contexts = new Map([
    ...modules.map((module) => [module.id, activation(module.id)] as const),
    ...runtimeContributions.map((source) => [source.moduleId, source.activation] as const),
  ]);
  const core = activation("core");
  return WorkspaceContributionCatalog.create({
    registryRevision,
    modules,
    activationContextsByModule: contexts,
    runtimeContributions,
    hostContributions: hostContributions(core),
  });
}

test("catalog admits one activation-owned family and keeps renderer ports private", () => {
  const catalog = catalogFor();
  const snapshot = catalog.workspaceCatalog();

  assert.deepEqual(
    snapshot.definitions.map((definition) => ({
      viewTypeId: definition.viewTypeId,
      ownerModuleId: definition.ownerModuleId,
      ownerActivationId: definition.ownerActivationId,
      scope: definition.scope,
      cardinality: definition.cardinality,
    })),
    [
      {
        viewTypeId: "core.settings",
        ownerModuleId: "core",
        ownerActivationId: "core@1#1",
        scope: "global",
        cardinality: "singleton",
      },
      {
        viewTypeId: "fixture.panel",
        ownerModuleId: "shipctl.fixture",
        ownerActivationId: "shipctl.fixture@1#1",
        scope: "project",
        cardinality: "one-per-resource",
      },
      {
        viewTypeId: "fixture.surface",
        ownerModuleId: "shipctl.fixture",
        ownerActivationId: "shipctl.fixture@1#1",
        scope: "global",
        cardinality: "singleton",
      },
    ],
  );
  assert.deepEqual(
    catalog.inspect().contributions.map(({ family, id, ownerModuleId, ownerActivationId }) => ({
      family,
      id,
      ownerModuleId,
      ownerActivationId,
    })),
    [
      { family: "command", id: "fixture.command", ownerModuleId: "shipctl.fixture", ownerActivationId: "shipctl.fixture@1#1" },
      { family: "global-navigation", id: "core.settings-navigation", ownerModuleId: "core", ownerActivationId: "core@1#1" },
      { family: "global-navigation", id: "fixture.navigation", ownerModuleId: "shipctl.fixture", ownerActivationId: "shipctl.fixture@1#1" },
      { family: "global-surface", id: "core.settings", ownerModuleId: "core", ownerActivationId: "core@1#1" },
      { family: "global-surface", id: "fixture.surface", ownerModuleId: "shipctl.fixture", ownerActivationId: "shipctl.fixture@1#1" },
      { family: "panel", id: "fixture.panel", ownerModuleId: "shipctl.fixture", ownerActivationId: "shipctl.fixture@1#1" },
      { family: "project-action", id: "fixture.project-action", ownerModuleId: "shipctl.fixture", ownerActivationId: "shipctl.fixture@1#1" },
      { family: "project-layout", id: "fixture.project-layout", ownerModuleId: "shipctl.fixture", ownerActivationId: "shipctl.fixture@1#1" },
      { family: "project-navigation", id: "fixture.project-navigation", ownerModuleId: "shipctl.fixture", ownerActivationId: "shipctl.fixture@1#1" },
      { family: "settings", id: "fixture.settings", ownerModuleId: "shipctl.fixture", ownerActivationId: "shipctl.fixture@1#1" },
      { family: "sidebar", id: "fixture.sidebar", ownerModuleId: "shipctl.fixture", ownerActivationId: "shipctl.fixture@1#1" },
    ],
  );
  assert.equal(catalog.renderer("fixture.panel")?.kind, "panel");
  assert.equal(catalog.renderer("fixture.surface")?.kind, "global-surface");
  assert.equal(catalog.renderer("fixture.settings"), undefined);
  assert.deepEqual(
    snapshot.definitions.find((definition) => definition.viewTypeId === "fixture.panel")?.migrationAliases,
    [],
  );
  assert.deepEqual(structuredClone(snapshot), snapshot);
  assert.equal("load" in snapshot.definitions[0]!, false);
  assert.equal("surface" in snapshot.definitions[0]!, false);
});

test("catalog admits every current shipped view contributor", () => {
  const catalog = catalogFor(shippedViewModules, 8, shippedRuntimeContributions);
  assert.deepEqual(
    catalog.workspaceCatalog().definitions.map((definition) => definition.viewTypeId),
    [
      "assistants.launcher",
      "core.commands",
      "core.git",
      "core.settings",
      "core.usage",
      "ports.overview",
      "todos.board",
    ],
  );
  assert.equal(
    catalog.inspect().contributions.every((record) => record.ownerModuleId === "core"
      || shippedViewModules.some((module) => module.id === record.ownerModuleId)
      || shippedRuntimeContributions.some((source) => source.moduleId === record.ownerModuleId)),
    true,
  );
});

test("catalog rejects inactive, cross-activation, and duplicate semantic declarations", () => {
  assert.throws(
    () => WorkspaceContributionCatalog.create({
      registryRevision: 1,
      modules: [fixtureModule],
      activationContextsByModule: new Map(),
    }),
    (error) => error instanceof WorkspaceContributionCatalogError
      && error.code === "missing-activation",
  );

  assert.throws(
    () => WorkspaceContributionCatalog.create({
      registryRevision: 1,
      modules: [fixtureModule],
      activationContextsByModule: new Map([[fixtureModule.id, activation("shipctl.other")]]),
    }),
    (error) => error instanceof WorkspaceContributionCatalogError
      && error.code === "activation-owner-mismatch",
  );

  const crossActivationNavigation: ShipctlModule = {
    id: "shipctl.other",
    version: "1.0.0",
    globalNavigation: [{
      id: "other.navigation",
      moduleId: "shipctl.other",
      surfaceId: "fixture.surface",
      label: "Other",
      icon: { name: "test" },
    }],
  };
  assert.throws(
    () => catalogFor([fixtureModule, crossActivationNavigation]),
    (error) => error instanceof WorkspaceContributionCatalogError
      && error.code === "target-owner-mismatch"
      && error.contributionId === "other.navigation",
  );

  const duplicateView: ShipctlModule = {
    id: "shipctl.duplicate",
    version: "1.0.0",
    panels: [{
      id: "duplicate.view",
      moduleId: "shipctl.duplicate",
      scope: "global",
      label: "Duplicate",
      icon: { name: "test" },
      singleton: "global",
      load: async () => ({ default: () => null }),
    }],
    globalSurfaces: [{
      id: "duplicate.view",
      moduleId: "shipctl.duplicate",
      load: async () => ({ default: () => null }),
    }],
  };
  assert.throws(
    () => catalogFor([duplicateView]),
    (error) => error instanceof WorkspaceContributionCatalogError
      && error.code === "duplicate-workspace-view"
      && error.contributionId === "duplicate.view",
  );
});

test("catalog removal drops every removed owner record and retained revisions keep loaders", () => {
  const additionalModule: ShipctlModule = {
    id: "shipctl.additional",
    version: "1.0.0",
    panels: [{
      id: "additional.panel",
      moduleId: "shipctl.additional",
      scope: "project",
      label: "Additional",
      icon: { name: "test" },
      singleton: "per-project",
      load: async () => ({ default: () => null }),
    }],
  };
  const full = catalogFor([fixtureModule, additionalModule], 3);
  const retained = full.withRegistryRevision(4);
  const reduced = catalogFor([fixtureModule], 5);

  assert.equal(retained.workspaceCatalog().revision, 4);
  assert.equal(
    retained.canvasSurfaceCatalog.panel("fixture.panel")?.load,
    full.canvasSurfaceCatalog.panel("fixture.panel")?.load,
  );
  assert.equal(retained.renderer("fixture.panel")?.surface.load, full.renderer("fixture.panel")?.surface.load);
  assert.equal(reduced.workspaceCatalog().definitions.some((item) => item.viewTypeId === "additional.panel"), false);
  assert.equal(reduced.inspect().contributions.some((item) => item.ownerModuleId === "shipctl.additional"), false);
  assert.equal(reduced.renderer("additional.panel"), undefined);
});

test("accepted entry selection rejects a stale activation after replacement or removal", () => {
  const fixtureActivation = activation(fixtureModule.id, "one");
  const coreActivation = activation("core");
  const catalog = WorkspaceContributionCatalog.create({
    registryRevision: 1,
    modules: [fixtureModule],
    activationContextsByModule: new Map([[fixtureModule.id, fixtureActivation]]),
    hostContributions: hostContributions(coreActivation),
  });
  const acceptedActivations = new Map([
    [fixtureModule.id, fixtureActivation],
    ["core", coreActivation],
  ]);

  assert.deepEqual(
    activeWorkspaceContributionEntries(catalog.projectActions(), acceptedActivations)
      .map(({ contribution }) => contribution.id),
    ["fixture.project-action"],
  );
  assert.deepEqual(
    activeWorkspaceContributionEntries(catalog.settings(), acceptedActivations)
      .map(({ contribution }) => contribution.id),
    ["fixture.settings"],
  );

  const replacement = activation(fixtureModule.id, "two");
  const noStaleEntries = new Map([
    [fixtureModule.id, replacement],
    ["core", coreActivation],
  ]);
  assert.deepEqual(
    activeWorkspaceContributionEntries(catalog.projectActions(), noStaleEntries),
    [],
  );
  assert.deepEqual(
    activeWorkspaceContributionEntries(catalog.settings(), noStaleEntries), []);
  const stalePanel = catalog.canvasSurfaceCatalog.panel("fixture.panel");
  assert.ok(stalePanel);
  assert.equal(currentCanvasSurfaceActivation(stalePanel, noStaleEntries), undefined);

  const replacementCatalog = WorkspaceContributionCatalog.create({
    registryRevision: 2,
    modules: [fixtureModule],
    activationContextsByModule: new Map([[fixtureModule.id, replacement]]),
    hostContributions: hostContributions(coreActivation),
  });
  const replacementPanel = replacementCatalog.canvasSurfaceCatalog.panel("fixture.panel");
  assert.ok(replacementPanel);
  assert.equal(currentCanvasSurfaceActivation(replacementPanel, noStaleEntries), replacement);
  assert.notEqual(canvasSurfaceComponentKey(stalePanel), canvasSurfaceComponentKey(replacementPanel));

  assert.deepEqual(
    activeWorkspaceContributionEntries(catalog.projectActions(), new Map([["core", coreActivation]])),
    [],
  );
});

test("default workspace catalog introduces no private host compatibility definition", () => {
  const defaults = createDefaultWorkspaceCatalog();
  const catalog = catalogFor().withHostWorkspaceDefinitions(defaults.definitions);

  assert.deepEqual(defaults.definitions, []);
  assert.equal(
    catalog.workspaceCatalog().definitions.some((definition) => definition.ownerModuleId === "shipctl.host"),
    false,
  );
});

test("catalog source remains independent from Tauri, Layman, and React", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../workspaceContributionCatalog.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(source, /@tauri-apps\//);
  assert.doesNotMatch(source, /react-layman/);
  assert.doesNotMatch(source, /from ["']react["']/);
});
