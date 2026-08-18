import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ContributionId,
  TerminalHostDescriptor,
  UiWorkspaceDocument,
  WorkspaceMutationResult,
  WorkspaceRevision,
} from "@shipctl/module-api";
import type { TerminalId, TerminalViewId } from "@shipctl/core/terminal-host";
import type { TerminalTabData, UnifiedTab } from "@shipctl/core/platform";
import type {
  WorkspaceCanvas,
  WorkspaceCanvasAction,
  WorkspaceCanvasProjection,
} from "@shipctl/core/workspace";
import { createServer, type ViteDevServer } from "vite";

import type {
  CanvasActions,
  CanvasModelInput,
  CanvasPorts,
  CanvasTerminalSlotInput,
} from "../types.ts";
import type { CanvasViewPorts } from "../viewPorts.ts";

type CanvasModelModule = typeof import("../canvasModel.ts");
type LegacyCanvasModule = typeof import("../legacy/LegacyCanvas.tsx");

let vite: ViteDevServer;
let createCanvasModel: CanvasModelModule["createCanvasModel"];
let LegacyCanvas: LegacyCanvasModule["default"];

before(async () => {
  vite = await createServer({
    server: { hmr: false, middlewareMode: true },
    appType: "custom",
  });
  ({ createCanvasModel } = await vite.ssrLoadModule(
    "/core/frontend/canvas/canvasModel.ts",
  ) as CanvasModelModule);
  ({ default: LegacyCanvas } = await vite.ssrLoadModule(
    "/core/frontend/canvas/legacy/LegacyCanvas.tsx",
  ) as LegacyCanvasModule);
});

after(async () => {
  await vite.close();
});

function terminalTab(id: string, terminalId: string, projectPath = "/repo"): TerminalTabData {
  return {
    id: id as TerminalViewId,
    kind: "terminal",
    terminalId: terminalId as TerminalId,
    repoPath: projectPath,
    commandName: null,
    terminalRevision: 1,
    lifecycle: "running",
    label: terminalId,
  };
}

function terminalSlot(tab: TerminalTabData): CanvasTerminalSlotInput {
  return {
    tab,
    projectPath: tab.repoPath,
    descriptor: {
      id: tab.terminalId,
      driverId: "semantic-terminal" as TerminalHostDescriptor["driverId"],
      lifecycle: "running",
      columns: 80,
      rows: 24,
      label: tab.label,
      projectPath: tab.repoPath,
    },
  };
}

function input(overrides: Partial<CanvasModelInput> = {}): CanvasModelInput {
  return {
    repos: [{ path: "/repo", name: "repo", group: null }],
    groups: [],
    sidebarVisible: true,
    tabDropProjectPath: null,
    activeProjectPath: "/repo",
    activeTabId: null,
    tabs: [],
    activeTab: null,
    activeGlobalSurfaceId: null,
    activePanelId: null,
    activeProject: { id: "/repo", name: "repo", path: "/repo" },
    panels: [],
    globalNavigation: [],
    terminalSlots: [],
    trailingLayoutVisible: false,
    ...overrides,
  };
}

const actions = {
  selectRepo: async () => true,
  addProject: async () => undefined,
  removeProject: () => undefined,
  newModuleSession: () => undefined,
  openInEditor: () => undefined,
  selectTab: () => undefined,
  selectProjectTab: () => undefined,
  closeTab: () => undefined,
  moveTab: () => undefined,
  newDefaultTerminal: () => undefined,
  newTerminal: () => undefined,
  openPanel: () => undefined,
  renameTab: () => undefined,
  reorderTab: () => undefined,
  renameGroup: () => undefined,
  deleteGroup: () => undefined,
  moveToGroup: async () => undefined,
  setTabDropProjectPath: () => undefined,
  toggleGlobalSurface: () => undefined,
  closeGlobalSurface: () => undefined,
  setTabTitle: () => undefined,
} as CanvasActions;

