import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

import { checkModuleBoundaries } from "../../modularity/bin/check-module-boundaries.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
let api;
let composition;
let commandsModule;
let createFakePluginDataServiceProvider;
let runtimeApi;
let SemanticServiceRegistry;
let vite;

function propertyParameters() {
  const configured = process.env.SHIPCTL_PROPERTY_SEED;
  if (configured === undefined) return {};
  const seed = Number(configured);
  if (!Number.isSafeInteger(seed)) {
    throw new Error("SHIPCTL_PROPERTY_SEED must be a safe integer");
  }
  return { seed };
}

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: repositoryRoot,
    server: { hmr: false, middlewareMode: true },
  });
  api = await vite.ssrLoadModule("/module-api/frontend/src/index.ts");
  composition = await vite.ssrLoadModule("/core/frontend/host/moduleComposition.ts");
  runtimeApi = await vite.ssrLoadModule("/core/frontend/runtime/cordis/staticPluginRuntime.ts");
  ({ SemanticServiceRegistry } = await vite.ssrLoadModule(
    "/core/frontend/runtime/semanticServiceRuntime.ts",
  ));
  ({ createFakePluginDataServiceProvider } = await vite.ssrLoadModule(
    "/module-api/frontend/src/testing/pluginData.ts",
  ));
  ({ commandsModule } = await vite.ssrLoadModule(
    "/modules/commands/frontend/src/index.ts",
  ));
});

after(async () => {
  await vite?.close();
});

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
    }),
    observe: async () => ({ dispose: async () => undefined }),
    stop: async () => undefined,
    focus: async () => undefined,
    subscribe: () => () => undefined,
  },
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
  externalLinks: { open: async () => undefined },
};

async function withoutExpectedErrorLogging(callback) {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await callback();
  } finally {
    console.error = original;
  }
}

function plugin(module, role = runtimeApi.inferShipctlPluginRole(module), extra = {}) {
  return api.defineShipctlPlugin({ module, role, ...extra });
}

function activeStates(inspection) {
  return new Map(inspection.activations.map((state) => [state.moduleId, state.status]));
}

test("architecture.cordis-lifecycle.property", async () => {
  const specifications = fc.uniqueArray(fc.record({
    key: fc.nat(),
    fail: fc.boolean(),
    replace: fc.boolean(),
  }), { selector: ({ key }) => key });

  await fc.assert(fc.asyncProperty(specifications, async (items) => {
    const runtime = new runtimeApi.CordisStaticPluginRuntime({ services });
    const modules = items.map(({ key, fail }) => ({
      id: `fixture.lifecycle-${key}`,
      version: "1",
      activate: () => {
        if (fail) throw new Error("generated activation failure");
      },
    }));

    const activation = await withoutExpectedErrorLogging(
      () => runtime.activateAll(modules.map(runtimeApi.adaptShipctlModule)),
    );
    const expected = new Map(items.map(({ key, fail }) => [
      `fixture.lifecycle-${key}`,
      fail ? "failed" : "active",
    ]));
    assert.deepEqual(activeStates(runtime.inspect()), expected);

    for (const [index, item] of items.entries()) {
      if (!item.replace) continue;
      const module = modules[index];
      const previousId = runtime.inspect().activations
        .find(({ moduleId }) => moduleId === module.id)?.activationId;
      await runtime.deactivate(module.id);
      const replaced = await runtime.activate(plugin({
        ...module,
        activate: () => undefined,
      }, "headless"));
      assert.equal(replaced, true);
      const next = runtime.inspect().activations.find(({ moduleId }) => moduleId === module.id);
      assert.equal(next?.status, "active");
      assert.notEqual(next?.activationId, previousId);
    }

    assert.deepEqual(
      [...activation.activeModuleIds].sort(),
      items.filter(({ fail }) => !fail).map(({ key }) => `fixture.lifecycle-${key}`).sort(),
    );
    await runtime.dispose();
  }), propertyParameters());
});

