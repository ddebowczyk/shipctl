import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  ModuleActivationContext,
  ModuleActivationId,
  ModuleHostServices,
  ProjectActionContribution,
  ProjectRef,
} from "@shipctl/module-api";
import { createServer, type ViteDevServer } from "vite";

type ProjectActionsModule = typeof import("../projectActions.ts");

let vite: ViteDevServer;
let refreshProjectActions: ProjectActionsModule["refreshProjectActions"];
let resolveProjectActionGroups: ProjectActionsModule["resolveProjectActionGroups"];
let subscribeProjectActions: ProjectActionsModule["subscribeProjectActions"];

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({
    refreshProjectActions,
    resolveProjectActionGroups,
    subscribeProjectActions,
  } = await vite.ssrLoadModule(
    "/core/frontend/host/projectActions.ts",
  ) as ProjectActionsModule);
});

after(async () => {
  await vite.close();
});

const project: ProjectRef = { id: "/fixture", name: "fixture", path: "/fixture" };
function activationFor(
  moduleId: string,
  revision = "one",
  disposed = false,
): ModuleActivationContext {
  return {
    identity: {
      moduleId,
      activationId: `${moduleId}@1#${revision}` as ModuleActivationId,
    },
    disposed,
  } as ModuleActivationContext;
}

const activation = activationFor("fixture");
const activations = new Map([["fixture", activation]]);
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

test("group resolution omits a crashing contribution and keeps siblings", () => {
  const contributions: ProjectActionContribution[] = [
    {
      id: "fixture.crashing",
      moduleId: "fixture",
      getGroup: () => {
        throw new Error("broken module");
      },
    },
    {
      id: "fixture.working",
      moduleId: "fixture",
      getGroup: () => ({
        label: "Working",
        actions: [{ id: "fixture.action", label: "Run", run: () => undefined }],
      }),
    },
  ];

  const groups = resolveProjectActionGroups(project, services, contributions, activations);

  assert.deepEqual(groups.map(({ label }) => label), ["Working"]);
});

test("refresh waits for every contribution without propagating failures", async () => {
  const calls: string[] = [];
  const contributions: ProjectActionContribution[] = [
    {
      id: "fixture.crashing",
      moduleId: "fixture",
      getGroup: () => null,
      refresh: async () => {
        calls.push("crashing");
        throw new Error("refresh failed");
      },
    },
    {
      id: "fixture.working",
      moduleId: "fixture",
      getGroup: () => null,
      refresh: async () => {
        calls.push("working");
      },
    },
  ];

  await refreshProjectActions(project, services, contributions, activations);

  assert.deepEqual(calls, ["crashing", "working"]);
});

test("project actions receive only their owning live activation", async () => {
  const otherActivation = activationFor("other");
  const disposedActivation = activationFor("disposed", "one", true);
  const calls: Array<[string, ModuleActivationContext]> = [];
  const contributions: ProjectActionContribution[] = [
    {
      id: "fixture.live",
      moduleId: "fixture",
      getGroup: (_project, _services, received) => {
        calls.push(["group", received]);
        return null;
      },
      refresh: async (_project, _services, received) => {
        calls.push(["refresh", received]);
      },
      subscribe: (_listener, _services, received) => {
        calls.push(["subscribe", received]);
        return undefined;
      },
    },
    {
      id: "other.live",
      moduleId: "other",
      getGroup: (_project, _services, received) => {
        calls.push(["other-group", received]);
        return null;
      },
    },
    {
      id: "disposed.action",
      moduleId: "disposed",
      getGroup: () => {
        throw new Error("disposed contribution must not run");
      },
      refresh: async () => {
        throw new Error("disposed contribution must not run");
      },
      subscribe: () => {
        throw new Error("disposed contribution must not run");
      },
    },
    {
      id: "missing.action",
      moduleId: "missing",
      getGroup: () => {
        throw new Error("unowned contribution must not run");
      },
    },
  ];
  const ownedActivations = new Map([
    ["fixture", activation],
    ["other", otherActivation],
    ["disposed", disposedActivation],
  ]);

  resolveProjectActionGroups(project, services, contributions, ownedActivations);
  await refreshProjectActions(project, services, contributions, ownedActivations);
  const cleanup = subscribeProjectActions(
    () => undefined,
    services,
    contributions,
    ownedActivations,
  );
  cleanup();

  assert.deepEqual(calls, [
    ["group", activation],
    ["other-group", otherActivation],
    ["refresh", activation],
    ["subscribe", activation],
  ]);
});

test("project action groups retain the exact activation that created their closures", () => {
  const groups = resolveProjectActionGroups(project, services, [{
    id: "fixture.interactive",
    moduleId: "fixture",
    getGroup: () => ({
      label: null,
      actions: [{ id: "fixture.action", label: "Configure", surface: { load: async () => ({ default: () => null }) } }],
    }),
  }], activations);

  assert.equal(groups[0]?.activationId, activation.identity.activationId);
});

test("subscriptions and cleanups isolate contribution failures", () => {
  const calls: string[] = [];
  const contributions: ProjectActionContribution[] = [
    {
      id: "fixture.crashing",
      moduleId: "fixture",
      getGroup: () => null,
      subscribe: () => {
        throw new Error("subscribe failed");
      },
    },
    {
      id: "fixture.working",
      moduleId: "fixture",
      getGroup: () => null,
      subscribe: (listener) => {
        listener();
        calls.push("subscribed");
        return () => calls.push("cleaned");
      },
    },
  ];

  const cleanup = subscribeProjectActions(
    () => calls.push("notified"),
    services,
    contributions,
    activations,
  );
  cleanup();

  assert.deepEqual(calls, ["notified", "subscribed", "cleaned"]);
});

test("inline interactive actions remain data until the host opens their surface", () => {
  const contributions: ProjectActionContribution[] = [
    {
      id: "fixture.interactive-actions",
      moduleId: "fixture",
      getGroup: () => ({
        label: null,
        actions: [
          {
            id: "fixture.interactive-action",
            label: "Configure",
            surface: { load: async () => ({ default: () => null }) },
          },
        ],
      }),
    },
  ];

  const [group] = resolveProjectActionGroups(
    project,
    services,
    contributions,
    activations,
  );
  const [action] = group.actions;

  assert.equal(group.label, null);
  assert.equal(action.label, "Configure");
  assert.equal(typeof action.surface?.load, "function");
  assert.equal(action.run, undefined);
});

test("project hosts depend on generic rails instead of Git UI implementations", () => {
  const root = fileURLToPath(new URL("../../../..", import.meta.url));
  const appShell = readFileSync(`${root}/core/frontend/shell/AppShell.tsx`, "utf8");
  const legacyCanvas = readFileSync(`${root}/core/frontend/canvas/legacy/LegacyCanvas.tsx`, "utf8");
  const projectItem = readFileSync(`${root}/core/frontend/projects/ProjectItem.tsx`, "utf8");

  assert.match(legacyCanvas, /ports\.surfaceCatalog\.projectLayout/);
  assert.doesNotMatch(legacyCanvas, /DiffSummaryPanel/);
  assert.doesNotMatch(appShell, /ModuleProjectLayoutSurfaces/);
  assert.match(projectItem, /ModuleProjectActionSurface/);
  assert.doesNotMatch(projectItem, /gitCreateWorktree/);
});
