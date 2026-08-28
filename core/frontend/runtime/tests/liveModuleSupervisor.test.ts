import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createServer, type ViteDevServer } from "vite";

type SupervisorModule = typeof import("../liveModuleSupervisor.ts");
type SemanticRuntimeModule = typeof import("../semanticServiceRuntime.ts");
type ModuleCatalog = import("../moduleCatalog.ts").RuntimeModuleCatalog;
type ModuleDescriptor = import("../moduleCatalog.ts").RuntimeModuleDescriptor;

let vite: ViteDevServer;
let LiveModuleSupervisor: SupervisorModule["LiveModuleSupervisor"];
let SemanticServiceRegistry: SemanticRuntimeModule["SemanticServiceRegistry"];

before(async () => {
  vite = await createServer({
    server: { hmr: false, middlewareMode: true },
    appType: "custom",
  });
  ({ LiveModuleSupervisor } = await vite.ssrLoadModule(
    "/core/frontend/runtime/liveModuleSupervisor.ts",
  ) as SupervisorModule);
  ({ SemanticServiceRegistry } = await vite.ssrLoadModule(
    "/core/frontend/runtime/semanticServiceRuntime.ts",
  ) as SemanticRuntimeModule);
});

after(async () => {
  await vite.close();
});

function descriptor(moduleId: string, contentDigest: string): ModuleDescriptor {
  return {
    schemaVersion: 1,
    moduleId,
    version: "1.0.0",
    contentDigest,
    entryPath: `/fixture/${moduleId}.mjs`,
    stylePaths: [],
    manifest: {
      schemaVersion: 2,
      lifecycle: "live",
      messages: {},
      requestedGrants: [],
    },
    capabilities: { definitions: [] },
  };
}

test("a rejected recovery graph stays private when the current graph applies", async () => {
  const catalog: ModuleCatalog = {
    schemaVersion: 1,
    registryRevision: 45,
    modules: [],
    lastApplied: {
      registryRevision: 24,
      modules: [],
    },
  };
  const applied: number[] = [];
  const rejected: number[] = [];
  const supervisor = new LiveModuleSupervisor({
    services: {},
    createSemanticServices: () => new SemanticServiceRegistry(),
    publish: () => undefined,
    reportApplied: (family) => { applied.push(family.registryRevision); },
    reportRejected: (diagnostic) => { rejected.push(diagnostic.desiredRevision); },
    getCatalog: async () => catalog,
    observeRevisions: async () => () => undefined,
    openMessageBridge: async () => ({
      bridge: {
        bindingsFor: () => undefined,
        reconcile: async () => undefined,
        deactivateActivation: () => undefined,
        close: async () => undefined,
      },
    }),
    createMessageActivations: () => [],
    loadModules: async (candidate) => ({
      catalog: candidate,
      modules: [],
      definitions: [],
      admissionsByModule: new Map(),
      failures: candidate.registryRevision === 24 ? [{
        moduleId: "shipctl.assistants",
        phase: "validate" as const,
        code: "module.loader.invalid_artifact",
        message: "The previously applied artifact no longer matches this host build",
      }] : [],
    }),
  });

  await supervisor.start();

  assert.deepEqual(applied, [45]);
  assert.deepEqual(rejected, []);
  assert.equal(supervisor.accepted?.desired.registryRevision, 45);

  await supervisor.dispose();
});

test("recovery and current graphs receive distinct activation generations", async () => {
  const retained = descriptor("shipctl.retained", "digest-retained");
  const added = descriptor("shipctl.added", "digest-added");
  const catalog: ModuleCatalog = {
    schemaVersion: 1,
    registryRevision: 45,
    modules: [retained, added],
    lastApplied: {
      registryRevision: 24,
      modules: [retained],
    },
  };
  const activated = new Map<number, string[]>();
  const disposed: string[] = [];
  const supervisor = new LiveModuleSupervisor({
    services: {},
    createSemanticServices: () => new SemanticServiceRegistry(),
    publish: (family) => {
      activated.set(
        family.registryRevision,
        [...family.activationContextsByModule.values()].map(({ identity }) => identity.activationId),
      );
    },
    reportApplied: async () => undefined,
    getCatalog: async () => catalog,
    observeRevisions: async () => () => undefined,
    openMessageBridge: async () => ({
      bridge: {
        bindingsFor: () => undefined,
        reconcile: async () => undefined,
        deactivateActivation: () => undefined,
        close: async () => undefined,
      },
    }),
    createMessageActivations: () => [],
    loadModules: async (candidate) => ({
      catalog: candidate,
      modules: [],
      definitions: candidate.modules.map((module) => ({
        id: module.moduleId,
        version: module.version,
        role: "headless" as const,
        activate: (context: { readonly identity: { readonly activationId: string } }) => ({
          deactivate: () => { disposed.push(context.identity.activationId); },
        }),
      })),
      admissionsByModule: new Map(),
      failures: [],
    }),
  });

  await supervisor.start();

  const recoveryRetained = activated.get(24)?.find((id) => id.startsWith("shipctl.retained@"));
  const currentRetained = activated.get(45)?.find((id) => id.startsWith("shipctl.retained@"));
  assert(recoveryRetained);
  assert(currentRetained);
  assert.notEqual(recoveryRetained, currentRetained);
  assert(disposed.includes(recoveryRetained));
  assert(!disposed.includes(currentRetained));

  await supervisor.dispose();
  assert(disposed.includes(currentRetained));
});