test("architecture.cordis-effect-conservation.property", async () => {
  const specifications = fc.uniqueArray(fc.record({
    key: fc.nat(),
    fail: fc.boolean(),
    effects: fc.array(fc.string()),
  }), { selector: ({ key }) => key });

  await fc.assert(fc.asyncProperty(specifications, async (items) => {
    const acquired = new Map();
    const released = new Map();
    const definitions = items.map(({ key, fail, effects }) => {
      const moduleId = `fixture.effects-${key}`;
      return plugin({
        id: moduleId,
        version: "1",
        commands: [{
          id: `${moduleId}.command`,
          moduleId,
          label: "Fixture",
          run: () => undefined,
        }],
        activate: ({ activation }) => {
          effects.forEach((_label, index) => {
            const effectId = `${moduleId}:${index}`;
            acquired.set(effectId, (acquired.get(effectId) ?? 0) + 1);
            activation.own(() => {
              released.set(effectId, (released.get(effectId) ?? 0) + 1);
            });
          });
          if (fail) throw new Error("generated effect failure");
        },
      }, "compound");
    });
    const runtime = new runtimeApi.CordisStaticPluginRuntime({ services });
    await withoutExpectedErrorLogging(() => runtime.activateAll(definitions));
    const inspection = runtime.inspect();
    const failedOwners = new Set(
      inspection.activations.filter(({ status }) => status === "failed")
        .map(({ activationId }) => activationId),
    );
    assert.equal(
      inspection.effects.some(({ ownerActivationId }) => failedOwners.has(ownerActivationId)),
      false,
    );
    assert.equal(
      inspection.contributions.some(({ ownerActivationId }) => failedOwners.has(ownerActivationId)),
      false,
    );
    await runtime.dispose();
    assert.deepEqual(released, acquired);
    assert.deepEqual(runtime.inspect().effects, []);
    assert.deepEqual(runtime.inspect().contributions, []);
  }), propertyParameters());
});

test("architecture.cordis-dispose.property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.string()),
    fc.array(fc.boolean()),
    async (labels, repeatedDisposals) => {
      const releases = [];
      const moduleId = "fixture.dispose";
      const runtime = new runtimeApi.CordisStaticPluginRuntime({ services });
      await runtime.activate(plugin({
        id: moduleId,
        version: "1",
        activate: ({ activation }) => {
          labels.forEach((label) => activation.own(() => { releases.push(label); }));
        },
      }, "headless"));
      await runtime.deactivate(moduleId);
      for (const _repeat of repeatedDisposals) await runtime.deactivate(moduleId);
      await runtime.dispose();
      await runtime.dispose();
      assert.deepEqual(releases, [...labels].reverse());
      assert.equal(activeStates(runtime.inspect()).get(moduleId), "disposed");
    },
  ), propertyParameters());
});

test("architecture.cordis-plugin-role.property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("headless", "presentation", "compound"),
    fc.array(fc.string()),
    async (role, labels) => {
      const key = role.replace("presentation", "view");
      const moduleId = `fixture.role-${key}`;
      const reference = api.defineSemanticService(`${moduleId}.service`, 1);
      const releases = [];
      const hasHeadless = role !== "presentation";
      const hasPresentation = role !== "headless";
      let resolvedService = false;
      const definition = plugin({
        id: moduleId,
        version: "1",
        panels: hasPresentation ? [{
          id: `${moduleId}.panel`,
          moduleId,
          scope: "project",
          label: "Fixture",
          icon: { name: "fixture" },
          singleton: "per-project",
          load: async () => ({ default: () => null }),
        }] : undefined,
        activate: hasHeadless ? ({ activation }) => {
          resolvedService = activation.services.require(reference).value === role;
          labels.forEach((label) => activation.own(() => { releases.push(label); }));
        } : undefined,
      }, role, {
        provides: hasHeadless ? [{
          service: reference,
          bind: () => ({ value: role }),
        }] : undefined,
      });
      const runtime = new runtimeApi.CordisStaticPluginRuntime({ services });
      assert.equal(await runtime.activate(definition), true);
      const inspection = runtime.inspect();
      assert.equal(inspection.activations[0]?.role, role);
      assert.equal(inspection.services.length, hasHeadless ? 1 : 0);
      assert.equal(inspection.contributions.length, hasPresentation ? 1 : 0);
      assert.equal(resolvedService, hasHeadless);
      await runtime.dispose();
      assert.deepEqual(releases, hasHeadless ? [...labels].reverse() : []);
    },
  ), propertyParameters());

  const reference = api.defineSemanticService("fixture.headless-service", 1);
  let consumerAccess;
  let received;
  const provider = plugin({ id: "fixture.provider", version: "1" }, "headless", {
    provides: [{ service: reference, bind: () => ({ value: "served" }) }],
  });
  const consumer = plugin({
    id: "fixture.consumer",
    version: "1",
    activate: ({ activation }) => {
      consumerAccess = activation.services;
      received = activation.services.require(reference).value;
    },
  }, "headless", { requires: [reference] });
  const runtime = new runtimeApi.CordisStaticPluginRuntime({ services });
  const activation = await runtime.activateAll([provider, consumer]);
  assert.deepEqual(activation.failures, []);
  assert.equal(received, "served");
  assert.equal(runtime.inspect().services[0]?.moduleId, "fixture.provider");
  await runtime.deactivate("fixture.provider");
  assert.equal(consumerAccess.has(reference), false);
  assert.equal(activeStates(runtime.inspect()).get("fixture.consumer"), "active");
  assert.deepEqual(runtime.inspect().services, []);
  await runtime.dispose();

  const failedReference = api.defineSemanticService("fixture.failed-service", 1);
  const failedRuntime = new runtimeApi.CordisStaticPluginRuntime({ services });
  const failed = await withoutExpectedErrorLogging(() => failedRuntime.activate(plugin({
    id: "fixture.failed-provider",
    version: "1",
    panels: [{
      id: "fixture.failed-panel",
      moduleId: "fixture.failed-provider",
      scope: "project",
      label: "Fixture",
      icon: { name: "fixture" },
      singleton: "per-project",
      load: async () => ({ default: () => null }),
    }],
    activate: () => { throw new Error("generated readiness failure"); },
  }, "compound", {
    provides: [{ service: failedReference, bind: () => ({ value: "hidden" }) }],
  })));
  assert.equal(failed, false);
  assert.deepEqual(failedRuntime.inspect().services, []);
  assert.deepEqual(failedRuntime.inspect().contributions, []);
  assert.deepEqual(failedRuntime.inspect().effects, []);
  await failedRuntime.dispose();
});

