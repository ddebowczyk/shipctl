import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

let vite;
let WorkspaceContributionCatalog;

function propertyParameters() {
  const configured = process.env.SHIPCTL_PROPERTY_SEED;
  if (configured === undefined) return {};
  const seed = Number(configured);
  if (!Number.isSafeInteger(seed)) throw new Error("SHIPCTL_PROPERTY_SEED must be a safe integer");
  return { seed };
}

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({ WorkspaceContributionCatalog } = await vite.ssrLoadModule(
    "/core/frontend/host/workspaceContributionCatalog.ts",
  ));
});

after(async () => {
  await vite?.close();
});

const contributionFixtures = [
  { moduleId: "shipctl.git", viewTypeId: "git.panel", kind: "panel" },
  { moduleId: "shipctl.todos", viewTypeId: "todos.panel", kind: "panel" },
  { moduleId: "shipctl.usage", viewTypeId: "usage.surface", kind: "global-surface" },
];

function activation(moduleId, generation) {
  return {
    identity: { moduleId, activationId: `${moduleId}@1#${generation}` },
    disposed: false,
    services: {
      has: () => false,
      require: () => { throw new Error("fixture does not use semantic services"); },
    },
    own: () => { throw new Error("fixture does not own resources"); },
  };
}

function moduleFor(fixture) {
  if (fixture.kind === "panel") {
    return {
      id: fixture.moduleId,
      version: "1.0.0",
      panels: [{
        id: fixture.viewTypeId,
        moduleId: fixture.moduleId,
        scope: "project",
        label: fixture.viewTypeId,
        icon: { name: "test" },
        singleton: "per-project",
        load: async () => ({ default: () => null }),
      }],
    };
  }
  return {
    id: fixture.moduleId,
    version: "1.0.0",
    globalSurfaces: [{
      id: fixture.viewTypeId,
      moduleId: fixture.moduleId,
      load: async () => ({ default: () => null }),
    }],
    globalNavigation: [{
      id: `${fixture.viewTypeId}-navigation`,
      moduleId: fixture.moduleId,
      surfaceId: fixture.viewTypeId,
      label: fixture.viewTypeId,
      icon: { name: "test" },
    }],
  };
}

function catalogFor(selected, revision, generation) {
  const modules = selected.map(moduleFor);
  return WorkspaceContributionCatalog.create({
    registryRevision: revision,
    modules,
    activationContextsByModule: new Map(
      modules.map((module) => [module.id, activation(module.id, generation)]),
    ),
    hostContributions: [{
      moduleId: "core",
      activation: activation("core", generation),
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
    }],
  });
}

function expectedViewIds(selected) {
  return ["core.settings", ...selected.map((item) => item.viewTypeId)].sort();
}

test("architecture.workspace-contribution-catalog.property", async () => {
  const selection = fc.uniqueArray(fc.constantFrom(...contributionFixtures), {
    selector: (fixture) => fixture.moduleId,
  });
  await fc.assert(fc.property(
    selection,
    fc.integer({ min: 1, max: 1_000_000 }),
    (selected, generation) => {
      const accepted = catalogFor(selected, generation, generation);
      const snapshot = accepted.workspaceCatalog();
      const inspection = accepted.inspect();

      assert.deepEqual(
        snapshot.definitions.map((item) => item.viewTypeId),
        expectedViewIds(selected),
      );
      assert.doesNotThrow(() => structuredClone(snapshot));
      for (const fixture of selected) {
        const definition = snapshot.definitions.find((item) => item.viewTypeId === fixture.viewTypeId);
        assert.equal(definition?.ownerModuleId, fixture.moduleId);
        assert.equal(definition?.ownerActivationId, `${fixture.moduleId}@1#${generation}`);
        assert.equal(inspection.contributions.some((item) => (
          item.ownerModuleId === fixture.moduleId && item.ownerActivationId === `${fixture.moduleId}@1#${generation}`
        )), true);
      }

      const retained = accepted.withRegistryRevision(generation + 1);
      assert.equal(retained.workspaceCatalog().revision, generation + 1);
      for (const fixture of selected) {
        assert.equal(
          retained.renderer(fixture.viewTypeId)?.surface.load,
          accepted.renderer(fixture.viewTypeId)?.surface.load,
        );
      }

      const reducedSelection = selected.filter((_, index) => index % 2 === 0);
      const removed = selected.filter((fixture) => !reducedSelection.includes(fixture));
      const reduced = catalogFor(reducedSelection, generation + 2, generation + 2);
      assert.deepEqual(
        reduced.workspaceCatalog().definitions.map((item) => item.viewTypeId),
        expectedViewIds(reducedSelection),
      );
      for (const fixture of removed) {
        assert.equal(reduced.renderer(fixture.viewTypeId), undefined);
        assert.equal(
          reduced.inspect().contributions.some((item) => item.ownerModuleId === fixture.moduleId),
          false,
        );
      }

      const replacement = catalogFor(selected, generation + 3, generation + 3);
      for (const fixture of selected) {
        const definition = replacement.workspaceCatalog().definitions.find(
          (item) => item.viewTypeId === fixture.viewTypeId,
        );
        assert.equal(definition?.ownerActivationId, `${fixture.moduleId}@1#${generation + 3}`);
      }
    },
  ), propertyParameters());
});
