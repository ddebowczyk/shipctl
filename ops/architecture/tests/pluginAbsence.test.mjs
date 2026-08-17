import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { createServer } from "vite";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const EMPTY_MESSAGES = Object.freeze({
  schemaVersion: 1,
  provides: [],
  handles: [],
  publishes: [],
  subscribes: [],
  ports: [],
});
const UNAVAILABLE_SERVICE = Object.freeze({ id: "fixture.unavailable", version: 1 });
const CORE_VIEW_TYPE_ID = "core.settings";
const CORE_INSTANCE_ID = "core.settings.instance";

let vite;
let LiveModuleSupervisor;
let WorkspaceContributionCatalog;
let WorkspaceAuthority;
let WorkspaceCanvasBridge;
let InMemoryWorkspacePersistence;
let SemanticServiceRegistry;
let loadRuntimeModules;
let openModuleMessageBridge;

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
    define: { "import.meta.env.DEV": "false" },
    optimizeDeps: { noDiscovery: true },
    root: repositoryRoot,
    server: { hmr: false, middlewareMode: true },
  });
  ({ LiveModuleSupervisor } = await vite.ssrLoadModule(
    "/core/frontend/host/liveModuleSupervisor.ts",
  ));
  ({ WorkspaceContributionCatalog } = await vite.ssrLoadModule(
    "/core/frontend/host/workspaceContributionCatalog.ts",
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
  ({ SemanticServiceRegistry } = await vite.ssrLoadModule(
    "/core/frontend/runtime/semanticServiceRuntime.ts",
  ));
  ({ loadRuntimeModules } = await vite.ssrLoadModule(
    "/core/frontend/host/runtimeModuleLoader.ts",
  ));
  ({ openModuleMessageBridge } = await vite.ssrLoadModule(
    "/core/frontend/host/messageBusBridge.ts",
  ));
});

after(async () => {
  await vite?.close();
});

function digest(...parts) {
  return createHash("sha256").update(parts.join(":"), "utf8").digest("hex");
}

function builtInArtifactTemplates() {
  const modulesDirectory = path.join(repositoryRoot, "modules");
  const templates = readdirSync(modulesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(modulesDirectory, entry.name, "artifact", "module.template.json"))
    .filter((file) => existsSync(file))
    .map((file) => ({ file, template: JSON.parse(readFileSync(file, "utf8")) }))
    .sort((left, right) => left.template.id.localeCompare(right.template.id));
  return templates.map(({ file, template }) => {
    assert.equal(template.schemaVersion, 2, `${file} must use artifact schema v2`);
    assert.equal(template.runtimeKind, "frontend_esm", `${file} must be a frontend artifact`);
    assert.equal(template.lifecycle, "live", `${file} must be admitted to the live runtime`);
    assert.equal(typeof template.id, "string", `${file} must declare an ID`);
    assert.equal(typeof template.version, "string", `${file} must declare a version`);
    return Object.freeze({ moduleId: template.id, version: template.version, file });
  });
}

function generatedBundledModuleIds() {
  const source = readFileSync(
    path.join(repositoryRoot, "src-tauri", "generated", "bundled_modules.rs"),
    "utf8",
  );
  return [...source.matchAll(/module_id: "([^"]+)"/g)]
    .map((match) => match[1])
    .sort();
}

const builtIns = builtInArtifactTemplates();
const builtInIds = builtIns.map(({ moduleId }) => moduleId);

function surfaceId(moduleId) {
  return `absence.${moduleId}.surface`;
}

function definitionApplication(moduleId, requires = []) {
  return {
    schemaVersion: 1,
    role: "presentation",
    requiredServices: requires,
    providedServices: [],
    backgroundEffects: [],
    contributions: [{
      family: "global-surface",
      id: surfaceId(moduleId),
      schemaVersion: 1,
    }],
  };
}