function generatedModule({ key, fields }, index) {
  const moduleId = `fixture.parity-${index}-${key}`;
  const panelId = `${moduleId}.panel`;
  const surfaceId = `${moduleId}.surface`;
  const includePanel = fields.panel || fields.projectNavigation;
  const includeSurface = fields.globalSurface || fields.globalNavigation || fields.sidebar;
  return {
    id: moduleId,
    version: "1",
    commands: fields.command ? [{
      id: `${moduleId}.command`, moduleId, label: "Fixture", run: () => undefined,
    }] : undefined,
    panels: includePanel ? [{
      id: panelId,
      moduleId,
      scope: "project",
      label: "Fixture",
      icon: { name: "fixture" },
      singleton: "per-project",
      order: index,
      load: async () => ({ default: () => null }),
    }] : undefined,
    globalSurfaces: includeSurface ? [{
      id: surfaceId, moduleId, load: async () => ({ default: () => null }),
    }] : undefined,
    globalNavigation: fields.globalNavigation ? [{
      id: `${moduleId}.global-navigation`, moduleId, surfaceId,
      label: "Fixture", icon: { name: "fixture" }, order: index,
    }] : undefined,
    sidebar: fields.sidebar ? [{
      id: `${moduleId}.sidebar`, moduleId, surfaceId, order: index,
      load: async () => ({ default: () => null }),
    }] : undefined,
    projectNavigation: fields.projectNavigation ? [{
      id: `${moduleId}.project-navigation`, moduleId, panelId, order: index,
      load: async () => ({ default: () => null }),
    }] : undefined,
    projectLayout: fields.projectLayout ? [{
      id: `${moduleId}.project-layout`, moduleId, slot: "workspace.trailing", order: index,
      load: async () => ({ default: () => null }),
    }] : undefined,
    projectActions: fields.projectAction ? [{
      id: `${moduleId}.project-action`, moduleId, order: index,
      getGroup: () => ({ label: "Fixture", actions: [] }),
    }] : undefined,
    projectFactsProvider: fields.projectFacts && index === 0 ? {
      id: `${moduleId}.project-facts`, moduleId, getFacts: () => null,
    } : undefined,
    projectImport: fields.projectImport ? {
      id: `${moduleId}.project-import`, moduleId, relatedPaths: () => [],
    } : undefined,
    settings: fields.settings ? [{
      id: `${moduleId}.settings`, moduleId, order: index,
      load: async () => ({ default: () => null }),
    }] : undefined,
    skillsProvider: fields.skills && index === 0 ? {
      id: `${moduleId}.skills`, moduleId, port: services.skills,
    } : undefined,
    scheduledTasks: fields.scheduledTask ? [{
      id: `${moduleId}.schedule`,
      moduleId,
      schedule: {
        cron: "* * * * * Etc/UTC",
        target: {
          kind: "channel",
          endpoint: {
            id: `${moduleId}.scheduled-endpoint`,
            message: { id: `${moduleId}.scheduled-message`, version: 1 },
          },
        },
        payload: {},
      },
    }] : undefined,
    messages: fields.message ? {} : undefined,
    terminalPresentations: fields.terminalPresentation ? [{
      moduleId,
      driverId: `${moduleId}.driver`,
      Presentation: () => null,
    }] : undefined,
  };
}

