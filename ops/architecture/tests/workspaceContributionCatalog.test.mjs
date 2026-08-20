import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

let vite;
let WorkspaceContributionCatalog;
let activeWorkspaceContributionEntries;
let canvasSurfaceComponentKey;
let currentCanvasSurfaceActivation;
let createCommandRegistry;
let subscribeProjectActions;
let WorkspaceAuthority;
let WorkspaceCanvasBridge;
let InMemoryWorkspacePersistence;
let loadShipctlModuleArtifact;

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
  ({
    activeWorkspaceContributionEntries,
    canvasSurfaceComponentKey,
    currentCanvasSurfaceActivation,
  } = await vite.ssrLoadModule(
    "/core/frontend/host/acceptedWorkspaceContributionEntries.ts",
  ));
  ({ createCommandRegistry } = await vite.ssrLoadModule(
    "/core/frontend/shell/commandRegistry.ts",
  ));
  ({ subscribeProjectActions } = await vite.ssrLoadModule(
    "/core/frontend/host/projectActions.ts",
  ));
  ({ WorkspaceAuthority } = await vite.ssrLoadModule(
    "/core/frontend/workspace/authority.ts",
  ));
  ({ WorkspaceCanvasBridge } = await vite.ssrLoadModule(
    "/core/frontend/workspace/canvasBridge.ts",
  ));
  ({ InMemoryWorkspacePersistence } = await vite.ssrLoadModule(
    "/core/frontend/workspace/persistence.ts",
  ));
  ({ loadShipctlModuleArtifact } = await vite.ssrLoadModule(
    "/core/frontend/host/moduleArtifactLoader.ts",
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

const cleanupFixtures = [
  { moduleId: "shipctl.cleanup-alpha", slug: "cleanup-alpha" },
  { moduleId: "shipctl.cleanup-bravo", slug: "cleanup-bravo" },
  { moduleId: "shipctl.cleanup-charlie", slug: "cleanup-charlie" },
];

function cleanupId(fixture, suffix) {
  return `${fixture.slug}.${suffix}`;
}

function cleanupModuleFor(fixture, generation, commandRuns, subscriptions) {
  const load = async () => ({ default: () => null });
  return {
    id: fixture.moduleId,
    version: "1.0.0",
    commands: [{
      id: cleanupId(fixture, "command"),
      moduleId: fixture.moduleId,
      label: `${fixture.slug} command`,
      run: () => commandRuns.push(`${fixture.moduleId}@${generation}`),
    }],
    panels: [{
      id: cleanupId(fixture, "panel"),
      moduleId: fixture.moduleId,
      scope: "project",
      label: `${fixture.slug} panel`,
      icon: { name: "test" },
      singleton: "per-project",
      load,
    }],
    globalSurfaces: [{
      id: cleanupId(fixture, "surface"),
      moduleId: fixture.moduleId,
      load,
    }],
    globalNavigation: [{
      id: cleanupId(fixture, "navigation"),
      moduleId: fixture.moduleId,
      surfaceId: cleanupId(fixture, "surface"),
      label: `${fixture.slug} navigation`,
      icon: { name: "test" },
    }],
    sidebar: [{
      id: cleanupId(fixture, "sidebar"),
      moduleId: fixture.moduleId,
      surfaceId: cleanupId(fixture, "surface"),
      load,
    }],
    projectNavigation: [{
      id: cleanupId(fixture, "project-navigation"),
      moduleId: fixture.moduleId,
      panelId: cleanupId(fixture, "panel"),
      load,
    }],
    projectLayout: [{
      id: cleanupId(fixture, "project-layout"),
      moduleId: fixture.moduleId,
      slot: "workspace.trailing",
      load,
    }],
    projectActions: [{
      id: cleanupId(fixture, "project-action"),
      moduleId: fixture.moduleId,
      getGroup: () => null,
      subscribe: () => {
        const subscriptionId = `${fixture.moduleId}@1#${generation}`;
        subscriptions.add(subscriptionId);
        return () => subscriptions.delete(subscriptionId);
      },
    }],
    settings: [{
      id: cleanupId(fixture, "settings"),
      moduleId: fixture.moduleId,
      load,
    }],
  };
}

function cleanupCatalogFor(owners, registryRevision, commandRuns, subscriptions) {
  const modules = cleanupFixtures
    .filter((fixture) => owners.has(fixture.moduleId))
    .map((fixture) => cleanupModuleFor(
      fixture,
      owners.get(fixture.moduleId),
      commandRuns,
      subscriptions,
    ));
  const moduleActivations = new Map(modules.map((module) => [
    module.id,
    activation(module.id, owners.get(module.id)),
  ]));
  const coreActivation = activation("core", "cleanup-host");
  const catalog = WorkspaceContributionCatalog.create({
    registryRevision,
    modules,
    activationContextsByModule: moduleActivations,
    hostContributions: [{
      moduleId: "core",
      activation: coreActivation,
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
  return {
    catalog,
    modules,
    activations: new Map([...moduleActivations, ["core", coreActivation]]),
  };
}

function contributionFamilies(catalog) {
  return [
    ["command", catalog.commands()],
    ["panel", catalog.panels()],
    ["global-surface", catalog.globalSurfaces()],
    ["global-navigation", catalog.globalNavigation()],
    ["sidebar", catalog.sidebar()],
    ["project-navigation", catalog.projectNavigation()],
    ["project-layout", catalog.projectLayout()],
    ["project-action", catalog.projectActions()],
    ["settings", catalog.settings()],
  ];
}

function canvasSurfaces(catalog) {
  const canvas = catalog.canvasSurfaceCatalog;
  return [
    ...canvas.panels(),
    ...canvas.globalSurfaces(),
    ...canvas.globalNavigation(),
    ...canvas.sidebar(),
    ...canvas.projectNavigation(),
    ...canvas.projectLayout(),
  ];
}

function activeProjectActions(catalog, activations) {
  return activeWorkspaceContributionEntries(
    catalog.projectActions(),
    activations,
  ).map(({ contribution }) => contribution);
}

function expectedSubscriptions(fixtures, generation) {
  return fixtures.map((fixture) => `${fixture.moduleId}@1#${generation}`).sort();
}

function profileForCleanup(workspaceId, catalog) {
  const definitions = catalog.workspaceCatalog().definitions.filter((definition) => (
    definition.ownerModuleId !== "core"
  ));
  const instances = definitions.map((definition) => {
    const placed = definition.viewTypeId.endsWith(".panel");
    return {
      instanceId: `${definition.viewTypeId}.instance`,
      viewTypeId: definition.viewTypeId,
      ownerModuleId: definition.ownerModuleId,
      ownerActivationId: definition.ownerActivationId,
      resource: definition.scope === "project"
        ? { kind: "project", projectId: "/cleanup/project" }
        : { kind: "global" },
      label: definition.label,
      availability: { kind: "available" },
      lifecycle: placed ? "placed" : "hidden",
    };
  });
  const placed = instances.filter((instance) => instance.lifecycle === "placed");
  return {
    schemaVersion: 2,
    workspaceId,
    instances,
    root: placed.length === 0 ? null : {
      kind: "stack",
      stackId: "cleanup.primary",
      instanceIds: placed.map((instance) => instance.instanceId),
      selectedInstanceId: placed[0].instanceId,
    },
    floating: [],
    maximizedStackId: null,
  };
}

function ownerLedger(selected, generation) {
  return new Map(selected.map((fixture) => [fixture.moduleId, generation]));
}

function styleUrls(links) {
  return links.map((link) => link.href).sort();
}

async function withFakeDocument(run) {
  const links = [];
  const fakeDocument = {
    createElement: () => {
      const link = {
        href: "",
        rel: "",
        dataset: {},
        remove() {
          const index = links.indexOf(link);
          if (index >= 0) links.splice(index, 1);
        },
      };
      return link;
    },
    head: {
      append: (link) => links.push(link),
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  try {
    return await run(links);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
}

async function activateStyledArtifact({ moduleId, generation, deactivations, fail = false }) {
  const digest = createHash("sha256")
    .update(`${moduleId}:${generation}:${fail ? "failed" : "active"}`)
    .digest("hex");
  const styleUrl = `asset://localhost/modules/${digest}/presentation.css`;
  const loaded = await loadShipctlModuleArtifact({
    digest,
    entryUrl: `asset://localhost/modules/${digest}/module.mjs`,
    expectedModuleId: moduleId,
    expectedVersion: "1.0.0",
    styleUrls: [styleUrl],
    importModule: async () => ({
      createShipctlModule: () => ({
        id: moduleId,
        version: "1.0.0",
        activate: () => {
          if (fail) throw new Error(`activation failed for ${moduleId}`);
          return {
            deactivate: () => deactivations.push(`${moduleId}@${generation}`),
          };
        },
      }),
    }),
  });
  const deactivation = loaded.module.activate?.({});
  return {
    moduleId,
    generation,
    styleUrl,
    async deactivate() {
      await deactivation?.deactivate();
    },
  };
}

function invalidCandidateModules(initial, failedFixture) {
  return initial.modules.map((module) => module.id !== failedFixture.moduleId ? module : {
    ...module,
    globalNavigation: [
      ...module.globalNavigation,
      {
        id: cleanupId(failedFixture, "invalid-navigation"),
        moduleId: failedFixture.moduleId,
        surfaceId: "core.settings",
        label: "Invalid target",
        icon: { name: "test" },
      },
    ],
  });
}

test("architecture.contribution-cleanup.property", async () => {
  const histories = fc.uniqueArray(fc.constantFrom(...cleanupFixtures), {
    selector: (fixture) => fixture.moduleId,
    minLength: 1,
  }).chain((selected) => fc.tuple(
    fc.subarray(selected, { minLength: 1 }),
    fc.integer({ min: 1, max: 1_000_000 }),
  ).map(([removed, generation]) => ({ selected, removed, generation })));

  await fc.assert(fc.asyncProperty(histories, async ({ selected, removed, generation }) => {
    const removedIds = new Set(removed.map((fixture) => fixture.moduleId));
    const retained = selected.filter((fixture) => !removedIds.has(fixture.moduleId));
    const commandRuns = [];
    const subscriptions = new Set();
    const initialOwners = ownerLedger(selected, generation);
    const initial = cleanupCatalogFor(initialOwners, generation, commandRuns, subscriptions);
    const failedFixture = selected[0];

    assert.throws(() => WorkspaceContributionCatalog.create({
      registryRevision: generation + 100,
      modules: invalidCandidateModules(initial, failedFixture),
      activationContextsByModule: initial.activations,
      hostContributions: [{
        moduleId: "core",
        activation: initial.activations.get("core"),
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
    }));

    const initialRegistry = createCommandRegistry({
      acceptedModuleCommands: initial.catalog.commands(),
      moduleActivations: initial.activations,
    });
    assert.equal(
      (await initialRegistry.dispatch(cleanupId(failedFixture, "command"), {})).status,
      "handled",
    );
    const unsubscribeInitial = subscribeProjectActions(
      () => undefined,
      {},
      activeProjectActions(initial.catalog, initial.activations),
      initial.activations,
    );
    assert.deepEqual([...subscriptions].sort(), expectedSubscriptions(selected, generation));

    const replacementOwners = ownerLedger(selected, generation + 1);
    const replacement = cleanupCatalogFor(
      replacementOwners,
      generation + 1,
      commandRuns,
      subscriptions,
    );
    for (const fixture of selected) {
      for (const [family, entries] of contributionFamilies(initial.catalog)) {
        const owned = entries.filter((entry) => entry.owner.moduleId === fixture.moduleId);
        assert.equal(owned.length, 1, `${fixture.moduleId} must contribute ${family}`);
        assert.deepEqual(activeWorkspaceContributionEntries(owned, replacement.activations), []);
      }
    }
    for (const surface of canvasSurfaces(initial.catalog)) {
      if (initialOwners.has(surface.moduleId)) {
        assert.equal(currentCanvasSurfaceActivation(surface, replacement.activations), undefined);
      }
    }
    const staleRegistry = createCommandRegistry({
      acceptedModuleCommands: initial.catalog.commands(),
      moduleActivations: replacement.activations,
    });
    assert.equal(
      (await staleRegistry.dispatch(cleanupId(failedFixture, "command"), {})).status,
      "unknown",
    );
    unsubscribeInitial();
    assert.deepEqual([...subscriptions], []);
    const unsubscribeReplacement = subscribeProjectActions(
      () => undefined,
      {},
      activeProjectActions(replacement.catalog, replacement.activations),
      replacement.activations,
    );
    assert.deepEqual([...subscriptions].sort(), expectedSubscriptions(selected, generation + 1));

    const workspaceId = `cleanup.workspace.${generation}`;
    const authority = await WorkspaceAuthority.open({
      workspaceId,
      catalog: initial.catalog.workspaceCatalog(),
      persistence: new InMemoryWorkspacePersistence(),
      defaultProfile: ({ workspaceId: id }) => profileForCleanup(id, initial.catalog),
    });
    const bridge = new WorkspaceCanvasBridge({ authority });
    await authority.reconcileCatalog({
      catalog: replacement.catalog.workspaceCatalog(),
      expectedRevision: authority.revision,
      originId: "cleanup.replacement",
    });
    for (const fixture of selected) {
      for (const viewTypeId of [cleanupId(fixture, "panel"), cleanupId(fixture, "surface")]) {
        const view = bridge.snapshot().projection.views.find((candidate) => (
          candidate.instance.viewTypeId === viewTypeId
        ));
        assert.equal(view?.definition?.ownerActivationId, `${fixture.moduleId}@1#${generation + 1}`);
      }
    }

    const reducedOwners = new Map(
      [...replacementOwners].filter(([moduleId]) => !removedIds.has(moduleId)),
    );
    const reduced = cleanupCatalogFor(
      reducedOwners,
      generation + 2,
      commandRuns,
      subscriptions,
    );
    unsubscribeReplacement();
    assert.deepEqual([...subscriptions], []);
    const unsubscribeReduced = subscribeProjectActions(
      () => undefined,
      {},
      activeProjectActions(reduced.catalog, reduced.activations),
      reduced.activations,
    );
    assert.deepEqual([...subscriptions].sort(), expectedSubscriptions(retained, generation + 1));
    await authority.reconcileCatalog({
      catalog: reduced.catalog.workspaceCatalog(),
      expectedRevision: authority.revision,
      originId: "cleanup.removal",
    });
    for (const fixture of removed) {
      const previousActivationId = `${fixture.moduleId}@1#${generation + 1}`;
      assert.equal(
        reduced.catalog.inspect().contributions.some((entry) => entry.ownerActivationId === previousActivationId),
        false,
      );
      assert.equal(
        reduced.catalog.workspaceCatalog().definitions.some((definition) => (
          definition.ownerActivationId === previousActivationId
        )),
        false,
      );
      assert.equal(reduced.catalog.renderer(cleanupId(fixture, "panel")), undefined);
      assert.equal(reduced.catalog.renderer(cleanupId(fixture, "surface")), undefined);
      for (const [family, entries] of contributionFamilies(replacement.catalog)) {
        const owned = entries.filter((entry) => entry.owner.moduleId === fixture.moduleId);
        assert.deepEqual(activeWorkspaceContributionEntries(owned, reduced.activations), [], family);
      }
      for (const surface of canvasSurfaces(replacement.catalog).filter((entry) => entry.moduleId === fixture.moduleId)) {
        assert.equal(currentCanvasSurfaceActivation(surface, reduced.activations), undefined);
      }
      for (const viewTypeId of [cleanupId(fixture, "panel"), cleanupId(fixture, "surface")]) {
        const view = bridge.snapshot().projection.views.find((candidate) => (
          candidate.instance.viewTypeId === viewTypeId
        ));
        assert.equal(view?.definition, null);
        assert.equal(view?.instance.availability.kind, "missing-definition");
      }
      const removedRegistry = createCommandRegistry({
        acceptedModuleCommands: replacement.catalog.commands(),
        moduleActivations: reduced.activations,
      });
      assert.equal(
        (await removedRegistry.dispatch(cleanupId(fixture, "command"), {})).status,
        "unknown",
      );
    }
    for (const fixture of removed) {
      assert.equal(
        subscriptions.has(`${fixture.moduleId}@1#${generation + 1}`),
        false,
      );
    }
    for (const fixture of retained) {
      const retainedRegistry = createCommandRegistry({
        acceptedModuleCommands: replacement.catalog.commands(),
        moduleActivations: reduced.activations,
      });
      assert.equal(
        (await retainedRegistry.dispatch(cleanupId(fixture, "command"), {})).status,
        "handled",
      );
    }

    const readdedOwners = new Map(reducedOwners);
    for (const fixture of removed) readdedOwners.set(fixture.moduleId, generation + 3);
    const readded = cleanupCatalogFor(
      readdedOwners,
      generation + 3,
      commandRuns,
      subscriptions,
    );
    await authority.reconcileCatalog({
      catalog: readded.catalog.workspaceCatalog(),
      expectedRevision: authority.revision,
      originId: "cleanup.readd",
    });
    for (const fixture of removed) {
      const oldKeys = new Set(canvasSurfaces(replacement.catalog)
        .filter((surface) => surface.moduleId === fixture.moduleId)
        .map((surface) => canvasSurfaceComponentKey(surface)));
      const newKeys = new Set(canvasSurfaces(readded.catalog)
        .filter((surface) => surface.moduleId === fixture.moduleId)
        .map((surface) => canvasSurfaceComponentKey(surface)));
      assert.equal([...oldKeys].some((key) => newKeys.has(key)), false);
      for (const viewTypeId of [cleanupId(fixture, "panel"), cleanupId(fixture, "surface")]) {
        const view = bridge.snapshot().projection.views.find((candidate) => (
          candidate.instance.viewTypeId === viewTypeId
        ));
        assert.equal(view?.definition?.ownerActivationId, `${fixture.moduleId}@1#${generation + 3}`);
        assert.equal(view?.instance.availability.kind, "available");
      }
    }
    unsubscribeReduced();
    assert.deepEqual([...subscriptions], []);

    await withFakeDocument(async (links) => {
      const deactivations = [];
      const initialStyles = await Promise.all(selected.map((fixture) => activateStyledArtifact({
        moduleId: fixture.moduleId,
        generation,
        deactivations,
      })));
      assert.deepEqual(styleUrls(links), initialStyles.map((style) => style.styleUrl).sort());
      await assert.rejects(
        () => activateStyledArtifact({
          moduleId: failedFixture.moduleId,
          generation: generation + 99,
          deactivations,
          fail: true,
        }),
        /activation failed/,
      );
      assert.deepEqual(styleUrls(links), initialStyles.map((style) => style.styleUrl).sort());

      await Promise.all(initialStyles.map((style) => style.deactivate()));
      const replacementStyles = await Promise.all(selected.map((fixture) => activateStyledArtifact({
        moduleId: fixture.moduleId,
        generation: generation + 1,
        deactivations,
      })));
      assert.deepEqual(styleUrls(links), replacementStyles.map((style) => style.styleUrl).sort());

      const removedStyles = replacementStyles.filter((style) => removedIds.has(style.moduleId));
      const retainedStyles = replacementStyles.filter((style) => !removedIds.has(style.moduleId));
      await Promise.all(removedStyles.map((style) => style.deactivate()));
      assert.deepEqual(styleUrls(links), retainedStyles.map((style) => style.styleUrl).sort());

      const readdedStyles = await Promise.all(removed.map((fixture) => activateStyledArtifact({
        moduleId: fixture.moduleId,
        generation: generation + 3,
        deactivations,
      })));
      const liveStyles = [...retainedStyles, ...readdedStyles];
      assert.deepEqual(styleUrls(links), liveStyles.map((style) => style.styleUrl).sort());
      await Promise.all(liveStyles.map((style) => style.deactivate()));
      assert.deepEqual(styleUrls(links), []);
      assert.deepEqual(
        deactivations.sort(),
        [...initialStyles, ...replacementStyles, ...readdedStyles]
          .map((style) => `${style.moduleId}@${style.generation}`)
          .sort(),
      );
    });

    bridge.dispose();
    assert.equal(commandRuns.length > 0, true);
  }), propertyParameters());
});