function descriptorFor(entry, revision, condition = "ready") {
  const contentDigest = digest(entry.moduleId, entry.version, revision, condition);
  const requires = condition === "not-ready" ? [UNAVAILABLE_SERVICE] : [];
  return Object.freeze({
    schemaVersion: 1,
    moduleId: entry.moduleId,
    version: entry.version,
    contentDigest,
    entryPath: `/fixture/modules/${entry.moduleId}/${contentDigest}/dist/plugin.mjs`,
    stylePaths: [],
    manifest: {
      schemaVersion: 2,
      lifecycle: "live",
      messages: EMPTY_MESSAGES,
      requestedGrants: [],
      application: definitionApplication(entry.moduleId, requires),
    },
    capabilities: { definitions: [] },
  });
}

function pluginDefinitionFor(descriptor, condition) {
  const requires = condition === "not-ready" ? [UNAVAILABLE_SERVICE] : [];
  return {
    module: {
      id: descriptor.moduleId,
      version: descriptor.version,
      globalSurfaces: [{
        id: surfaceId(descriptor.moduleId),
        moduleId: descriptor.moduleId,
        load: async () => ({ default: () => null }),
      }],
    },
    role: "presentation",
    ...(requires.length === 0 ? {} : { requires }),
  };
}

function catalog(revision, modules) {
  return Object.freeze({ schemaVersion: 1, registryRevision: revision, modules });
}

function activation(moduleId, marker) {
  return Object.freeze({
    identity: Object.freeze({ moduleId, activationId: `${moduleId}@1#${marker}` }),
    disposed: false,
    services: Object.freeze({
      has: () => false,
      require: () => { throw new Error("fixture does not provide semantic services"); },
    }),
    own: () => { throw new Error("fixture does not own resources"); },
  });
}

function createWorkspaceContributions(coreActivation, family) {
  return WorkspaceContributionCatalog.create({
    registryRevision: family.registryRevision,
    modules: family.modules,
    activationContextsByModule: family.activationContextsByModule,
    hostContributions: [{
      moduleId: "core",
      activation: coreActivation,
      globalSurfaces: [{
        id: CORE_VIEW_TYPE_ID,
        moduleId: "core",
        load: async () => ({ default: () => null }),
      }],
    }],
  });
}

function coreWorkspaceProfile(coreActivation) {
  return ({ workspaceId, catalog: workspaceCatalog }) => {
    const coreDefinition = workspaceCatalog.definitions.find(
      (definition) => definition.viewTypeId === CORE_VIEW_TYPE_ID,
    );
    assert(coreDefinition, "the host workspace must retain its core surface");
    return {
      schemaVersion: 1,
      workspaceId,
      profileId: "absence.core",
      instances: [{
        instanceId: CORE_INSTANCE_ID,
        viewTypeId: CORE_VIEW_TYPE_ID,
        ownerModuleId: "core",
        ownerActivationId: coreActivation.identity.activationId,
        resource: { kind: "global" },
        label: coreDefinition.label,
        stateRef: null,
        availability: { kind: "available" },
        lifecycle: "placed",
      }],
      root: {
        kind: "stack",
        stackId: "absence.core.stack",
        instanceIds: [CORE_INSTANCE_ID],
        selectedInstanceId: CORE_INSTANCE_ID,
      },
      floating: [],
      maximizedStackId: null,
    };
  };
}

function emptyRouteSnapshot(routeGeneration) {
  return {
    schemaVersion: 1,
    instanceId: "absence-instance",
    incarnation: "absence-incarnation",
    routeGeneration,
    channels: [],
    topics: [],
    ports: [],
  };
}

function messageTransport() {
  let routeGeneration = 0;
  let closes = 0;
  return {
    get closes() { return closes; },
    async open() {
      return {
        schemaVersion: 1,
        bridgeId: "absence-bridge",
        snapshot: emptyRouteSnapshot(routeGeneration),
      };
    },
    async reconcile(_bridgeId, expectedRouteGeneration) {
      routeGeneration = expectedRouteGeneration + 1;
      return {
        schemaVersion: 1,
        bridgeId: "absence-bridge",
        snapshot: emptyRouteSnapshot(routeGeneration),
      };
    },
    async close() {
      closes += 1;
      return emptyRouteSnapshot(routeGeneration);
    },
    async send() { throw new Error("absence fixture does not send messages"); },
    async publish() { throw new Error("absence fixture does not publish messages"); },
    async request() { throw new Error("absence fixture does not request messages"); },
    async reply() {},
    async reportFailure() {},
  };
}

