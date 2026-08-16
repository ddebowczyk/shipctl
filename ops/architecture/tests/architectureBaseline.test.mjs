import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

import { inspectArchitecture } from "../bin/inspect.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const baselinePath = path.join(
  repositoryRoot,
  "docs/4-layer-architecture/spec/baseline/source-architecture.json",
);

test("architecture.source-baseline", async () => {
  const expected = JSON.parse(await readFile(baselinePath, "utf8"));
  assert.deepEqual(await inspectArchitecture(repositoryRoot), expected);
});

function generatedModule({ key, order, fields }) {
  const moduleId = `generated.module-${key}`;
  const contributionId = `generated.${key}`;
  const module = { id: moduleId, version: "0.0.0" };
  const surface = { id: contributionId, moduleId, load: async () => ({ default: () => null }) };
  if (fields.panels) {
    module.panels = [{
      id: contributionId,
      moduleId,
      scope: "project",
      label: contributionId,
      icon: { name: "test" },
      singleton: "per-project",
      order,
      load: async () => ({ default: () => null }),
    }];
  }
  if (fields.surfaces || fields.sidebar) module.globalSurfaces = [surface];
  if (fields.navigation) {
    module.globalSurfaces = [surface];
    module.globalNavigation = [{
      id: contributionId,
      moduleId,
      surfaceId: contributionId,
      label: contributionId,
      order,
      icon: { name: "test" },
    }];
  }
  if (fields.sidebar) {
    module.sidebar = [{
      id: contributionId,
      moduleId,
      surfaceId: contributionId,
      order,
      load: async () => ({ default: () => null }),
    }];
  }
  if (fields.projectNavigation) {
    module.projectNavigation = [{
      id: contributionId,
      moduleId,
      panelId: contributionId,
      order,
      load: async () => ({ default: () => null }),
    }];
  }
  if (fields.projectLayout) {
    module.projectLayout = [{
      id: contributionId,
      moduleId,
      slot: "workspace.trailing",
      order,
      load: async () => ({ default: () => null }),
    }];
  }
  if (fields.projectActions) {
    module.projectActions = [{
      id: contributionId,
      moduleId,
      order,
      getGroup: () => null,
    }];
  }
  if (fields.projectFacts) {
    module.projectFactsProvider = {
      id: contributionId,
      moduleId,
      getFacts: () => ({}),
    };
  }
  if (fields.projectImport) {
    module.projectImport = {
      id: contributionId,
      moduleId,
      relatedPaths: async () => [],
    };
  }
  if (fields.settings) {
    module.settings = [{
      id: contributionId,
      moduleId,
      order,
      load: async () => ({ default: () => null }),
    }];
  }
  if (fields.scheduledTasks) {
    module.scheduledTasks = [{
      id: contributionId,
      moduleId,
      schedule: { kind: "delay", delayMs: 1 },
      run: () => undefined,
    }];
  }
  return module;
}

const moduleArbitrary = fc.uniqueArray(fc.record({
  key: fc.nat(),
  order: fc.integer(),
  fields: fc.record({
    panels: fc.boolean(),
    surfaces: fc.boolean(),
    navigation: fc.boolean(),
    sidebar: fc.boolean(),
    projectNavigation: fc.boolean(),
    projectLayout: fc.boolean(),
    projectActions: fc.boolean(),
    projectFacts: fc.boolean(),
    projectImport: fc.boolean(),
    settings: fc.boolean(),
    scheduledTasks: fc.boolean(),
  }),
}), { selector: ({ key }) => key }).map((records) => records.map(generatedModule));

function ids(items) {
  return items.map(({ id }) => String(id));
}

function flattened(modules, field) {
  return modules.flatMap((module) => module[field] ?? []);
}

function ordered(modules, field) {
  return flattened(modules, field)
    .map((item, index) => ({ item, index }))
    .sort((left, right) =>
      (left.item.order ?? 0) - (right.item.order ?? 0) || left.index - right.index)
    .map(({ item }) => item);
}

test("architecture.legacy-composition.property", async () => {
  const vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: repositoryRoot,
    server: { hmr: false, middlewareMode: true },
  });
  try {
    const composition = await vite.ssrLoadModule("/core/frontend/host/moduleComposition.ts");
    fc.assert(fc.property(moduleArbitrary, (modules) => {
    assert.deepEqual(ids(composition.modulePanelContributions(modules)), ids(flattened(modules, "panels")));
    assert.deepEqual(ids(composition.moduleGlobalSurfaceContributions(modules)), ids(flattened(modules, "globalSurfaces")));
    assert.deepEqual(ids(composition.moduleGlobalNavigationContributions(modules)), ids(flattened(modules, "globalNavigation")));
    assert.deepEqual(ids(composition.moduleSidebarContributions(modules)), ids(ordered(modules, "sidebar")));
    assert.deepEqual(ids(composition.moduleProjectNavigationContributions(modules)), ids(ordered(modules, "projectNavigation")));
    assert.deepEqual(ids(composition.moduleProjectLayoutContributions(modules)), ids(ordered(modules, "projectLayout")));
    assert.deepEqual(ids(composition.moduleProjectActionContributions(modules)), ids(ordered(modules, "projectActions")));
    assert.deepEqual(ids(composition.moduleProjectFactsProviders(modules)), ids(flattened(
      modules.map((module) => ({ projectFactsProviders: module.projectFactsProvider ? [module.projectFactsProvider] : [] })),
      "projectFactsProviders",
    )));
    assert.deepEqual(ids(composition.moduleProjectImportContributions(modules)), ids(flattened(
      modules.map((module) => ({ projectImports: module.projectImport ? [module.projectImport] : [] })),
      "projectImports",
    )));
    assert.deepEqual(ids(composition.moduleSettingsContributions(modules)), ids(ordered(modules, "settings")));
    assert.deepEqual(ids(composition.moduleScheduledTasks(modules)), ids(flattened(modules, "scheduledTasks")));
    }));

  const duplicateArbitrary = fc.tuple(
    fc.nat(),
    fc.constantFrom("duplicate-same-kind", "duplicate-cross-kind"),
  );
    fc.assert(fc.property(duplicateArbitrary, ([key, classification]) => {
    const id = `generated.${key}`;
    const first = generatedModule({
      key,
      order: 0,
      fields: { panels: true },
    });
    const second = generatedModule({
      key: key + 1,
      order: 0,
      fields: classification === "duplicate-same-kind"
        ? { panels: true }
        : { surfaces: true },
    });
    if (classification === "duplicate-same-kind") second.panels[0].id = id;
    else second.globalSurfaces[0].id = id;

    if (classification === "duplicate-same-kind") {
      assert.throws(
        () => composition.createEnabledPanelRegistry([first, second]),
        (error) => error?.code === "duplicate-id" && error.contributionId === id,
      );
    } else {
      assert.doesNotThrow(() => composition.createEnabledPanelRegistry([first, second]));
      assert.doesNotThrow(() => composition.createEnabledGlobalSurfaceRegistry({}, [first, second]));
    }
    }));
  } finally {
    await vite.close();
  }
});
