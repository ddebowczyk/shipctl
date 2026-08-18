import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  ModuleHostServices,
  ProjectFactsProviderContribution,
  ProjectRef,
} from "@shipctl/module-api";
import { createServer, type ViteDevServer } from "vite";

type ProjectFactsModule = typeof import("../projectFacts.ts");
type ModuleComposition = typeof import("../moduleComposition.ts");
type GitModule = typeof import("../../../../modules/git/frontend/src/index.ts");
type GitStoreModule = typeof import("../../../../modules/git/frontend/src/store.ts");

let vite: ViteDevServer;
let refreshProjectFacts: ProjectFactsModule["refreshProjectFacts"];
let resolveProjectFacts: ProjectFactsModule["resolveProjectFacts"];
let subscribeProjectFacts: ProjectFactsModule["subscribeProjectFacts"];
let enabledProjectFactsProvider: ModuleComposition["enabledProjectFactsProvider"];
let gitModule: GitModule["gitModule"];
let useGitStore: GitStoreModule["useGitStore"];

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({
    refreshProjectFacts,
    resolveProjectFacts,
    subscribeProjectFacts,
  } = await vite.ssrLoadModule(
    "/core/frontend/host/projectFacts.ts",
  ) as ProjectFactsModule);
  ({ enabledProjectFactsProvider } = await vite.ssrLoadModule(
    "/core/frontend/host/moduleComposition.ts",
  ) as ModuleComposition);
  ({ gitModule } = await vite.ssrLoadModule(
    "/modules/git/frontend/src/index.ts",
  ) as GitModule);
  ({ useGitStore } = await vite.ssrLoadModule(
    "/modules/git/frontend/src/store.ts",
  ) as GitStoreModule);
});

after(async () => {
  await vite.close();
});

const project: ProjectRef = { id: "/fixture", name: "fixture", path: "/fixture" };
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
} satisfies ModuleHostServices;

test("missing and crashing facts providers degrade to no project facts", () => {
  const crashing: ProjectFactsProviderContribution = {
    id: "fixture.facts",
    moduleId: "fixture",
    getFacts: () => {
      throw new Error("provider failed");
    },
  };

  assert.equal(resolveProjectFacts(project, services, null), null);
  assert.equal(resolveProjectFacts(project, services, crashing), null);
});

test("facts, refresh, subscription, and cleanup flow through the narrow provider", async () => {
  const calls: string[] = [];
  const provider: ProjectFactsProviderContribution = {
    id: "fixture.facts",
    moduleId: "fixture",
    getFacts: () => ({
      revision: { label: "main", state: "changed" },
      lineage: { parentLabel: "fixture" },
    }),
    refresh: async (value) => {
      calls.push(`refresh:${value.path}`);
    },
    subscribe: (listener) => {
      listener();
      calls.push("subscribed");
      return () => calls.push("cleaned");
    },
  };

  const facts = resolveProjectFacts(project, services, provider);
  const cleanup = subscribeProjectFacts(
    () => calls.push("notified"),
    services,
    provider,
  );
  await refreshProjectFacts(project, services, provider);
  cleanup();

  assert.deepEqual(facts, {
    revision: { label: "main", state: "changed" },
    lineage: { parentLabel: "fixture" },
  });
  assert.deepEqual(calls, [
    "notified",
    "subscribed",
    "refresh:/fixture",
    "cleaned",
  ]);
});

test("refresh and subscription failures do not escape into host lifecycle", async () => {
  const provider: ProjectFactsProviderContribution = {
    id: "fixture.facts",
    moduleId: "fixture",
    getFacts: () => null,
    refresh: () => {
      throw new Error("refresh failed");
    },
    subscribe: () => {
      throw new Error("subscribe failed");
    },
  };

  const cleanup = subscribeProjectFacts(() => undefined, services, provider);
  await refreshProjectFacts(project, services, provider);
  assert.doesNotThrow(cleanup);
});

test("an admitted Git module maps revision and lineage into stable generic facts", () => {
  useGitStore.setState({
    projectGitStatus: {
      [project.path]: {
        isRepository: true,
        branchName: "feature/rails",
        dirty: true,
        staged: 1,
        unstaged: 2,
        untracked: 3,
        ahead: 0,
        behind: 0,
        worktreeParentProjectId: "shipctl",
      },
    },
  });
  const provider = enabledProjectFactsProvider([gitModule]);
  const first = resolveProjectFacts(project, services, provider);
  const second = resolveProjectFacts(project, services, provider);

  assert.deepEqual(first, {
    revision: { label: "feature/rails", state: "changed" },
    lineage: { parentLabel: "shipctl" },
  });
  assert.equal(second, first);
});