const contributionFields = {
  command: fc.boolean(),
  panel: fc.boolean(),
  globalSurface: fc.boolean(),
  globalNavigation: fc.boolean(),
  sidebar: fc.boolean(),
  projectNavigation: fc.boolean(),
  projectLayout: fc.boolean(),
  projectAction: fc.boolean(),
  projectFacts: fc.boolean(),
  projectImport: fc.boolean(),
  settings: fc.boolean(),
  skills: fc.boolean(),
  scheduledTask: fc.boolean(),
  message: fc.boolean(),
  terminalPresentation: fc.boolean(),
};

function legacyContributionCatalog(modules) {
  return new Map([
    ["command", modules.flatMap((module) => module.commands ?? [])],
    ["panel", composition.modulePanelContributions(modules)],
    ["global-surface", composition.moduleGlobalSurfaceContributions(modules)],
    ["global-navigation", composition.moduleGlobalNavigationContributions(modules)],
    ["sidebar", composition.moduleSidebarContributions(modules)],
    ["project-navigation", composition.moduleProjectNavigationContributions(modules)],
    ["project-layout", composition.moduleProjectLayoutContributions(modules)],
    ["project-action", composition.moduleProjectActionContributions(modules)],
    ["project-facts", composition.moduleProjectFactsProviders(modules)],
    ["project-import", composition.moduleProjectImportContributions(modules)],
    ["settings", composition.moduleSettingsContributions(modules)],
    ["skills-provider", modules.flatMap((module) => module.skillsProvider ? [module.skillsProvider] : [])],
    ["scheduled-task", composition.moduleScheduledTasks(modules)],
    ["message-graph", modules.flatMap((module) => module.messages ? [{ id: `${module.id}.messages` }] : [])],
    ["terminal-presentation", modules.flatMap((module) =>
      (module.terminalPresentations ?? []).map(({ driverId }) => ({ id: driverId })))],
  ].map(([family, contributions]) => [family, contributions.map(({ id }) => String(id))]));
}

function semanticRegistryForComposition() {
  return new SemanticServiceRegistry([
    { service: api.messagesService, bind: () => ({}) },
    {
      service: api.schedulerService,
      bind: () => ({
        registerSchedule: {
          execute: async () => ({
            correlationId: "fixture-correlation",
            result: { ok: true, value: {} },
          }),
        },
      }),
    },
  ]);
}

test("architecture.static-cordis-parity.property", async () => {
  const modulesArbitrary = fc.uniqueArray(fc.record({
    key: fc.nat(),
    fields: fc.record(contributionFields),
  }), { selector: ({ key }) => key });
  const allFamilies = Object.fromEntries(Object.keys(contributionFields).map((key) => [key, true]));

  await fc.assert(fc.asyncProperty(modulesArbitrary, async (specifications) => {
    const modules = specifications.map(generatedModule);
    const runtime = new runtimeApi.CordisStaticPluginRuntime({
      services,
      semanticServices: semanticRegistryForComposition(),
    });
    const activation = await runtime.activateAll(modules.map(runtimeApi.adaptShipctlModule));
    assert.deepEqual(activation.failures, []);
    const actual = new Map();
    for (const contribution of runtime.inspect().contributions) {
      const ids = actual.get(contribution.family) ?? [];
      ids.push(contribution.id);
      actual.set(contribution.family, ids);
    }
    for (const [family, expectedIds] of legacyContributionCatalog(modules)) {
      assert.deepEqual(actual.get(family) ?? [], expectedIds, family);
    }
    await runtime.dispose();
  }), {
    ...propertyParameters(),
    examples: [[[{ key: 0, fields: allFamilies }]]],
  });

  const duplicateId = "fixture.conflict.panel";
  const duplicateModules = ["first", "second"].map((name) => ({
    id: `fixture.conflict-${name}`,
    version: "1",
    panels: [{
      id: duplicateId,
      moduleId: `fixture.conflict-${name}`,
      scope: "project",
      label: name,
      icon: { name: "fixture" },
      singleton: "per-project",
      load: async () => ({ default: () => null }),
    }],
  }));
  assert.throws(() => composition.createEnabledPanelRegistry(duplicateModules), /registered by both/);
  const conflictRuntime = new runtimeApi.CordisStaticPluginRuntime({ services });
  const conflict = await conflictRuntime.activateAll(
    duplicateModules.map(runtimeApi.adaptShipctlModule),
  );
  assert.deepEqual(conflict.failures, [{ moduleId: "fixture.conflict-second" }]);
  assert.deepEqual(
    conflictRuntime.inspect().contributions.map(({ id }) => id),
    [duplicateId],
  );
  await conflictRuntime.dispose();

  const sharedId = "fixture.cross-family.shared";
  const crossFamilyModule = {
    id: "fixture.cross-family",
    version: "1",
    commands: [{
      id: sharedId,
      moduleId: "fixture.cross-family",
      label: "Fixture",
      run: () => undefined,
    }],
    panels: [{
      id: sharedId,
      moduleId: "fixture.cross-family",
      scope: "project",
      label: "Fixture",
      icon: { name: "fixture" },
      singleton: "per-project",
      load: async () => ({ default: () => null }),
    }],
  };
  const crossFamilyRuntime = new runtimeApi.CordisStaticPluginRuntime({ services });
  assert.equal(
    await crossFamilyRuntime.activate(runtimeApi.adaptShipctlModule(crossFamilyModule)),
    true,
  );
  assert.deepEqual(
    crossFamilyRuntime.inspect().contributions.map(({ family }) => family),
    ["command", "panel"],
  );
  await crossFamilyRuntime.dispose();
});

