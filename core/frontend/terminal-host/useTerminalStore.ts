import { create } from "zustand";
import type {
  TerminalTabData,
  TabActivity,
  UnifiedTab,
  PanelTabData,
  TabCycleDirection,
} from "@shipctl/core/platform";
import { contributedPanelTabId } from "@shipctl/core/platform";
import { useUIStore } from "@shipctl/core/shared";
import type { TerminalDescriptor, TerminalId } from "./types.ts";
import {
  reconcileTerminalProjection,
  removeTerminalProjection,
  upsertTerminalProjection,
} from "./terminalProjection.ts";
import { tabActivityFromDescriptor } from "./terminalAgentActivity.ts";

interface ProjectTerminalState {
  tabs: UnifiedTab[];
  activeTabId: string | null;
}

type TerminalTabPatch = Partial<Pick<
  TerminalTabData,
  "label" | "moduleSessionId" | "modulePresentation"
>>;

interface TerminalStore {
  projectState: Record<string, ProjectTerminalState>;
  tabActivity: Record<TerminalId, TabActivity>;
  reconciliationReady: boolean;
  reconcileTerminalDescriptors: (descriptors: readonly TerminalDescriptor[]) => void;
  upsertTerminalDescriptor: (descriptor: TerminalDescriptor) => void;
  removeTerminalDescriptor: (terminalId: TerminalId) => void;
  removeProject: (repoPath: string) => void;
  addTabToProject: (repoPath: string, tab: UnifiedTab) => void;
  removeTab: (repoPath: string, id: string) => void;
  setActiveTab: (repoPath: string, id: string) => void;
  cycleTab: (repoPath: string, direction: TabCycleDirection) => void;
  updateTab: (id: string, patch: Partial<Pick<UnifiedTab, "label">>) => void;
  updateTerminalTabById: (id: string, patch: TerminalTabPatch) => void;
  reorderTab: (repoPath: string, tabId: string, toIndex: number) => void;
  moveTab: (tabId: string, destinationPath: string) => boolean;
  removeTabFromProject: (repoPath: string, id: string) => void;
  addContributedPanelTab: (repoPath: string, panelId: `${string}.${string}`, label: string) => void;
  findTabByCommandForProject: (repoPath: string, commandName: string) => TerminalTabData | undefined;
  findTabByTerminalId: (terminalId: TerminalId) => TerminalTabData | undefined;
  initActivity: (terminalId: TerminalId) => void;
  setTabActive: (terminalId: TerminalId, active: boolean) => void;
  setTabExited: (terminalId: TerminalId, exitCode: number) => void;
  setTabBell: (terminalId: TerminalId, message?: string) => void;
  clearTabBell: (terminalId: TerminalId) => void;
  removeActivity: (terminalId: TerminalId) => void;
  getAllProjectTabs: (repoPath: string) => UnifiedTab[];
}

