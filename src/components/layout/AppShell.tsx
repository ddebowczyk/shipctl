import { useEffect, useCallback, useRef, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Sidebar from "../sidebar/Sidebar";
import TabBar from "./TabBar";
import TerminalView from "../terminal/TerminalView";
import TerminalErrorBoundary from "../terminal/TerminalErrorBoundary";
import NoticeCenter from "../shared/NoticeCenter";
import { PanelLeft, PanelRight } from "lucide-react";
import { useRepoStore } from "../../stores/useRepoStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useUIStore } from "../../stores/useUIStore";
import { useShallow } from "zustand/shallow";
import { usePty } from "../../hooks/usePty";
import { useThemeApplicator } from "../../hooks/useThemeApplicator";
import { useProjectWatcher } from "../../hooks/useProjectWatcher";
import { computeTerminalSize } from "../../lib/terminalMeasure";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  getUsername,
  getComputerName,
  openInEditor,
  refreshUsageData,
  shutdownAndQuit,
} from "../../lib/tauri";
import { useEditorStore } from "../../stores/useEditorStore";
import { useTerminalSettingsStore } from "../../stores/useTerminalSettingsStore";
import { useUsageStore } from "../../stores/useUsageStore";
import { useUsageSettingsStore } from "../../stores/useUsageSettingsStore";
import { useUpdateStore } from "../../stores/useUpdateStore";
import { initNotifications } from "../../lib/notifications";
import { getErrorMessage } from "../../lib/errors";
import { useNoticeStore } from "../../stores/useNoticeStore";
import {
  BUILTIN_GLOBAL_SURFACE_IDS,
  BUILTIN_GLOBAL_SURFACE_LOADERS,
  activateModules,
  bindTerminalSessionDimensions,
  createEnabledGlobalSurfaceRegistry,
  createEnabledPanelRegistry,
  GlobalSurfaceHost,
  MODULE_HOST_SERVICES,
  ModuleProjectLayoutSurfaces,
  notifyModulesBeforeShutdown,
  notifyModulesProjectOpened,
  notifyModulesProjectRemoved,
  notifyModulesProjectsChanged,
  panelIdForTab,
  PanelHost,
} from "../../core/modules";
import { matchesPanelShortcut } from "../../core/modules/panelShortcuts";

import type { TabCycleDirection, TerminalTabData, UnifiedTab } from "../../lib/types";
const LAST_REPO_STORAGE_KEY = "shep:last-repo-path";

// Stable empty arrays to avoid infinite re-render loops with zustand v5's
// useSyncExternalStore — selectors must return the same reference for the same state.
const EMPTY_TABS: UnifiedTab[] = [];
const PANEL_REGISTRY = createEnabledPanelRegistry(null);
const MODULE_PANEL_CONTRIBUTIONS = PANEL_REGISTRY.list()
  .filter((panel) => panel.moduleId !== "core");
const GLOBAL_SURFACE_REGISTRY = createEnabledGlobalSurfaceRegistry(
  BUILTIN_GLOBAL_SURFACE_LOADERS,
);

function fallbackWorkspaceName(repoPath: string) {
  return repoPath.split("/").filter(Boolean).pop() ?? "Project";
}

