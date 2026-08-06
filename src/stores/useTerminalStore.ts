import { create } from "zustand";
import type {
  TerminalTabData,
  TabActivity,
  UnifiedTab,
  PanelTabKind,
  PanelTabData,
  TabCycleDirection,
} from "../lib/types";
import { panelTabId, panelTabDefaults } from "../lib/types";
import { contributedPanelTabId } from "../lib/types";
import { useUIStore } from "./useUIStore";

interface ProjectTerminalState {
  tabs: UnifiedTab[];
  activeTabId: string | null;
}

type TerminalTabPatch = Partial<Pick<
  TerminalTabData,
  "label" | "providerSessionId" | "captureState"
>>;

interface TerminalStore {
  projectState: Record<string, ProjectTerminalState>;
  activeProjectPath: string | null;
  tabActivity: Record<number, TabActivity>;
  switchProject: (repoPath: string) => void;
  removeProject: (repoPath: string) => void;
  addTab: (tab: UnifiedTab) => void;
  addTabToProject: (repoPath: string, tab: UnifiedTab) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  cycleTab: (direction: TabCycleDirection) => void;
  updateTab: (id: string, patch: Partial<Pick<UnifiedTab, "label">>) => void;
  updateTerminalTabById: (id: string, patch: TerminalTabPatch) => void;
  reorderTab: (tabId: string, toIndex: number) => void;
  moveTab: (tabId: string, destinationPath: string) => boolean;
  removeTabFromProject: (repoPath: string, id: string) => void;
  addPanelTab: (kind: PanelTabKind) => void;
  addContributedPanelTab: (panelId: `${string}.${string}`, label: string) => void;
  removePanelTab: (kind: PanelTabKind) => void;
  togglePanelTab: (kind: PanelTabKind) => void;
  findTabByCommand: (commandName: string) => TerminalTabData | undefined;
  findTabByCommandForProject: (repoPath: string, commandName: string) => TerminalTabData | undefined;
  findTabByPtyId: (ptyId: number) => TerminalTabData | undefined;
  initActivity: (ptyId: number) => void;
  setTabActive: (ptyId: number, active: boolean) => void;
  setTabExited: (ptyId: number, exitCode: number) => void;
  setTabBell: (ptyId: number, message?: string) => void;
  clearTabBell: (ptyId: number) => void;
  removeActivity: (ptyId: number) => void;
  getAllProjectTabs: (repoPath: string) => UnifiedTab[];
}

function emptyState(): ProjectTerminalState {
  return { tabs: [], activeTabId: null };
}