function emptyState(): ProjectTerminalState {
  return { tabs: [], activeTabId: null };
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  projectState: {},
  tabActivity: {},
  reconciliationReady: false,

  reconcileTerminalDescriptors: (descriptors) => {
    set((state) => {
      const hostIds = new Set(descriptors.map((descriptor) => descriptor.id));
      const tabActivity = Object.fromEntries(
        Object.entries(state.tabActivity).filter(([terminalId]) => hostIds.has(terminalId as TerminalId)),
      ) as Record<TerminalId, TabActivity>;
      for (const descriptor of descriptors) {
        tabActivity[descriptor.id] = tabActivityFromDescriptor(
          descriptor,
          tabActivity[descriptor.id],
        );
      }
      return {
        projectState: reconcileTerminalProjection(state.projectState, descriptors),
        tabActivity,
        reconciliationReady: true,
      };
    });
  },

  upsertTerminalDescriptor: (descriptor) => {
    set((state) => {
      const previous = state.tabActivity[descriptor.id];
      return {
        projectState: upsertTerminalProjection(state.projectState, descriptor),
        tabActivity: {
          ...state.tabActivity,
          [descriptor.id]: tabActivityFromDescriptor(descriptor, previous),
        },
      };
    });
  },

  removeTerminalDescriptor: (terminalId) => {
    set((state) => {
      const { [terminalId]: _, ...tabActivity } = state.tabActivity;
      return {
        projectState: removeTerminalProjection(state.projectState, terminalId),
        tabActivity,
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
          if (tab.kind === "terminal") {
            delete tabActivity[tab.terminalId];
          }
        }
      }

      return {
        projectState,
        tabActivity,
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

  removeTab: (repoPath: string, id: string) => {
    set((state) => {
      const ps = state.projectState[repoPath];
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
          [repoPath]: { tabs, activeTabId },
        },
      };
    });
  },

  setActiveTab: (repoPath: string, id: string) => {
    set((state) => {
      const ps = state.projectState[repoPath];
      if (!ps || !ps.tabs.some((t) => t.id === id)) return state;
      return {
        projectState: {
          ...state.projectState,
          [repoPath]: { ...ps, activeTabId: id },
        },
      };
    });
  },

  cycleTab: (repoPath: string, direction: TabCycleDirection) => {
    useUIStore.getState().closeGlobalSurface();
    set((state) => {
      const project = state.projectState[repoPath];
      if (!project || project.tabs.length === 0) return state;

      const currentIndex = project.tabs.findIndex((tab) => tab.id === project.activeTabId);
      const startIndex = currentIndex === -1 ? 0 : currentIndex;
      const nextIndex = (startIndex + direction + project.tabs.length) % project.tabs.length;
      const nextTab = project.tabs[nextIndex];

      return {
        projectState: {
          ...state.projectState,
          [repoPath]: { ...project, activeTabId: nextTab.id },
        },
      };
    });

    const state = get();
    const project = state.projectState[repoPath];
    const tab = project?.tabs.find((entry) => entry.id === project.activeTabId);
    if (tab?.kind === "terminal") {
      state.clearTabBell(tab.terminalId);
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
              tab.kind === "terminal" && tab.id === id
                ? { ...tab, ...patch }
                : tab
            )),
          },
        },
      };
    });
  },

  reorderTab: (repoPath: string, tabId: string, toIndex: number) => {
    set((state) => {
      const ps = state.projectState[repoPath];
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
          [repoPath]: { ...ps, tabs },
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
    if (!tab || tab.kind !== "terminal") return false;

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

  addContributedPanelTab: (repoPath: string, panelId: `${string}.${string}`, label: string) => {
    useUIStore.getState().closeGlobalSurface();
    set((state) => {
      const project = state.projectState[repoPath] ?? emptyState();
      const id = contributedPanelTabId(panelId);
      const existing = project.tabs.find((tab) => tab.id === id);
      if (existing) {
        return {
          projectState: {
            ...state.projectState,
            [repoPath]: { ...project, activeTabId: id },
          },
        };
      }
      const tab: PanelTabData = { id, kind: "panel", panelId, label };
      return {
        projectState: {
          ...state.projectState,
          [repoPath]: { tabs: [...project.tabs, tab], activeTabId: id },
        },
      };
    });
  },

  findTabByTerminalId: (terminalId: TerminalId) => {
    for (const project of Object.values(get().projectState)) {
      const tab = project.tabs.find(
        (t): t is TerminalTabData =>
          t.kind === "terminal" && t.terminalId === terminalId,
      );
      if (tab) return tab;
    }
    return undefined;
  },

  initActivity: (terminalId: TerminalId) => {
    set((state) => ({
      tabActivity: {
        ...state.tabActivity,
        [terminalId]: {
          alive: true,
          active: true,
          exitCode: null,
          bell: false,
          lastOutputAt: Date.now(),
          lastAttentionAt: null,
          lastNotificationMessage: null,
          agentState: null,
          agentAttention: null,
          agentRevision: null,
          agentUpdatedAt: null,
          agentSource: null,
          agentMessage: null,
        },
      },
    }));
  },

  setTabActive: (terminalId: TerminalId, active: boolean) => {
    set((state) => {
      const prev = state.tabActivity[terminalId];
      if (!prev || prev.active === active) return state;
      return {
        tabActivity: {
          ...state.tabActivity,
          [terminalId]: {
            ...prev,
            active,
            lastOutputAt: active ? Date.now() : prev.lastOutputAt,
          },
        },
      };
    });
  },

  setTabExited: (terminalId: TerminalId, exitCode: number) => {
    set((state) => {
      const prev = state.tabActivity[terminalId];
      if (!prev) return state;
      return { tabActivity: { ...state.tabActivity, [terminalId]: { ...prev, alive: false, exitCode } } };
    });
  },

  setTabBell: (terminalId: TerminalId, message?: string) => {
    set((state) => {
      const prev = state.tabActivity[terminalId];
      if (!prev) return state;
      return {
        tabActivity: {
          ...state.tabActivity,
          [terminalId]: {
            ...prev,
            bell: true,
            lastAttentionAt: Date.now(),
            lastNotificationMessage: message?.trim() || prev.lastNotificationMessage,
          },
        },
      };
    });
  },

  clearTabBell: (terminalId: TerminalId) => {
    set((state) => {
      const prev = state.tabActivity[terminalId];
      if (!prev) return state;
      return { tabActivity: { ...state.tabActivity, [terminalId]: { ...prev, bell: false } } };
    });
  },

  removeActivity: (terminalId: TerminalId) => {
    set((state) => {
      const { [terminalId]: _, ...rest } = state.tabActivity;
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
          entry.kind === "terminal" &&
          entry.repoPath === repoPath &&
          entry.commandName === commandName,
      );
      if (tab) return tab;
    }
    return undefined;
  },
}));