function sortedModuleIds(values) {
  return values.map((value) => {
    const moduleId = typeof value === "string" ? value : value.moduleId ?? value.id;
    assert.equal(typeof moduleId, "string", "module identity must be inspectable");
    return moduleId;
  }).sort();
}

function currentFamilyIds(supervisor) {
  return sortedModuleIds(supervisor.accepted?.publicFamily.modules ?? []);
}

function normalizedImportBatches(batches) {
  return batches.map(({ expected, attempted }) => ({
    expected,
    attempted: [...attempted].sort(),
  }));
}

function subsetArbitrary() {
  return fc.oneof(
    fc.constant({ classification: "empty-optional", selected: [] }),
    fc.constantFrom(...builtIns).map((entry) => ({ classification: "singleton", selected: [entry] })),
    fc.subarray(builtIns, { minLength: 2 }).map((selected) => ({
      classification: "mixed",
      selected,
    })),
  );
}

/**
 * This property reads only artifact declarations to build its independent
 * subset model. It never imports a module implementation package. The trusted
 * import adapter below records every request made by the real runtime loader.
 */
test("architecture.plugin-absence.property", async () => {
  assert.deepEqual(builtInIds, generatedBundledModuleIds());

  const histories = fc.tuple(
    subsetArbitrary(),
    fc.constantFrom("load-failure", "not-ready"),
    fc.integer({ min: 1, max: 1_000_000 }),
  ).map(([subset, failureKind, revision]) => ({ ...subset, failureKind, revision }));

  await fc.assert(fc.asyncProperty(histories, async ({
    selected,
    failureKind,
    revision,
  }) => {
    const selectedIds = sortedModuleIds(selected);
    const baselineModules = selected.map((entry) => descriptorFor(entry, revision));
    const failureEntry = builtIns.find((entry) => !selectedIds.includes(entry.moduleId))
      ?? selected[0];
    assert(failureEntry, "the built-in model must contain at least one artifact");
    const failureDescriptor = descriptorFor(failureEntry, revision + 1, failureKind);
    const candidateModules = baselineModules.some(
      (descriptor) => descriptor.moduleId === failureEntry.moduleId,
    )
      ? baselineModules.map((descriptor) => (
        descriptor.moduleId === failureEntry.moduleId ? failureDescriptor : descriptor
      ))
      : [...baselineModules, failureDescriptor];
    const baselineCatalog = catalog(revision, baselineModules);
    const failedCatalog = catalog(revision + 1, candidateModules);
    const coreActivation = activation("core", `absence-${revision}`);
    const transport = messageTransport();
    const importBatches = [];
    const published = [];
    const applied = [];
    const rejected = [];
    let currentCatalog = baselineCatalog;

    const supervisor = new LiveModuleSupervisor({
      staticModules: [],
      services: {},
      createSemanticServices: () => new SemanticServiceRegistry(),
      createWorkspaceContributions: (family) => createWorkspaceContributions(coreActivation, family),
      openMessageBridge: (modules) => openModuleMessageBridge(
        modules,
        transport,
        (module) => `${module.id}@${module.version}#static`,
      ),
      loadModules: async (runtimeCatalog) => {
        const batch = { expected: sortedModuleIds(runtimeCatalog.modules), attempted: [] };
        importBatches.push(batch);
        return loadRuntimeModules(runtimeCatalog, {
          resolveArtifactUrl: (_artifactPath, contentDigest) => (
            `asset://localhost/fixture/${contentDigest}/plugin.mjs`
          ),
          importModule: async (entryUrl) => {
            const descriptor = runtimeCatalog.modules.find(
              (candidate) => entryUrl.includes(candidate.contentDigest),
            );
            assert(descriptor, `loader requested an artifact outside catalog ${runtimeCatalog.registryRevision}`);
            batch.attempted.push(descriptor.moduleId);
            if (
              runtimeCatalog.registryRevision === failedCatalog.registryRevision
              && descriptor.contentDigest === failureDescriptor.contentDigest
              && failureKind === "load-failure"
            ) {
              throw new Error(`fixture artifact package is absent: ${descriptor.moduleId}`);
            }
            const condition = (
              runtimeCatalog.registryRevision === failedCatalog.registryRevision
              && descriptor.contentDigest === failureDescriptor.contentDigest
            ) ? failureKind : "ready";
            return {
              createShipctlPlugin: () => pluginDefinitionFor(descriptor, condition),
            };
          },
        });
      },
      getCatalog: async () => currentCatalog,
      observeRevisions: async () => () => undefined,
      publish: (family) => published.push(family),
      reportApplied: async (family) => { applied.push(family); },
      reportRejected: async (diagnostic) => { rejected.push(diagnostic); },
    });

    let workspaceBridge;
    try {
      await supervisor.start();
      assert.deepEqual(currentFamilyIds(supervisor), selectedIds);
      assert.deepEqual(sortedModuleIds(published[0]?.modules ?? []), selectedIds);
      assert.deepEqual(sortedModuleIds(applied[0]?.modules ?? []), selectedIds);
      assert.equal(published[0]?.workspaceContributions?.registryRevision, revision);
      assert.deepEqual(normalizedImportBatches(importBatches), [
        { expected: selectedIds, attempted: selectedIds },
      ]);

      const acceptedCatalog = supervisor.accepted?.publicFamily.workspaceContributions;
      assert(acceptedCatalog, "an accepted runtime family must compile workspace contributions");
      assert.deepEqual(
        acceptedCatalog.inspect().contributions
          .filter((entry) => entry.ownerModuleId !== "core")
          .map((entry) => entry.ownerModuleId)
          .sort(),
        selectedIds,
      );
      assert.deepEqual(
        [...(supervisor.accepted?.publicFamily.artifactDescriptorsByModule.keys() ?? [])].sort(),
        selectedIds,
      );

      const authority = await WorkspaceAuthority.open({
        workspaceId: `absence.workspace.${revision}`,
        catalog: acceptedCatalog.workspaceCatalog(),
        persistence: new InMemoryWorkspacePersistence(),
        defaultProfile: coreWorkspaceProfile(coreActivation),
      });
      workspaceBridge = new WorkspaceCanvasBridge({ authority });
      assert.equal(
        workspaceBridge.snapshot().projection.views.find(
          (view) => view.instance.instanceId === CORE_INSTANCE_ID,
        )?.definition?.viewTypeId,
        CORE_VIEW_TYPE_ID,
      );
      await workspaceBridge.execute({ kind: "select", instanceId: CORE_INSTANCE_ID });

      currentCatalog = failedCatalog;
      await supervisor.reconcileLatest();

      const candidateIds = sortedModuleIds(candidateModules);
      assert.deepEqual(normalizedImportBatches(importBatches), [
        { expected: selectedIds, attempted: selectedIds },
        { expected: candidateIds, attempted: candidateIds },
      ]);
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0]?.desiredRevision, failedCatalog.registryRevision);
      assert.equal(rejected[0]?.moduleId, failureEntry.moduleId);
      assert.equal(rejected[0]?.stage, failureKind === "load-failure" ? "prepare" : "validate");
      assert.deepEqual(currentFamilyIds(supervisor), selectedIds);
      assert.equal(published.length, 1);
      assert.equal(applied.length, 1);
      assert.equal(workspaceBridge.snapshot().projection.catalogRevision, revision);
      await workspaceBridge.execute({ kind: "select", instanceId: CORE_INSTANCE_ID });
    } finally {
      workspaceBridge?.dispose();
      await supervisor.dispose();
    }
    assert.equal(transport.closes, 1);
  }), propertyParameters());
});
