import type {
  CanvasContentTarget,
  CanvasModel,
  CanvasModelInput,
  CanvasTerminalSlot,
} from "./types.ts";

function contentTarget(input: CanvasModelInput): CanvasContentTarget {
  if (input.activeGlobalSurfaceId !== null) {
    return { kind: "global-surface", surfaceId: input.activeGlobalSurfaceId };
  }

  if (input.activeTab && input.activePanelId) {
    return {
      kind: "panel",
      panelId: input.activePanelId,
      instanceId: input.activeTab.id,
      project: input.activeProject,
    };
  }

  if (input.activeTab === null && input.tabs.length === 0) {
    return {
      kind: "empty",
      message: input.activeProjectPath
        ? "Open a session or terminal"
        : "Select or add a project to begin",
    };
  }

  return { kind: "none" };
}

function terminalSlots(input: CanvasModelInput): readonly CanvasTerminalSlot[] {
  const globalSurfaceOpen = input.activeGlobalSurfaceId !== null;

  return [...input.terminalSlots]
    .sort((left, right) =>
      left.tab.terminalId.localeCompare(right.tab.terminalId)
        || left.tab.id.localeCompare(right.tab.id))
    .map(({ tab, projectPath, descriptor }) => ({
      key: tab.id,
      tabId: tab.id,
      terminalId: tab.terminalId,
      projectPath,
      descriptor,
      visible: !globalSurfaceOpen
        && projectPath === input.activeProjectPath
        && tab.id === input.activeTabId,
    }));
}

/**
 * Converts shell-owned state into renderer facts. It has no browser or React
 * dependency so both adapters and tests share the same presentation contract.
 */
export function createCanvasModel(input: CanvasModelInput): CanvasModel {
  const globalSurfaceOpen = input.activeGlobalSurfaceId !== null;

  return {
    sidebar: {
      visible: input.sidebarVisible,
      repos: input.repos,
      groups: input.groups,
      activeProjectPath: input.activeProjectPath,
      tabDropProjectPath: input.tabDropProjectPath,
      activeTabId: globalSurfaceOpen ? null : input.activeTabId,
      activeGlobalSurfaceId: input.activeGlobalSurfaceId,
      globalNavigation: input.globalNavigation,
    },
    tabBar: {
      panels: input.panels,
    },
    content: contentTarget(input),
    terminalSlots: terminalSlots(input),
    trailingLayout: {
      visible: input.trailingLayoutVisible && input.activeProject !== null,
      project: input.activeProject,
    },
  };
}
