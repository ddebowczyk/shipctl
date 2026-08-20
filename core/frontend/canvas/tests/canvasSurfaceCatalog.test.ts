import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ShipctlModule } from "@shipctl/module-api";
import { createServer, type ViteDevServer } from "vite";

type CatalogModule = typeof import("../../host/canvasSurfaceCatalog.ts");
type RegistryModule = typeof import("../../host/panelRegistry.ts");

let vite: ViteDevServer;
let CanvasSurfaceCatalog: CatalogModule["CanvasSurfaceCatalog"];
let CanvasSurfaceCatalogError: CatalogModule["CanvasSurfaceCatalogError"];
let CanvasSurfaceLoadError: CatalogModule["CanvasSurfaceLoadError"];
let PanelRegistrationError: RegistryModule["PanelRegistrationError"];

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({
    CanvasSurfaceCatalog,
    CanvasSurfaceCatalogError,
    CanvasSurfaceLoadError,
  } = await vite.ssrLoadModule(
    "/core/frontend/host/canvasSurfaceCatalog.ts",
  ) as CatalogModule);
  ({ PanelRegistrationError } = await vite.ssrLoadModule(
    "/core/frontend/host/panelRegistry.ts",
  ) as RegistryModule);
});

after(async () => {
  await vite.close();
});

function fixtureModule(overrides: Partial<ShipctlModule> = {}): ShipctlModule {
  const module = {
    id: "fixture.module",
    version: "0.0.0",
    panels: [{
      id: "fixture.panel",
      moduleId: "fixture.module",
      scope: "project",
      label: "Fixture panel",
      icon: { name: "test" },
      singleton: "per-project",
      order: 20,
      load: async () => ({ default: () => null }),
    }],
    globalSurfaces: [{
      id: "fixture.surface",
      moduleId: "fixture.module",
      load: async () => ({ default: () => null }),
    }],
    globalNavigation: [{
      id: "fixture.navigation",
      moduleId: "fixture.module",
      surfaceId: "fixture.surface",
      label: "Fixture",
      icon: { name: "test" },
      order: 20,
    }],
    sidebar: [{
      id: "fixture.sidebar",
      moduleId: "fixture.module",
      surfaceId: "fixture.surface",
      order: 20,
      load: async () => ({ default: () => null }),
    }],
    projectNavigation: [{
      id: "fixture.project-navigation",
      moduleId: "fixture.module",
      panelId: "fixture.panel",
      order: 20,
      load: async () => ({ default: () => null }),
    }],
    projectLayout: [{
      id: "fixture.project-layout",
      moduleId: "fixture.module",
      slot: "workspace.trailing",
      order: 20,
      load: async () => ({ default: () => null }),
    }],
  } satisfies ShipctlModule;
  return { ...module, ...overrides };
}

test("catalog gives adapters stable content references and named layout slots", () => {
  const catalog = CanvasSurfaceCatalog.create({
    modules: [fixtureModule()],
    builtinGlobalSurfaces: [{
      id: "core.settings",
      moduleId: "core",
      load: async () => ({ default: () => null }),
    }],
    builtinGlobalNavigation: [{
      id: "core.settings-navigation",
      moduleId: "core",
      surfaceId: "core.settings",
      label: "Settings",
      icon: { name: "settings" },
      order: 10,
    }],
  });

  assert.deepEqual(catalog.panels().map(({ id, surfaceKind, scope, label }) => ({
    id,
    surfaceKind,
    scope,
    label,
  })), [{
    id: "fixture.panel",
    surfaceKind: "panel",
    scope: "project",
    label: "Fixture panel",
  }]);
  assert.deepEqual(catalog.globalNavigation().map(({ id, slot }) => ({ id, slot })), [
    { id: "core.settings-navigation", slot: "sidebar.footer" },
    { id: "fixture.navigation", slot: "sidebar.footer" },
  ]);
  assert.deepEqual(catalog.sidebar().map(({ id, slot, target }) => ({
    id,
    slot,
    target: target.id,
  })), [{
    id: "fixture.sidebar",
    slot: "sidebar.footer",
    target: "fixture.surface",
  }]);
  assert.deepEqual(catalog.projectNavigation().map(({ id, slot, panel }) => ({
    id,
    slot,
    panel: panel.id,
  })), [{
    id: "fixture.project-navigation",
    slot: "project.navigation",
    panel: "fixture.panel",
  }]);
  assert.deepEqual(
    catalog.projectLayout("workspace.trailing").map(({ id, surfaceKind }) => ({
      id,
      surfaceKind,
    })),
    [{ id: "fixture.project-layout", surfaceKind: "project-layout" }],
  );
});

