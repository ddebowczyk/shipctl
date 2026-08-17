import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type {
  ModuleActivationContext,
  ModuleActivationId,
  ShipctlModule,
} from "@shipctl/module-api";
import { createServer, type ViteDevServer } from "vite";

type WorkspaceContributionCatalogModule = typeof import("../workspaceContributionCatalog.ts");
type WorkspaceProfilesModule = typeof import("../../workspace/profiles.ts");

let vite: ViteDevServer;
let WorkspaceContributionCatalog: WorkspaceContributionCatalogModule["WorkspaceContributionCatalog"];
let WorkspaceContributionCatalogError: WorkspaceContributionCatalogModule["WorkspaceContributionCatalogError"];
let createCurrentCanvasWorkspaceCatalog: WorkspaceProfilesModule["createCurrentCanvasWorkspaceCatalog"];
let CURRENT_CANVAS_COMPATIBILITY_VIEW_TYPE_ID: WorkspaceProfilesModule["CURRENT_CANVAS_COMPATIBILITY_VIEW_TYPE_ID"];
let shippedViewModules: readonly ShipctlModule[];

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
    createCurrentCanvasWorkspaceCatalog,
    CURRENT_CANVAS_COMPATIBILITY_VIEW_TYPE_ID,
  } = await vite.ssrLoadModule(
    "/core/frontend/workspace/profiles.ts",
  ) as WorkspaceProfilesModule);
  const [
    assistants,
    commands,
    git,
    ports,
    todos,
    usage,
  ] = await Promise.all([
    vite.ssrLoadModule("/modules/assistants/frontend/src/index.ts"),
    vite.ssrLoadModule("/modules/commands/frontend/src/index.ts"),
    vite.ssrLoadModule("/modules/git/frontend/src/index.ts"),
    vite.ssrLoadModule("/modules/ports/frontend/src/index.ts"),
    vite.ssrLoadModule("/modules/todos/frontend/src/index.ts"),
    vite.ssrLoadModule("/modules/usage/frontend/src/index.ts"),
  ]);
  shippedViewModules = [
    assistants.assistantsModule,
    commands.commandsModule,
    git.gitModule,
    ports.portsModule,
    todos.todosModule,
    usage.usageModule,
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
    own: () => { throw new Error("fixture does not own resources"); },
  };
}

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
) {
  const contexts = new Map(modules.map((module) => [module.id, activation(module.id)]));
  const core = activation("core");
  return WorkspaceContributionCatalog.create({
    registryRevision,
    modules,
    activationContextsByModule: contexts,
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
  const catalog = catalogFor(shippedViewModules, 8);
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
      || shippedViewModules.some((module) => module.id === record.ownerModuleId)),
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

test("catalog admits the host compatibility definition without a module renderer", () => {
  const compatibility = createCurrentCanvasWorkspaceCatalog();
  const catalog = catalogFor().withHostWorkspaceDefinitions(compatibility.definitions);

  assert.deepEqual(
    catalog.workspaceCatalog().definitions.find(
      (definition) => definition.viewTypeId === CURRENT_CANVAS_COMPATIBILITY_VIEW_TYPE_ID,
    ),
    compatibility.definitions[0],
  );
  assert.equal(catalog.renderer(CURRENT_CANVAS_COMPATIBILITY_VIEW_TYPE_ID), undefined);
  assert.equal(
    catalog.withRegistryRevision(8).workspaceCatalog().definitions.some(
      (definition) => definition.viewTypeId === CURRENT_CANVAS_COMPATIBILITY_VIEW_TYPE_ID,
    ),
    true,
  );
  assert.throws(
    () => catalog.withHostWorkspaceDefinitions(compatibility.definitions),
    (error) => error instanceof WorkspaceContributionCatalogError
      && error.code === "duplicate-workspace-view",
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