function render(model: ReturnType<CanvasModelModule["createCanvasModel"]>) {
  const requested: string[] = [];
  const viewPorts: Partial<CanvasViewPorts> = {
    Sidebar: ({ sidebar }) => {
      requested.push("sidebar");
      return createElement("aside", { "data-active-tab": sidebar.activeTabId ?? "none" });
    },
    TabBar: () => {
      requested.push("tab-bar");
      return createElement("nav", null);
    },
    GlobalSurface: ({ surfaceId }) => {
      requested.push(`global:${surfaceId}`);
      return createElement("section", { "data-global": surfaceId });
    },
    Panel: ({ content }) => {
      requested.push(`panel:${content.panelId}`);
      return createElement("section", { "data-panel": content.panelId });
    },
    Terminal: ({ slot }) => {
      requested.push(`terminal:${slot.terminalId}:${String(slot.visible)}`);
      return createElement("output", {
        "data-terminal": slot.terminalId,
        "data-visible": String(slot.visible),
      });
    },
    TrailingLayout: ({ project }) => {
      requested.push(`trailing:${project.path}`);
      return createElement("aside", { "data-trailing": project.path });
    },
  };
  const html = renderToStaticMarkup(createElement(LegacyCanvas, {
    model,
    actions,
    ports: {} as CanvasPorts,
    viewPorts,
  }));
  return { html, requested };
}

test("renders every terminal once in model order and passes only one visible request", () => {
  const a = terminalTab("terminal:a", "a");
  const b = terminalTab("terminal:b", "b");
  const c = terminalTab("terminal:c", "c");
  const { html, requested } = render(createCanvasModel(input({
    activeTabId: b.id,
    tabs: [c, b, a],
    activeTab: b,
    terminalSlots: [terminalSlot(c), terminalSlot(b), terminalSlot(a)],
  })));

  assert.deepEqual(requested.filter((entry) => entry.startsWith("terminal:")), [
    "terminal:a:false",
    "terminal:b:true",
    "terminal:c:false",
  ]);
  assert(html.indexOf('data-terminal="a"') < html.indexOf('data-terminal="b"'));
  assert(html.indexOf('data-terminal="b"') < html.indexOf('data-terminal="c"'));
});

test("global, panel, and empty models select only their matching content renderers", () => {
  const global = render(createCanvasModel(input({
    activeGlobalSurfaceId: "usage.dashboard" as ContributionId,
  })));
  assert.deepEqual(global.requested.filter((entry) => /^(global|panel):/.test(entry)), [
    "global:usage.dashboard",
  ]);

  const panel: UnifiedTab = {
    id: "panel-usage.dashboard",
    kind: "panel",
    panelId: "usage.dashboard",
    label: "Usage",
  };
  const selectedPanel = render(createCanvasModel(input({
    activeTabId: panel.id,
    tabs: [panel],
    activeTab: panel,
    activePanelId: "usage.dashboard" as ContributionId,
  })));
  assert.deepEqual(selectedPanel.requested.filter((entry) => /^(global|panel):/.test(entry)), [
    "panel:usage.dashboard",
  ]);

  const empty = render(createCanvasModel(input()));
  assert.match(empty.html, /Open a session or terminal/);
  assert.deepEqual(empty.requested.filter((entry) => /^(global|panel):/.test(entry)), []);
});

test("a missing project never calls the trailing layout renderer", () => {
  const { requested } = render(createCanvasModel(input({
    activeProjectPath: null,
    activeProject: null,
    trailingLayoutVisible: true,
  })));

  assert.equal(requested.some((entry) => entry.startsWith("trailing:")), false);
});

