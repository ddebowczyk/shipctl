import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ContributionId,
  TerminalHostDescriptor,
} from "@shipctl/module-api";
import type { TerminalId, TerminalViewId } from "@shipctl/core/terminal-host";
import type { TerminalTabData, UnifiedTab } from "@shipctl/core/platform";
import { createServer, type ViteDevServer } from "vite";

import type {
  CanvasActions,
  CanvasModelInput,
  CanvasPorts,
  CanvasTerminalSlotInput,
} from "../types.ts";
import type { CanvasViewPorts } from "../viewPorts.ts";

type CanvasModelModule = typeof import("../canvasModel.ts");
type LaymanCanvasModule = typeof import("../layman/LaymanCanvas.tsx");

let vite: ViteDevServer;
let createCanvasModel: CanvasModelModule["createCanvasModel"];
let LaymanCanvas: LaymanCanvasModule["default"];
let createLaymanCanvasController: LaymanCanvasModule["createLaymanCanvasController"];
let createLaymanCanvasState: LaymanCanvasModule["createLaymanCanvasState"];
let LAYMAN_CANVAS_TAB_ID: LaymanCanvasModule["LAYMAN_CANVAS_TAB_ID"];
let LAYMAN_CANVAS_WINDOW_ID: LaymanCanvasModule["LAYMAN_CANVAS_WINDOW_ID"];
let LAYMAN_SOURCE_REVISION: LaymanCanvasModule["LAYMAN_SOURCE_REVISION"];
const LAYMAN_GITHUB_REVISION = "8d0c41a0a52830f3072771af674d63d80215384e";

before(async () => {
  vite = await createServer({
    server: { hmr: false, middlewareMode: true },
    appType: "custom",
  });
  ({ createCanvasModel } = await vite.ssrLoadModule(
    "/core/frontend/canvas/canvasModel.ts",
  ) as CanvasModelModule);
  ({
    default: LaymanCanvas,
    createLaymanCanvasController,
    createLaymanCanvasState,
    LAYMAN_CANVAS_TAB_ID,
    LAYMAN_CANVAS_WINDOW_ID,
    LAYMAN_SOURCE_REVISION,
  } = await vite.ssrLoadModule(
    "/core/frontend/canvas/layman/LaymanCanvas.tsx",
  ) as LaymanCanvasModule);
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
  const controller = createLaymanCanvasController();
  const viewPorts: Partial<CanvasViewPorts> = {
    Sidebar: () => {
      requested.push("sidebar");
      return createElement("aside", { "data-fixture": "sidebar" });
    },
    TabBar: () => {
      requested.push("tab-bar");
      return createElement("nav", { "data-fixture": "tab-bar" });
    },
    GlobalSurface: ({ surfaceId }) => {
      requested.push(`global:${surfaceId}`);
      return createElement("section", { "data-fixture": "global" });
    },
    Panel: ({ content }) => {
      requested.push(`panel:${content.panelId}`);
      return createElement("section", { "data-fixture": "panel" });
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
      return createElement("aside", { "data-fixture": "trailing" });
    },
  };
  const html = renderToStaticMarkup(createElement(LaymanCanvas, {
    controller,
    model,
    actions,
    ports: {} as CanvasPorts,
    viewPorts,
  }));

  return { controller, html, requested };
}

test("initializes one deterministic Layman window and one legacy pane", () => {
  const state = createLaymanCanvasState();

  assert.deepEqual(state, {
    layout: {
      id: LAYMAN_CANVAS_WINDOW_ID,
      tabs: [{
        id: LAYMAN_CANVAS_TAB_ID,
        title: "Shipctl",
        data: { kind: "shipctl.legacy-canvas" },
      }],
      selectedTabId: LAYMAN_CANVAS_TAB_ID,
    },
    floatingWindows: [],
  });
});

test("renders the legacy content fixture once and preserves terminal visibility", () => {
  const alpha = terminalTab("terminal:alpha", "alpha");
  const beta = terminalTab("terminal:beta", "beta");
  const { html, requested } = render(createCanvasModel(input({
    activeTabId: beta.id,
    tabs: [beta, alpha],
    activeTab: beta,
    terminalSlots: [terminalSlot(beta), terminalSlot(alpha)],
  })));

  assert.equal((html.match(/class="app-shell__frame"/g) ?? []).length, 1);
  assert.match(html, /data-canvas-adapter="layman"/);
  assert.match(html, /data-layman-view="shipctl\.canvas"/);
  assert.deepEqual(requested.filter((entry) => entry === "sidebar"), ["sidebar"]);
  assert.deepEqual(requested.filter((entry) => entry === "tab-bar"), ["tab-bar"]);
  assert.deepEqual(requested.filter((entry) => entry.startsWith("terminal:")), [
    "terminal:alpha:false",
    "terminal:beta:true",
  ]);
});

test("a host layout command changes only Layman state, not the terminal model", () => {
  const alpha = terminalTab("terminal:alpha", "alpha");
  const model = createCanvasModel(input({
    activeTabId: alpha.id,
    tabs: [alpha],
    activeTab: alpha,
    terminalSlots: [terminalSlot(alpha)],
  }));
  const terminalSlots = model.terminalSlots;
  const controller = createLaymanCanvasController();
  const before = controller.getState();

  const transition = controller.dispatch({
    type: "window.move",
    windowId: LAYMAN_CANVAS_WINDOW_ID,
    target: {
      kind: "floating",
      position: { top: 8, left: 8, width: 640, height: 480 },
    },
    placement: "center",
  }, { origin: "host" });

  assert.equal(transition.status, "applied");
  assert.notStrictEqual(controller.getState(), before);
  assert.equal(controller.getState().layout, undefined);
  assert.equal(controller.getState().floatingWindows.length, 1);
  assert.strictEqual(model.terminalSlots, terminalSlots);
  assert.deepEqual(model.terminalSlots.map((slot) => ({
    terminalId: slot.terminalId,
    visible: slot.visible,
  })), [{ terminalId: "alpha", visible: true }]);
});

test("uses the approved React 19 Git source and keeps the adapter host-only", async () => {
  const packageManifest = JSON.parse(await readFile("core/frontend/package.json", "utf8")) as {
    dependencies: Record<string, string>;
  };
  const dependency = packageManifest.dependencies["react-layman"];
  assert.equal(
    dependency,
    `github:ddebowczyk/react-layman#${LAYMAN_GITHUB_REVISION}`,
  );

  const lockfile = await readFile("pnpm-lock.yaml", "utf8");
  assert.match(
    lockfile,
    new RegExp(
      `(?:https://codeload\\.github\\.com/ddebowczyk/react-layman/tar\\.gz/|git\\+https://github\\.com/ddebowczyk/react-layman\\.git#)${LAYMAN_GITHUB_REVISION}`,
    ),
  );
  assert.equal(LAYMAN_SOURCE_REVISION, LAYMAN_GITHUB_REVISION);

  const source = await readFile("core/frontend/canvas/layman/LaymanCanvas.tsx", "utf8");
  assert.match(source, /from "react-layman"/);
  assert.match(source, /new ResizeObserver\(/);
  assert.doesNotMatch(source, /@tauri-apps|invoke\(|localStorage|sessionStorage/);
  assert.doesNotMatch(source, /from ["'][^"']*modules\//);

  const canvasHostSource = await readFile("core/frontend/canvas/CanvasHost.tsx", "utf8");
  assert.doesNotMatch(canvasHostSource, /LaymanCanvas/);
});

test("the legacy pane still selects global, panel, and empty content through ports", () => {
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