async function boundaryFixture(source) {
  const root = await mkdtemp(path.join(os.tmpdir(), "shipctl-cordis-boundary-"));
  await mkdir(path.join(root, "core/frontend"), { recursive: true });
  await mkdir(path.join(root, "module-api/frontend/src"), { recursive: true });
  await mkdir(path.join(root, "modules/fixture/frontend/src"), { recursive: true });
  await writeFile(path.join(root, "core/frontend/package.json"), JSON.stringify({
    name: "@shipctl/core",
    exports: { "./runtime": "./runtime/index.ts" },
  }));
  await writeFile(path.join(root, "module-api/frontend/package.json"), JSON.stringify({
    name: "@shipctl/module-api",
    exports: { ".": "./src/index.ts" },
  }));
  await writeFile(path.join(root, "module-api/frontend/src/index.ts"), "export const api = true;");
  await writeFile(path.join(root, "modules/fixture/frontend/package.json"), JSON.stringify({
    name: "@shipctl/module-fixture",
    exports: { ".": "./src/index.ts" },
  }));
  await writeFile(path.join(root, "modules/fixture/frontend/src/index.ts"), source);
  return root;
}

test("architecture.cordis-boundary.property", async () => {
  const cases = {
    valid: "import { api } from '@shipctl/module-api'; export const plugin = { api };",
    "cordis-import": "import { Context } from 'cordis'; export const plugin = new Context();",
    "cordis-source": "import { Context } from '@shipctl/cordis-source/packages/core/src'; export { Context };",
    "top-level-effect": "setTimeout(() => undefined, 0); export const plugin = {};",
    "lifecycle-bypass": "import { Context } from '@cordisjs/core'; export const plugin = new Context().plugin(() => {});",
  };
  await fc.assert(fc.asyncProperty(
    fc.constantFrom(...Object.keys(cases)),
    async (classification) => {
      const root = await boundaryFixture(cases[classification]);
      try {
        const diagnostics = await checkModuleBoundaries(root);
        assert.equal(diagnostics.length === 0, classification === "valid");
        if (classification.startsWith("cordis") || classification === "lifecycle-bypass") {
          assert(diagnostics.some(({ rule }) => rule === "module-cordis-import"));
        }
        if (classification === "top-level-effect") {
          assert(diagnostics.some(({ rule }) => rule === "module-entrypoint-side-effect"));
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  ), propertyParameters());
});

test("commands compound module activates through Cordis", async () => {
  assert.equal(runtimeApi.inferShipctlPluginRole(commandsModule), "compound");
  const runtime = new runtimeApi.CordisStaticPluginRuntime({
    services,
    semanticServices: new SemanticServiceRegistry([
      createFakePluginDataServiceProvider(),
    ]),
  });
  assert.equal(await runtime.activate(runtimeApi.adaptShipctlModule(commandsModule)), true);
  assert.deepEqual(
    runtime.inspect().contributions.map(({ family, id }) => ({ family, id })),
    [
      { family: "command", id: "commands.open-panel" },
      { family: "panel", id: "core.commands" },
      { family: "project-navigation", id: "commands.project-navigation" },
    ],
  );
  await runtime.dispose();
});