test("catalog rejects duplicate IDs, wrong owners, and missing target surfaces", () => {
  const duplicatePanelModule = {
    id: "duplicate.module",
    version: "0.0.0",
    panels: [{
      id: "fixture.panel",
      moduleId: "duplicate.module",
      scope: "project",
      label: "Duplicate",
      icon: { name: "test" },
      singleton: "per-project",
      load: async () => ({ default: () => null }),
    }],
  } satisfies ShipctlModule;
  assert.throws(
    () => CanvasSurfaceCatalog.create({ modules: [fixtureModule(), duplicatePanelModule] }),
    (error) => error instanceof PanelRegistrationError && error.code === "duplicate-id",
  );
  assert.throws(
    () => CanvasSurfaceCatalog.create({
      modules: [fixtureModule({ id: "other.module" })],
    }),
    (error) => error instanceof CanvasSurfaceCatalogError
      && error.code === "module-owner-mismatch"
      && error.contributionId === "fixture.panel",
  );
  assert.throws(
    () => CanvasSurfaceCatalog.create({
      modules: [fixtureModule({
        sidebar: [{
          id: "fixture.sidebar",
          moduleId: "fixture.module",
          surfaceId: "missing.surface",
          load: async () => ({ default: () => null }),
        }],
      })],
    }),
    (error) => error instanceof CanvasSurfaceCatalogError
      && error.code === "missing-surface"
      && error.contributionId === "fixture.sidebar",
  );
  assert.throws(
    () => CanvasSurfaceCatalog.create({
      modules: [fixtureModule({
        sidebar: [{
          id: "fixture.sidebar",
          moduleId: "fixture.module",
          surfaceId: "core.settings",
          load: async () => ({ default: () => null }),
        }],
      })],
      builtinGlobalSurfaces: [{
        id: "core.settings",
        moduleId: "core",
        load: async () => ({ default: () => null }),
      }],
    }),
    (error) => error instanceof CanvasSurfaceCatalogError
      && error.code === "target-owner-mismatch"
      && error.contributionId === "fixture.sidebar",
  );
});

test("disabled modules are absent and loading errors retain a stable host code", async () => {
  const disabled = CanvasSurfaceCatalog.create();
  assert.equal(disabled.panel("fixture.panel"), undefined);
  assert.equal(disabled.globalSurface("fixture.surface"), undefined);

  const catalog = CanvasSurfaceCatalog.create({
    modules: [fixtureModule({
      panels: [{
        id: "fixture.panel",
        moduleId: "fixture.module",
        scope: "project",
        label: "Fixture panel",
        icon: { name: "test" },
        singleton: "per-project",
        load: async () => {
          throw new Error("fixture import failed");
        },
      }],
    })],
  });
  const panel = catalog.panel("fixture.panel");
  assert.ok(panel);
  await assert.rejects(
    () => panel.load(),
    (error) => error instanceof CanvasSurfaceLoadError
      && error.code === "canvas.surface.load_failed"
      && error.contributionId === "fixture.panel"
      && error.surfaceKind === "panel",
  );
});

test("catalog is host code and semantic workspace hosts use accepted catalog entries", async () => {
  const [catalogSource, adapterSource, moduleSurfacesSource, projectActionsSource, appShellSource] = await Promise.all([
    readFile("core/frontend/host/canvasSurfaceCatalog.ts", "utf8"),
    readFile("core/frontend/canvas/standard/StandardWorkspaceCanvas.tsx", "utf8"),
    readFile("core/frontend/host/ModuleSurfaces.tsx", "utf8"),
    readFile("core/frontend/host/projectActions.ts", "utf8"),
    readFile("core/frontend/shell/AppShell.tsx", "utf8"),
  ]);

  assert.doesNotMatch(catalogSource, /@tauri-apps\//);
  assert.doesNotMatch(catalogSource, /@shipctl\/module-(?!api)/);
  assert.match(adapterSource, /WorkspaceViewHost/);
  assert.match(adapterSource, /TerminalStage/);
  assert.doesNotMatch(adapterSource, /CanvasModel|CanvasActions|CanvasPorts|surfaceCatalog/);
  assert.match(appShellSource, /ModuleProjectLayoutSurfaces/);
  assert.doesNotMatch(moduleSurfacesSource, /modulePanelContributions/);
  assert.doesNotMatch(moduleSurfacesSource, /moduleProjectNavigationContributions/);
  assert.doesNotMatch(moduleSurfacesSource, /moduleSidebarContributions/);
  assert.doesNotMatch(moduleSurfacesSource, /enabledProjectLayoutContributions/);
  assert.doesNotMatch(moduleSurfacesSource, /moduleSettingsContributions/);
  assert.match(moduleSurfacesSource, /useAcceptedWorkspaceContributionRuntime/);
  assert.doesNotMatch(projectActionsSource, /enabledProjectActionContributions/);
});