let tabCounter = 0;
export function nextTabId(): string {
  return `tab-${++tabCounter}`;
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  projectState: {},
  activeProjectPath: null,
  tabActivity: {},

  switchProject: (repoPath: string) => {
    set((state) => {
      if (state.projectState[repoPath]) {
        return { activeProjectPath: repoPath };
      }
      return {
        projectState: { ...state.projectState, [repoPath]: emptyState() },
        activeProjectPath: repoPath,
      };
    });
  },

  removeProject: (repoPath: string) => {
    set((state) => {
      const projectState = { ...state.projectState };
      const project = projectState[repoPath];
      delete projectState[repoPath];

      const tabActivity = { ...state.tabActivity };
      if (project) {
        for (const tab of project.tabs) {
          if (tab.kind === "terminal" || tab.kind === "assistant") {
            delete tabActivity[tab.ptyId];
          }
        }
      }

      return {
        projectState,
        tabActivity,
        ...(state.activeProjectPath === repoPath
          ? { activeProjectPath: null }
          : {}),
      };
    });
  },

  addTab: (tab: UnifiedTab) => {
    set((state) => {
      const path = state.activeProjectPath;
      if (!path) return state;
      const ps = state.projectState[path] ?? emptyState();
      return {
        projectState: {
          ...state.projectState,
          [path]: {
            tabs: [...ps.tabs, tab],
            activeTabId: tab.id,
          },
        },
      };
    });
  },

  addTabToProject: (repoPath: string, tab: UnifiedTab) => {
    set((state) => {
      const ps = state.projectState[repoPath] ?? emptyState();
      if (ps.tabs.some((existing) => existing.id === tab.id)) return state;
      return {
        projectState: {
          ...state.projectState,
          [repoPath]: {
            tabs: [...ps.tabs, tab],
            activeTabId: tab.id,
          },
        },
      };
    });
  },

  removeTab: (id: string) => {
    set((state) => {
      const path = state.activeProjectPath;
      if (!path) return state;
      const ps = state.projectState[path];
      if (!ps) return state;
      const closedIndex = ps.tabs.findIndex((t) => t.id === id);
      if (closedIndex === -1) return state;
      const tabs = ps.tabs.filter((t) => t.id !== id);
      let activeTabId = ps.activeTabId;
      if (ps.activeTabId === id) {
        if (tabs.length === 0) {
          activeTabId = null;
        } else {
          activeTabId = tabs[Math.min(closedIndex, tabs.length - 1)].id;
        }
      }
      return {
        projectState: {
          ...state.projectState,
          [path]: { tabs, activeTabId },
        },
      };
    });
  },

  setActiveTab: (id: string) => {
    set((state) => {
      const path = state.activeProjectPath;
      if (!path) return state;
      const ps = state.projectState[path];
      if (!ps || !ps.tabs.some((t) => t.id === id)) return state;
      return {
        projectState: {
          ...state.projectState,
          [path]: { ...ps, activeTabId: id },
        },
      };
    });
  },

  cycleTab: (direction: TabCycleDirection) => {
    useUIStore.getState().deactivateAllOverlays();
    set((state) => {
      const path = state.activeProjectPath;
      if (!path) return state;
      const project = state.projectState[path];
      if (!project || project.tabs.length === 0) return state;

      const currentIndex = project.tabs.findIndex((tab) => tab.id === project.activeTabId);
      const startIndex = currentIndex === -1 ? 0 : currentIndex;
      const nextIndex = (startIndex + direction + project.tabs.length) % project.tabs.length;
      const nextTab = project.tabs[nextIndex];

      return {
        projectState: {
          ...state.projectState,
          [path]: { ...project, activeTabId: nextTab.id },
        },
      };
    });

    const state = get();
    const path = state.activeProjectPath;
    const project = path ? state.projectState[path] : null;
    const tab = project?.tabs.find((entry) => entry.id === project.activeTabId);
    if (tab && (tab.kind === "terminal" || tab.kind === "assistant")) {
      state.clearTabBell(tab.ptyId);
    }
  },

  updateTab: (id: string, patch: Partial<Pick<UnifiedTab, "label">>) => {
    set((state) => {
      const path = Object.entries(state.projectState).find(([, project]) =>
        project.tabs.some((tab) => tab.id === id),
      )?.[0];
      if (!path) return state;
      const ps = state.projectState[path];
      return {
        projectState: {
          ...state.projectState,
          [path]: {
            ...ps,
            tabs: ps.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
          },
        },
      };
    });
  },

  updateTerminalTabById: (id: string, patch: TerminalTabPatch) => {
    set((state) => {
      const path = Object.entries(state.projectState).find(([, project]) =>
        project.tabs.some((tab) => tab.id === id),
      )?.[0];
      if (!path) return state;
      const project = state.projectState[path];
      return {
        projectState: {
          ...state.projectState,
          [path]: {
            ...project,
            tabs: project.tabs.map((tab) => (
              (tab.kind === "terminal" || tab.kind === "assistant") && tab.id === id
                ? { ...tab, ...patch }
                : tab
            )),
          },
        },
      };
    });
  },

  reorderTab: (tabId: string, toIndex: number) => {
    set((state) => {
      const path = state.activeProjectPath;
      if (!path) return state;
      const ps = state.projectState[path];
      if (!ps) return state;
      const fromIndex = ps.tabs.findIndex((t) => t.id === tabId);
      if (fromIndex === -1) return state;

      const boundedIndex = Math.max(0, Math.min(toIndex, ps.tabs.length));
      const targetIndex = boundedIndex > fromIndex ? boundedIndex - 1 : boundedIndex;
      if (fromIndex === targetIndex) return state;

      const tabs = [...ps.tabs];
      const [moved] = tabs.splice(fromIndex, 1);
      tabs.splice(targetIndex, 0, moved);
      return {
        projectState: {
          ...state.projectState,
          [path]: { ...ps, tabs },
        },
      };
    });
  },

  moveTab: (tabId: string, destinationPath: string) => {
    const current = get();
    const sourceEntry = Object.entries(current.projectState).find(([, project]) =>
      project.tabs.some((tab) => tab.id === tabId),
    );
    if (!sourceEntry || sourceEntry[0] === destinationPath) return false;

    const [sourcePath, sourceProject] = sourceEntry;
    const tab = sourceProject.tabs.find((entry) => entry.id === tabId);
    if (!tab || (tab.kind !== "terminal" && tab.kind !== "assistant")) return false;

    set((state) => {
      const source = state.projectState[sourcePath];
      if (!source || !source.tabs.some((entry) => entry.id === tabId)) return state;
      const destination = state.projectState[destinationPath] ?? emptyState();
      const sourceTabs = source.tabs.filter((entry) => entry.id !== tabId);
      const sourceActiveTabId = source.activeTabId === tabId
        ? (sourceTabs[Math.min(source.tabs.indexOf(tab), sourceTabs.length - 1)]?.id ?? null)
        : source.activeTabId;

      return {
        projectState: {
          ...state.projectState,
          [sourcePath]: { tabs: sourceTabs, activeTabId: sourceActiveTabId },
          [destinationPath]: {
            tabs: [...destination.tabs, tab],
            activeTabId: tab.id,
          },
        },
      };
    });
    return true;
  },

  removeTabFromProject: (repoPath: string, id: string) => {
    set((state) => {
      const project = state.projectState[repoPath];
      if (!project) return state;
      const closedIndex = project.tabs.findIndex((tab) => tab.id === id);
      if (closedIndex === -1) return state;
      const tabs = project.tabs.filter((tab) => tab.id !== id);
      const activeTabId = project.activeTabId === id
        ? (tabs[Math.min(closedIndex, tabs.length - 1)]?.id ?? null)
        : project.activeTabId;
      return {
        projectState: {
          ...state.projectState,
          [repoPath]: { tabs, activeTabId },
        },
      };
    });
  },

  addPanelTab: (kind: PanelTabKind) => {
    useUIStore.getState().deactivateAllOverlays();
    set((state) => {
      const path = state.activeProjectPath;
      if (!path) return state;
      const ps = state.projectState[path] ?? emptyState();
      const id = panelTabId(kind);
      const existing = ps.tabs.find((t) => t.id === id);
      if (existing) {
        return {
          projectState: {
            ...state.projectState,
            [path]: { ...ps, activeTabId: id },
          },
        };
      }
      const tab: PanelTabData = { id, kind, label: panelTabDefaults[kind].label };
      return {
        projectState: {
          ...state.projectState,
          [path]: { tabs: [...ps.tabs, tab], activeTabId: id },
        },
      };
    });
  },

  addContributedPanelTab: (panelId: `${string}.${string}`, label: string) => {
    useUIStore.getState().deactivateAllOverlays();
    set((state) => {
      const path = state.activeProjectPath;
      if (!path) return state;
      const project = state.projectState[path] ?? emptyState();
      const id = contributedPanelTabId(panelId);
      const existing = project.tabs.find((tab) => tab.id === id);
      if (existing) {
        return {
          projectState: {
            ...state.projectState,
            [path]: { ...project, activeTabId: id },
          },
        };
      }
      const tab: PanelTabData = { id, kind: "panel", panelId, label };
      return {
        projectState: {
          ...state.projectState,
          [path]: { tabs: [...project.tabs, tab], activeTabId: id },
        },
      };
    });
  },

  removePanelTab: (kind: PanelTabKind) => {
    get().removeTab(panelTabId(kind));
  },

  togglePanelTab: (kind: PanelTabKind) => {
    const state = get();
    const path = state.activeProjectPath;
    if (!path) return;
    const ps = state.projectState[path];
    const id = panelTabId(kind);
    const existing = ps?.tabs.find((t) => t.id === id);
    if (existing && ps?.activeTabId === id) {
      get().removeTab(id);
    } else if (existing) {
      useUIStore.getState().deactivateAllOverlays();
      set((s) => {
        const p = s.projectState[path];
        if (!p) return s;
        return {
          projectState: { ...s.projectState, [path]: { ...p, activeTabId: id } },
        };
      });
    } else {
      get().addPanelTab(kind);
    }
  },

  findTabByCommand: (commandName: string) => {
    const state = get();
    if (!state.activeProjectPath) return undefined;
    return state.findTabByCommandForProject(state.activeProjectPath, commandName);
  },

  findTabByPtyId: (ptyId: number) => {
    for (const project of Object.values(get().projectState)) {
      const tab = project.tabs.find(
        (t): t is TerminalTabData =>
          (t.kind === "terminal" || t.kind === "assistant") && t.ptyId === ptyId,
      );
      if (tab) return tab;
    }
    return undefined;
  },

  initActivity: (ptyId: number) => {
    set((state) => ({
      tabActivity: {
        ...state.tabActivity,
        [ptyId]: {
          alive: true,
          active: true,
          exitCode: null,
          bell: false,
          lastOutputAt: Date.now(),
          lastAttentionAt: null,
          lastNotificationMessage: null,
        },
      },
    }));
  },

  setTabActive: (ptyId: number, active: boolean) => {
    set((state) => {
      const prev = state.tabActivity[ptyId];
      if (!prev || prev.active === active) return state;
      return {
        tabActivity: {
          ...state.tabActivity,
          [ptyId]: {
            ...prev,
            active,
            lastOutputAt: active ? Date.now() : prev.lastOutputAt,
          },
        },
      };
    });
  },

  setTabExited: (ptyId: number, exitCode: number) => {
    set((state) => {
      const prev = state.tabActivity[ptyId];
      if (!prev) return state;
      return { tabActivity: { ...state.tabActivity, [ptyId]: { ...prev, alive: false, exitCode } } };
    });
  },

  setTabBell: (ptyId: number, message?: string) => {
    set((state) => {
      const prev = state.tabActivity[ptyId];
      if (!prev) return state;
      return {
        tabActivity: {
          ...state.tabActivity,
          [ptyId]: {
            ...prev,
            bell: true,
            lastAttentionAt: Date.now(),
            lastNotificationMessage: message?.trim() || prev.lastNotificationMessage,
          },
        },
      };
    });
  },

  clearTabBell: (ptyId: number) => {
    set((state) => {
      const prev = state.tabActivity[ptyId];
      if (!prev) return state;
      return { tabActivity: { ...state.tabActivity, [ptyId]: { ...prev, bell: false } } };
    });
  },

  removeActivity: (ptyId: number) => {
    set((state) => {
      const { [ptyId]: _, ...rest } = state.tabActivity;
      return { tabActivity: rest };
    });
  },

  getAllProjectTabs: (repoPath: string) => {
    const ps = get().projectState[repoPath];
    return ps?.tabs ?? [];
  },

  findTabByCommandForProject: (repoPath: string, commandName: string) => {
    for (const project of Object.values(get().projectState)) {
      const tab = project.tabs.find(
        (entry): entry is TerminalTabData =>
          (entry.kind === "terminal" || entry.kind === "assistant") &&
          entry.repoPath === repoPath &&
          entry.commandName === commandName,
      );
      if (tab) return tab;
    }
    return undefined;
  },
}));