export default function AppShell() {
  useThemeApplicator();

  const { repos, groups, activeRepoPath, fetchRepos, fetchGroups, openRepo, addRepo, removeRepo, renameGroup, deleteGroup, moveRepoToGroup } =
    useRepoStore();
  const pushNotice = useNoticeStore((s) => s.pushNotice);
  const {
    spawnBlankShell,
    closeTab,
    killProjectPtys,
    requestTerminalSessionPlacement,
    requestTerminalSessionRename,
  } = usePty();

  const initialProjectAttemptedRef = useRef(false);
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const [tabDropProjectPath, setTabDropProjectPath] = useState<string | null>(null);
  const lastTabCycleAtRef = useRef(0);

  const cycleTabs = useCallback((direction: TabCycleDirection) => {
    // Native menu accelerators and the renderer fallback can both receive the
    // same shortcut on some platforms. Avoid advancing twice in that case.
    const now = performance.now();
    if (now - lastTabCycleAtRef.current < 100) return;
    lastTabCycleAtRef.current = now;
    useTerminalStore.getState().cycleTab(direction);
  }, []);

  const getTerminalDimensions = useCallback(() => {
    const el = terminalContainerRef.current;
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) {
      return { cols: 80, rows: 24 };
    }
    return computeTerminalSize(el.clientWidth, el.clientHeight);
  }, []);

  useEffect(() => bindTerminalSessionDimensions(() => {
    const { cols, rows } = getTerminalDimensions();
    return { columns: cols, rows };
  }), [getTerminalDimensions]);

  // Derive active project's tabs and commands from stores
  const activeProjectPath = useTerminalStore((s) => s.activeProjectPath);
  const activeProjectTerminals = useTerminalStore(
    (s) => (s.activeProjectPath ? s.projectState[s.activeProjectPath] : null),
  );
  const tabs = activeProjectTerminals?.tabs ?? EMPTY_TABS;
  const activeTabId = activeProjectTerminals?.activeTabId ?? null;
  // Derive allTabs via useMemo instead of a selector that returns a new array
  // every call — zustand v5 + useSyncExternalStore would infinite-loop otherwise.
  const projectState = useTerminalStore((s) => s.projectState);

  const projectPaths = useMemo(
    () => repos.map((r) => r.path),
    [repos],
  );
  useProjectWatcher(projectPaths);
  // Collect only PTY-backed tabs for TerminalView rendering (panel tabs have no terminal)
  const allTerminalTabs = useMemo(() => {
    const all: Array<{ tab: TerminalTabData; projectPath: string }> = [];
    for (const [projectPath, ps] of Object.entries(projectState)) {
      for (const tab of ps.tabs) {
        if (tab.kind === "terminal" || tab.kind === "assistant") {
          all.push({ tab, projectPath });
        }
      }
    }

    // Keep terminal DOM order stable even when the visible tab order changes.
    // xterm renderers can fail to repaint cleanly when their mounted nodes are
    // shuffled around in the document during tab drag/reorder operations.
    return all.sort((a, b) => a.tab.ptyId - b.tab.ptyId || a.tab.id.localeCompare(b.tab.id));
  }, [projectState]);

  const { setActiveTab } = useTerminalStore.getState();

  const { activeGlobalSurfaceId, sidebarVisible, diffPanelVisible } = useUIStore(useShallow((s) => ({
    activeGlobalSurfaceId: s.activeGlobalSurfaceId,
    sidebarVisible: s.sidebarVisible,
    diffPanelVisible: s.diffPanelVisible,
  })));

  // Derive which kind of local tab is active (for panel content rendering)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const { loadSettings: loadEditorSettings } = useEditorStore.getState();
  const { loadSettings: loadTerminalSettings } = useTerminalSettingsStore.getState();
  const { fetchSnapshots: fetchUsageSnapshots } = useUsageStore.getState();
  const { loadSettings: loadUsageSettings } = useUsageSettingsStore.getState();

  useEffect(() => {
    const deactivate = activateModules(MODULE_HOST_SERVICES);
    return () => { void deactivate(); };
  }, []);

  useEffect(() => {
    void notifyModulesProjectsChanged(
      repos.map((repo) => repo.path),
      MODULE_HOST_SERVICES,
    );
  }, [repos]);

  useEffect(() => {
    fetchRepos();
    fetchGroups();
    void loadEditorSettings();
    void loadTerminalSettings();
    void loadUsageSettings();
    void fetchUsageSnapshots();
    const usageRefreshTimer = window.setTimeout(() => {
      void fetchUsageSnapshots();
    }, 3000);
    void refreshUsageData();
    void initNotifications();
    getUsername().then((name) => useUIStore.getState().setUsername(name));
    getComputerName().then((name) => useUIStore.getState().setComputerName(name));

    // Check for updates after startup settles
    const updateTimer = window.setTimeout(async () => {
      await useUpdateStore.getState().checkForUpdate();
      const { status, availableVersion } = useUpdateStore.getState();
      if (status === "available" && availableVersion) {
        pushNotice(
          { tone: "info", title: "Update available", message: `Version ${availableVersion} is ready to download` },
          { durationMs: 8000 },
        );
      }
    }, 3000);
    return () => {
      window.clearTimeout(updateTimer);
      window.clearTimeout(usageRefreshTimer);
    };
  }, [fetchRepos, fetchGroups, loadEditorSettings, loadTerminalSettings, loadUsageSettings, fetchUsageSnapshots, pushNotice]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshUsageData();
      void fetchUsageSnapshots();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [fetchUsageSnapshots]);

  // Auto-refresh when background ingest completes
  useEffect(() => {
    const unlisten = listen("usage-ingest-complete", () => {
      void fetchUsageSnapshots();
    });
    return () => { unlisten.then((f) => f()); };
  }, [fetchUsageSnapshots]);

  const handleSelectRepo = useCallback(
    async (repoPath: string) => {
      if (repoPath === activeRepoPath) return;

      try {
        useUIStore.getState().closeGlobalSurface();
        await openRepo(repoPath);
        initialProjectAttemptedRef.current = true;
        window.localStorage.setItem(LAST_REPO_STORAGE_KEY, repoPath);
        useTerminalStore.getState().switchProject(repoPath);
        await notifyModulesProjectOpened(repoPath, MODULE_HOST_SERVICES);
      } catch (error) {
        pushNotice({
          tone: "error",
          title: "Couldn’t open project",
          message: getErrorMessage(error),
        });
      }
    },
    [activeRepoPath, openRepo, pushNotice],
  );

  const handleMoveTab = useCallback(
    async (tabId: string, destinationPath: string) => {
      const store = useTerminalStore.getState();
      const sourceEntry = Object.entries(store.projectState).find(([, project]) =>
        project.tabs.some((entry) => entry.id === tabId),
      );
      if (!sourceEntry || sourceEntry[0] === destinationPath) return;
      const [sourcePath, sourceProject] = sourceEntry;
      const tab = sourceProject.tabs.find((entry) => entry.id === tabId);
      if (!tab || (tab.kind !== "terminal" && tab.kind !== "assistant")) return;

      await handleSelectRepo(destinationPath);
      const destinationStore = useTerminalStore.getState();
      if (destinationStore.activeProjectPath !== destinationPath) return;
      if (tab.moduleSessionId) {
        try {
          await requestTerminalSessionPlacement(tab.moduleSessionId, destinationPath);
        } catch (error) {
          pushNotice({
            tone: "error",
            title: "Couldn’t move session",
            message: getErrorMessage(error),
          });
          return;
        }
      }
      if (!destinationStore.moveTab(tabId, destinationPath)) {
        if (tab.moduleSessionId) {
          void requestTerminalSessionPlacement(tab.moduleSessionId, sourcePath).catch(() => {});
        }
        return;
      }
      destinationStore.setActiveTab(tabId);
      pushNotice({
        tone: "success",
        title: `Moved “${tab.label}”`,
        message: tab.repoPath === destinationPath
          ? "The session is now available in this project."
          : "The session keeps its original working directory.",
      });
    },
    [handleSelectRepo, pushNotice, requestTerminalSessionPlacement],
  );

  const handleRenameTab = useCallback(
    async (tabId: string, label: string) => {
      const store = useTerminalStore.getState();
      const tab = Object.values(store.projectState)
        .flatMap((project) => project.tabs)
        .find((entry) => entry.id === tabId);
      if (!tab) return;

      if ((tab.kind === "terminal" || tab.kind === "assistant") && tab.moduleSessionId) {
        try {
          await requestTerminalSessionRename(tab.moduleSessionId, label);
        } catch (error) {
          pushNotice({
            tone: "error",
            title: "Couldn’t rename session",
            message: getErrorMessage(error),
          });
          return;
        }
      }
      store.updateTab(tabId, { label });
    },
    [pushNotice, requestTerminalSessionRename],
  );

  const handleAddProject = useCallback(
    async (repoPath: string) => {
      try {
        useUIStore.getState().closeGlobalSurface();
        await addRepo(repoPath, MODULE_HOST_SERVICES);
        // addRepo sets activeRepoPath in the repo store, get the canonical path
        const canonicalPath = useRepoStore.getState().activeRepoPath;
        if (!canonicalPath) return;
        initialProjectAttemptedRef.current = true;
        window.localStorage.setItem(LAST_REPO_STORAGE_KEY, canonicalPath);
        useTerminalStore.getState().switchProject(canonicalPath);
        await notifyModulesProjectOpened(canonicalPath, MODULE_HOST_SERVICES);
      } catch (error) {
        pushNotice({
          tone: "error",
          title: "Couldn’t add project",
          message: getErrorMessage(error),
        });
      }
    },
    [addRepo, pushNotice],
  );

  const handleRemoveProject = useCallback(
    async (repoPath: string) => {
      const repoName = repoPath.split("/").filter(Boolean).pop() ?? "this project";
      const confirmed = await ask(
        `Remove "${repoName}" from Shep? The files on disk will not be deleted.`,
        { title: "Remove project", kind: "warning", okLabel: "Remove", cancelLabel: "Cancel" },
      );
      if (!confirmed) return;
      try {
        await killProjectPtys(repoPath);
        await removeRepo(repoPath);
        useTerminalStore.getState().removeProject(repoPath);
        await notifyModulesProjectRemoved(repoPath, MODULE_HOST_SERVICES);
      } catch (error) {
        pushNotice({
          tone: "error",
          title: "Couldn’t remove project",
          message: getErrorMessage(error),
        });
      }
    },
    [killProjectPtys, pushNotice, removeRepo],
  );

  const handleRenameGroup = useCallback(
    async (groupId: string, newName: string) => {
      try {
        await renameGroup(groupId, newName);
      } catch (error) {
        pushNotice({
          tone: "error",
          title: "Couldn’t rename group",
          message: getErrorMessage(error),
        });
      }
    },
    [renameGroup, pushNotice],
  );

  const handleDeleteGroup = useCallback(
    async (groupId: string) => {
      const group = groups.find((g) => g.id === groupId);
      const groupName = group?.name ?? "this group";
      const confirmed = await ask(
        `Remove group "${groupName}"? Projects in this group will become ungrouped.`,
        { title: "Remove group", kind: "warning", okLabel: "Remove", cancelLabel: "Cancel" },
      );
      if (!confirmed) return;
      try {
        await deleteGroup(groupId);
      } catch (error) {
        pushNotice({
          tone: "error",
          title: "Couldn’t delete group",
          message: getErrorMessage(error),
        });
      }
    },
    [groups, deleteGroup, pushNotice],
  );

  const handleMoveToGroup = useCallback(
    async (repoPath: string, groupId: string | null) => {
      try {
        await moveRepoToGroup(repoPath, groupId);
      } catch (error) {
        pushNotice({
          tone: "error",
          title: "Couldn’t move project",
          message: getErrorMessage(error),
        });
      }
    },
    [moveRepoToGroup, pushNotice],
  );

  const handleSelectSidebarTab = useCallback((tabId: string) => {
    useUIStore.getState().closeGlobalSurface();
    setActiveTab(tabId);
    const store = useTerminalStore.getState();
    const allTabs = activeRepoPath ? store.getAllProjectTabs(activeRepoPath) : [];
    const tab = allTabs.find((t) => t.id === tabId);
    if (tab && (tab.kind === "terminal" || tab.kind === "assistant")) {
      store.clearTabBell(tab.ptyId);
    }
  }, [setActiveTab, activeRepoPath]);

  const handleSelectSidebarProjectTab = useCallback(async (repoPath: string, tabId: string) => {
    useUIStore.getState().closeGlobalSurface();
    if (repoPath !== activeRepoPath) {
      await handleSelectRepo(repoPath);
    }

    const store = useTerminalStore.getState();
    store.setActiveTab(tabId);
    const tab = store.projectState[repoPath]?.tabs.find((entry) => entry.id === tabId);
    if (tab && (tab.kind === "terminal" || tab.kind === "assistant")) {
      store.clearTabBell(tab.ptyId);
    }
  }, [activeRepoPath, handleSelectRepo]);

  const handleCloseTab = useCallback((tabId: string) => {
    const store = useTerminalStore.getState();
    const path = store.activeProjectPath;
    if (!path) return;
    const tab = store.projectState[path]?.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (tab.kind === "terminal" || tab.kind === "assistant") {
      closeTab(tabId);
    } else {
      store.removeTab(tabId);
    }
  }, [closeTab]);

  const handleNewAssistant = useCallback(() => {
    const launcher = MODULE_PANEL_CONTRIBUTIONS
      .filter((panel) => panel.newSession)
      .sort((left, right) => (left.newSession?.order ?? 0) - (right.newSession?.order ?? 0))[0];
    if (!launcher) {
      pushNotice({
        tone: "info",
        title: "Agent launcher unavailable",
        message: "No enabled module provides an agent session launcher.",
      });
      return;
    }
    useTerminalStore.getState().addContributedPanelTab(launcher.id, launcher.label);
    useUIStore.getState().closeGlobalSurface();
  }, [pushNotice]);

  const handleNewShell = useCallback(() => {
    useUIStore.getState().closeGlobalSurface();
    const { cols, rows } = getTerminalDimensions();
    spawnBlankShell(cols, rows);
  }, [spawnBlankShell, getTerminalDimensions]);

  const handleOpenInEditor = useCallback(async (repoPath: string) => {
    const preferredEditor = useEditorStore.getState().settings.preferredEditor;
    if (!preferredEditor) {
      useUIStore.getState().toggleGlobalSurface(BUILTIN_GLOBAL_SURFACE_IDS.settings);
      return;
    }

    try {
      await openInEditor(repoPath);
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error("Failed to open editor:", error);
      }
      pushNotice({
        tone: "error",
        title: "Couldn’t open editor",
        message: getErrorMessage(error),
      });
    }
  }, [pushNotice]);

  useEffect(() => {
    if (initialProjectAttemptedRef.current || activeRepoPath || repos.length === 0) return;

    initialProjectAttemptedRef.current = true;

    const storedRepoPath = window.localStorage.getItem(LAST_REPO_STORAGE_KEY);
    const initialRepo =
      repos.find((repo) => repo.path === storedRepoPath) ??
      repos[0];

    if (initialRepo) {
      void handleSelectRepo(initialRepo.path);
    }
  }, [repos, activeRepoPath, handleSelectRepo]);

  // All native exit routes are confirmed, including Cmd+Q with no active PTYs.
  const quitDialogOpenRef = useRef(false);
  useEffect(() => {
    const unlisten = listen<number>("quit-requested", async (event) => {
      if (quitDialogOpenRef.current) return;
      quitDialogOpenRef.current = true;
      try {
        const count = event.payload;
        const confirmed = await ask(
          count > 0
            ? `Quit Shep and stop ${count} running session${count === 1 ? "" : "s"}?`
            : "Quit Shep?",
          { title: "Quit Shep", kind: "warning", okLabel: "Quit", cancelLabel: "Cancel" },
        );
        if (confirmed) {
          try {
            await notifyModulesBeforeShutdown(MODULE_HOST_SERVICES);
            await shutdownAndQuit();
          } catch (error) {
            pushNotice({
              tone: "error",
              title: "Couldn’t safely stop sessions",
              message: getErrorMessage(error),
            });
          }
        }
      } finally {
        quitDialogOpenRef.current = false;
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, [pushNotice]);

  // Handle native menu events (accelerators for Cmd+T, Cmd+Shift+T, Cmd+B, Cmd+E, Cmd+, etc.)
  useEffect(() => {
    const unlisten = listen<string>("menu-event", (event) => {
      const contributedPanel = MODULE_PANEL_CONTRIBUTIONS.find(
        (panel) => panel.menuEvent === event.payload,
      );
      if (contributedPanel) {
        useTerminalStore.getState().addContributedPanelTab(
          contributedPanel.id,
          contributedPanel.label,
        );
        return;
      }
      switch (event.payload) {
        case "next_tab":
          cycleTabs(1);
          break;
        case "previous_tab":
          cycleTabs(-1);
          break;
        case "new_terminal":
          handleNewShell();
          break;
        case "new_agent":
          handleNewAssistant();
          break;
        case "toggle_sidebar":
          useUIStore.getState().toggleSidebar();
          break;
        case "open_in_editor": {
          const repoPath = useTerminalStore.getState().activeProjectPath;
          if (repoPath) handleOpenInEditor(repoPath);
          break;
        }
        case "settings":
          useUIStore.getState().toggleGlobalSurface(BUILTIN_GLOBAL_SURFACE_IDS.settings);
          break;
        case "check_updates":
          void useUpdateStore.getState().checkForUpdate().then(() => {
            const { status, availableVersion } = useUpdateStore.getState();
            if (status === "available" && availableVersion) {
              pushNotice(
                { tone: "info", title: "Update available", message: `Version ${availableVersion} is ready to download` },
                { durationMs: 8000 },
              );
            } else if (status === "idle") {
              pushNotice({ tone: "success", title: "You're up to date", message: "No updates available" });
            }
          });
          break;
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, [cycleTabs, handleNewShell, handleNewAssistant, handleOpenInEditor, pushNotice]);

  // Renderer fallback for platforms/webviews that deliver the shortcut to the
  // page instead of the native application menu.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab" && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        cycleTabs(event.shiftKey ? -1 : 1);
        return;
      }
      const panel = MODULE_PANEL_CONTRIBUTIONS.find((contribution) =>
        contribution.shortcut && matchesPanelShortcut(event, contribution.shortcut));
      if (!panel) return;
      event.preventDefault();
      event.stopPropagation();
      useTerminalStore.getState().addContributedPanelTab(panel.id, panel.label);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [cycleTabs]);

  const showGlobalSurface = activeGlobalSurfaceId !== null;
  const activePanelId = activeTab ? panelIdForTab(activeTab) : null;
  const activePanelProject = useMemo(() => activeRepoPath ? {
    id: activeRepoPath,
    name: fallbackWorkspaceName(activeRepoPath),
    path: activeRepoPath,
  } : null, [activeRepoPath]);
  return (
    <div className="app-shell">
      <NoticeCenter />
      <div
        className="drag-region"
        aria-hidden="true"
        onMouseDown={(e) => {
          if (e.buttons === 1) {
            if (e.detail === 2) {
              getCurrentWindow().toggleMaximize();
            } else {
              getCurrentWindow().startDragging();
            }
          }
        }}
      >
        <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-0.5 z-20">
          <button
            onClick={(e) => { e.stopPropagation(); useUIStore.getState().toggleSidebar(); }}
            onMouseDown={(e) => e.stopPropagation()}
            className={`p-1 rounded transition-opacity hover:opacity-70 ${sidebarVisible ? "opacity-40" : "opacity-15"}`}
            title={sidebarVisible ? "Hide sidebar (Cmd+B)" : "Show sidebar (Cmd+B)"}
            aria-label={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
          >
            <PanelLeft size={20} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); useUIStore.getState().toggleDiffPanel(); }}
            onMouseDown={(e) => e.stopPropagation()}
            className={`p-1 rounded transition-opacity hover:opacity-70 ${diffPanelVisible ? "opacity-40" : "opacity-15"}`}
            title={diffPanelVisible ? "Hide diff panel" : "Show diff panel"}
            aria-label={diffPanelVisible ? "Hide diff panel" : "Show diff panel"}
          >
            <PanelRight size={20} />
          </button>
        </div>
      </div>

      <div className="app-shell__frame">
        {sidebarVisible && (
          <Sidebar
            repos={repos}
            groups={groups}
            activeRepoPath={activeRepoPath}
            activeTabId={showGlobalSurface ? null : activeTabId}
            onSelectRepo={handleSelectRepo}
            onAddProject={handleAddProject}
            onRemoveProject={handleRemoveProject}
            onNewAssistant={handleNewAssistant}
            onOpenInEditor={handleOpenInEditor}
            onSelectTab={handleSelectSidebarTab}
            onSelectProjectTab={handleSelectSidebarProjectTab}
            onCloseTab={handleCloseTab}
            onMoveTab={handleMoveTab}
            onNewShell={handleNewShell}
            onRenameGroup={handleRenameGroup}
            onDeleteGroup={handleDeleteGroup}
            onMoveToGroup={handleMoveToGroup}
            tabDropProjectPath={tabDropProjectPath}
            globalNavigation={GLOBAL_SURFACE_REGISTRY.navigation()}
          />
        )}

        <div className="workspace-panel">
          <TabBar
            onClose={handleCloseTab}
            onNewShell={handleNewShell}
            onNewAssistant={handleNewAssistant}
            panels={MODULE_PANEL_CONTRIBUTIONS}
            onOpenPanel={(panel) => useTerminalStore.getState().addContributedPanelTab(panel.id, panel.label)}
            onOpenInEditor={() => { const p = useTerminalStore.getState().activeProjectPath; if (p) handleOpenInEditor(p); }}
            onRenameTab={handleRenameTab}
            onMoveTab={handleMoveTab}
            onDragProjectChange={setTabDropProjectPath}
          />

          <div ref={terminalContainerRef} className="terminal-stage">
            {activeGlobalSurfaceId && (
              <GlobalSurfaceHost
                registry={GLOBAL_SURFACE_REGISTRY}
                surfaceId={activeGlobalSurfaceId}
                close={() => useUIStore.getState().closeGlobalSurface()}
                services={MODULE_HOST_SERVICES}
              />
            )}

            {/* Project panel tabs resolve through the contribution registry. */}
            {!showGlobalSurface && activeTab && activePanelId && (
              <PanelHost
                  registry={PANEL_REGISTRY}
                  panelId={activePanelId}
                  instanceId={activeTab.id}
                  project={activePanelProject}
                  visible
                  close={() => handleCloseTab(activeTab.id)}
                  setTitle={(title) => {
                    if (title) useTerminalStore.getState().updateTab(activeTab.id, { label: title });
                  }}
                  services={MODULE_HOST_SERVICES}
              />
            )}

            {!showGlobalSurface && !activeTab && tabs.length === 0 && (
              <div className="terminal-empty">
                {activeRepoPath
                  ? "Launch an assistant or open a terminal"
                  : "Select or add a project to begin"}
              </div>
            )}
            {allTerminalTabs.map(({ tab, projectPath }) => (
              <div
                key={tab.id}
                className="absolute inset-0"
                style={{
                  display:
                    !showGlobalSurface && projectPath === activeProjectPath && tab.id === activeTabId
                      ? "block"
                      : "none",
                }}
              >
                <TerminalErrorBoundary>
                  <TerminalView
                    ptyId={tab.ptyId}
                    visible={!showGlobalSurface && projectPath === activeProjectPath && tab.id === activeTabId}
                  />
                </TerminalErrorBoundary>
              </div>
            ))}
          </div>
        </div>

        {diffPanelVisible && activePanelProject && (
          <ModuleProjectLayoutSurfaces
            slot="workspace.trailing"
            project={activePanelProject}
          />
        )}
      </div>
    </div>
  );
}
