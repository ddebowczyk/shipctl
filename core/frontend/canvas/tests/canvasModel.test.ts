import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type {
  ContributionId,
  PanelContribution,
  TerminalHostDescriptor,
} from "@shipctl/module-api";
import type { TerminalId, TerminalViewId } from "@shipctl/core/terminal-host";
import type { TerminalTabData, UnifiedTab } from "@shipctl/core/platform";
import { createServer, type ViteDevServer } from "vite";

import type {
  CanvasModelInput,
  CanvasTerminalSlotInput,
} from "../types.ts";

type CanvasModelModule = typeof import("../canvasModel.ts");

let vite: ViteDevServer;
let createCanvasModel: CanvasModelModule["createCanvasModel"];

before(async () => {
  vite = await createServer({
    server: { hmr: false, middlewareMode: true },
    appType: "custom",
  });
  ({ createCanvasModel } = await vite.ssrLoadModule(
    "/core/frontend/canvas/canvasModel.ts",
  ) as CanvasModelModule);
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

function terminalSlot(tab: TerminalTabData, projectPath = tab.repoPath): CanvasTerminalSlotInput {
  return {
    tab,
    projectPath,
    descriptor: {
      id: tab.terminalId,
      driverId: "semantic-terminal" as TerminalHostDescriptor["driverId"],
      lifecycle: "running",
      columns: 80,
      rows: 24,
      label: tab.label,
      projectPath,
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

test("global surface is the one selected content target and hides terminal presentations", () => {
  const tab = terminalTab("terminal:one", "one");
  const model = createCanvasModel(input({
    activeTabId: tab.id,
    tabs: [tab],
    activeTab: tab,
    activeGlobalSurfaceId: "usage.dashboard" as ContributionId,
    terminalSlots: [terminalSlot(tab)],
  }));

  assert.deepEqual(model.content, {
    kind: "global-surface",
    surfaceId: "usage.dashboard",
  });
  assert.equal(model.sidebar.activeTabId, null);
  assert.deepEqual(model.terminalSlots.map(({ visible }) => visible), [false]);
});

test("a selected project panel wins the content slot and retains every terminal", () => {
  const terminal = terminalTab("terminal:one", "one");
  const panel: UnifiedTab = {
    id: "panel-usage.dashboard",
    kind: "panel",
    panelId: "usage.dashboard",
    label: "Usage",
  };
  const model = createCanvasModel(input({
    activeTabId: panel.id,
    tabs: [terminal, panel],
    activeTab: panel,
    activePanelId: "usage.dashboard" as ContributionId,
    terminalSlots: [terminalSlot(terminal)],
  }));

  assert.deepEqual(model.content, {
    kind: "panel",
    panelId: "usage.dashboard",
    instanceId: panel.id,
    project: { id: "/repo", name: "repo", path: "/repo" },
  });
  assert.equal(model.terminalSlots.length, 1);
  assert.equal(model.terminalSlots[0]?.visible, false);
});

test("an empty project and no selected project produce the current empty messages", () => {
  assert.deepEqual(createCanvasModel(input()).content, {
    kind: "empty",
    message: "Open a session or terminal",
  });
  assert.deepEqual(createCanvasModel(input({
    activeProjectPath: null,
    activeProject: null,
  })).content, {
    kind: "empty",
    message: "Select or add a project to begin",
  });
});

test("terminal DOM order is stable and only the selected terminal is visible", () => {
  const a = terminalTab("terminal:a", "a");
  const b = terminalTab("terminal:b", "b");
  const c = terminalTab("terminal:c", "c", "/other");
  const model = createCanvasModel(input({
    activeTabId: b.id,
    tabs: [c, b, a],
    activeTab: b,
    terminalSlots: [terminalSlot(c), terminalSlot(b), terminalSlot(a)],
  }));

  assert.deepEqual(model.terminalSlots.map(({ terminalId }) => terminalId), ["a", "b", "c"]);
  assert.deepEqual(model.terminalSlots.map(({ visible }) => visible), [false, true, false]);
});

test("trailing project layout needs both its visibility flag and a project", () => {
  assert.deepEqual(createCanvasModel(input({
    trailingLayoutVisible: true,
  })).trailingLayout, {
    visible: true,
    project: { id: "/repo", name: "repo", path: "/repo" },
  });
  assert.deepEqual(createCanvasModel(input({
    trailingLayoutVisible: true,
    activeProjectPath: null,
    activeProject: null,
  })).trailingLayout, {
    visible: false,
    project: null,
  });
});

test("model facts need no concrete panel implementation", () => {
  const panel = {
    id: "fixture.panel",
    moduleId: "fixture",
    scope: "project",
    label: "Fixture",
    icon: { name: "list" },
    singleton: "per-project",
    load: async () => ({ default: () => null }),
  } as PanelContribution;
  const model = createCanvasModel(input({ panels: [panel] }));

  assert.equal(model.tabBar.panels[0]?.id, "fixture.panel");
});