test("legacy canvas renders an active semantic global view, closes it, and does not flatten a split", () => {
  const alpha = terminalTab("terminal:alpha", "alpha");
  const requested: string[] = [];
  const executed: WorkspaceCanvasAction[] = [];
  let close: (() => void) | undefined;
  const document: UiWorkspaceDocument = {
    schemaVersion: 1,
    workspaceId: "fixture.workspace",
    profileId: "fixture.profile",
    instances: [
      {
        instanceId: "shipctl.canvas.compatibility",
        viewTypeId: "shipctl.legacy-canvas",
        ownerModuleId: "shipctl.host",
        ownerActivationId: "shipctl.host@1#compatibility",
        resource: { kind: "global" },
        label: "Shipctl",
        stateRef: null,
        availability: { kind: "available" },
        lifecycle: "placed",
      },
      {
        instanceId: "fixture.global",
        viewTypeId: "fixture.global-surface",
        ownerModuleId: "shipctl.fixture",
        ownerActivationId: "shipctl.fixture@1#canvas",
        resource: { kind: "global" },
        label: "Fixture surface",
        stateRef: null,
        availability: { kind: "available" },
        lifecycle: "placed",
      },
    ],
    root: {
      kind: "stack",
      stackId: "fixture.primary",
      instanceIds: ["shipctl.canvas.compatibility", "fixture.global"],
      selectedInstanceId: "fixture.global",
    },
    floating: [],
    maximizedStackId: null,
  };
  const projection: WorkspaceCanvasProjection = {
    workspaceId: document.workspaceId,
    revision: 2 as WorkspaceRevision,
    catalogRevision: 3,
    document,
    views: [
      {
        instance: document.instances[0]!,
        definition: null,
        title: "Shipctl",
        closeable: false,
        splitAllowed: false,
      },
      {
        instance: document.instances[1]!,
        definition: null,
        title: "Fixture surface",
        closeable: true,
        splitAllowed: true,
      },
    ],
  };
  const workspace: WorkspaceCanvas = {
    projection,
    execute: async (action) => {
      executed.push(action);
      return {} as WorkspaceMutationResult;
    },
  };
  const viewPorts: Partial<CanvasViewPorts> = {
    Sidebar: ({ sidebar }) => {
      requested.push(`sidebar:${sidebar.activeGlobalSurfaceId ?? "none"}`);
      return createElement("aside");
    },
    TabBar: ({ globalSurfaceOpen }) => {
      requested.push(`tab-bar:${String(globalSurfaceOpen)}`);
      return createElement("nav");
    },
    GlobalSurface: ({ surfaceId, close: closeView }) => {
      requested.push(`global:${surfaceId}`);
      close = closeView;
      return createElement("section", { "data-global": surfaceId });
    },
    Terminal: ({ slot }) => {
      requested.push(`terminal:${slot.terminalId}:${String(slot.visible)}`);
      return createElement("output");
    },
  };

  renderToStaticMarkup(createElement(LegacyCanvas, {
    model: createCanvasModel(input({
      activeTabId: alpha.id,
      tabs: [alpha],
      activeTab: alpha,
      terminalSlots: [terminalSlot(alpha)],
    })),
    actions,
    ports: {
      surfaceCatalog: {
        globalSurface: (surfaceId: ContributionId) => (
          surfaceId === "fixture.global-surface" ? { id: surfaceId } : undefined
        ),
        panel: () => undefined,
      },
    } as CanvasPorts,
    viewPorts,
    workspace,
  }));

  assert.deepEqual(requested, [
    "sidebar:fixture.global-surface",
    "tab-bar:true",
    "global:fixture.global-surface",
    "terminal:alpha:false",
  ]);
  close?.();
  assert.deepEqual(executed, [{ kind: "close", instanceId: "fixture.global" }]);

  const splitDocument: UiWorkspaceDocument = {
    ...document,
    root: {
      kind: "split",
      nodeId: "fixture.split",
      axis: "horizontal",
      firstShare: 0.5,
      first: {
        kind: "stack",
        stackId: "fixture.left",
        instanceIds: ["shipctl.canvas.compatibility"],
        selectedInstanceId: "shipctl.canvas.compatibility",
      },
      second: {
        kind: "stack",
        stackId: "fixture.right",
        instanceIds: ["fixture.global"],
        selectedInstanceId: "fixture.global",
      },
    },
  };
  requested.length = 0;
  const splitMarkup = renderToStaticMarkup(createElement(LegacyCanvas, {
    model: createCanvasModel(input({
      activeTabId: alpha.id,
      tabs: [alpha],
      activeTab: alpha,
      terminalSlots: [terminalSlot(alpha)],
    })),
    actions,
    ports: {
      surfaceCatalog: {
        globalSurface: () => undefined,
        panel: () => undefined,
      },
    } as CanvasPorts,
    viewPorts,
    workspace: {
      ...workspace,
      projection: { ...projection, document: splitDocument },
    },
  }));

  assert.match(splitMarkup, /Workspace layout unavailable/);
  assert.deepEqual(requested, [
    "sidebar:none",
    "tab-bar:true",
    "terminal:alpha:false",
  ]);
});

test("the shell reaches the canvas host instead of concrete canvas renderers", async () => {
  const source = await readFile("core/frontend/shell/AppShell.tsx", "utf8");

  assert.match(source, /from "@shipctl\/core\/canvas\/views"/);
  assert.doesNotMatch(source, /from "\.\/Sidebar\.tsx"/);
  assert.doesNotMatch(source, /from "\.\/TabBar\.tsx"/);
  assert.match(source, /AcceptedWorkspaceContributionRuntimeProvider[\s\S]*from "\.\.\/host\/views\.ts"/);
  assert.doesNotMatch(source, /Terminal(?:ErrorBoundary|Slot).*from "\.\.\/terminal-host\/views\.ts"/);
});
