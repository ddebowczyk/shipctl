import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  ModuleHostServices,
  ProjectActionContribution,
  ProjectRef,
} from "@shep/module-api";
import { createServer, type ViteDevServer } from "vite";

type ProjectActionsModule = typeof import("../../src/core/modules/projectActions.ts");

let vite: ViteDevServer;
let refreshProjectActions: ProjectActionsModule["refreshProjectActions"];
let resolveProjectActionGroups: ProjectActionsModule["resolveProjectActionGroups"];
let subscribeProjectActions: ProjectActionsModule["subscribeProjectActions"];

before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: fileURLToPath(new URL("../..", import.meta.url)),
    server: { hmr: false, middlewareMode: true },
  });
  ({
    refreshProjectActions,
    resolveProjectActionGroups,
    subscribeProjectActions,
  } = await vite.ssrLoadModule(
    "/src/core/modules/projectActions.ts",
  ) as ProjectActionsModule);
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
  projectData: {
    read: async () => undefined,
    replace: async () => undefined,
  },
  terminalSessions: {
    getDimensions: () => ({ columns: 80, rows: 24 }),
    launch: async (request) => ({
      id: "fixture-session",
      projectPath: request.projectPath,
      ownerKey: request.ownerKey,
      label: request.label,
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

  const groups = resolveProjectActionGroups(project, services, contributions);

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

  await refreshProjectActions(project, services, contributions);

  assert.deepEqual(calls, ["crashing", "working"]);
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

  const [group] = resolveProjectActionGroups(project, services, contributions);
  const [action] = group.actions;

  assert.equal(group.label, null);
  assert.equal(action.label, "Configure");
  assert.equal(typeof action.surface?.load, "function");
  assert.equal(action.run, undefined);
});

test("project hosts depend on generic rails instead of Git UI implementations", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const appShell = readFileSync(`${root}/src/components/layout/AppShell.tsx`, "utf8");
  const projectItem = readFileSync(`${root}/src/components/sidebar/ProjectItem.tsx`, "utf8");

  assert.match(appShell, /ModuleProjectLayoutSurfaces/);
  assert.doesNotMatch(appShell, /DiffSummaryPanel/);
  assert.match(projectItem, /ModuleProjectActionSurface/);
  assert.doesNotMatch(projectItem, /gitCreateWorktree/);
});
