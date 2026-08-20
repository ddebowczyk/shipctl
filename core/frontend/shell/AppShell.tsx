import { useEffect, useCallback, useRef, useMemo, useState } from "react";
import {
  TerminalPresentationRegistry,
} from "../terminal-host/index.ts";
import type { ApplicationRuntimeDiagnostic } from "../runtime/index.ts";
import {
  terminalDriverId,
  type CommandContribution,
  type ContributionId,
  type PanelContribution,
  type TerminalDriverId,
} from "@shipctl/module-api";
import {
  CanvasHost,
  type CanvasAdapterView,
} from "@shipctl/core/canvas/views";
import {
  selectedWorkspaceInstanceIds,
  workspaceGlobalInstanceId,
  workspaceProjectInstanceId,
  type WorkspaceCanvas,
  type WorkspaceCanvasView,
} from "@shipctl/core/workspace";
import { NoticeCenter } from "../shared/views.ts";
import { PanelLeft, PanelRight } from "lucide-react";
import { useRepoStore } from "../projects/index.ts";
import { TERMINAL_CLIENT_RUNTIME, useTerminalStore } from "../terminal-host/index.ts";
import { BUILTIN_GLOBAL_SURFACE_IDS } from "../shared/index.ts";
import { useUIStore } from "../shared/index.ts";
import { useShallow } from "zustand/shallow";
import { useTerminalActions } from "../terminal-host/index.ts";
import { useThemeApplicator } from "./useThemeApplicator.ts";
import { useProjectWatcher } from "../projects/index.ts";
import {
  getUsername,
  getComputerName,
  getUiState,
  openInEditor,
  setLastRepoPath,
  shutdownAndQuit,
  confirmApplicationQuit,
  confirmGroupRemoval,
  confirmProjectRemoval,
  handleTitleBarPrimaryPress,
  observeNativeMenuCommands,
  observeQuitRequests,
} from "../platform/index.ts";
import { useThemeStore } from "../appearance/index.ts";
import { useEditorStore } from "../settings/index.ts";
import { useTerminalSettingsStore } from "../terminal-host/index.ts";
import { initNotifications } from "../terminal-host/index.ts";
import { getErrorMessage } from "../platform/index.ts";
import { useNoticeStore } from "../shared/index.ts";
import {
  bindTerminalSessionDimensions,
  MODULE_HOST_SERVICES,
  notifyModulesProjectOpened,
  notifyModulesProjectRemoved,
  notifyModulesProjectsChanged,
} from "../host/index.ts";
import {
  matchesPanelShortcut,
} from "../host/index.ts";
import {
  AcceptedWorkspaceContributionRuntimeProvider,
  ModuleProjectLayoutSurfaces,
} from "../host/views.ts";
import {
  TerminalPresentationRuntimeProvider,
} from "../terminal-host/views.ts";
import { createCommandRegistry } from "./commandRegistry.ts";
import { CanvasAdapterRuntimeProvider } from "./canvasAdapterRuntime.tsx";
import { createDesktopApplicationRuntime } from "./applicationRuntime.ts";
import StandardWorkspaceFrame from "./StandardWorkspaceFrame.tsx";
import StandardWorkspaceNavigation from "./StandardWorkspaceNavigation.tsx";
import StandardWorkspaceTabs from "./StandardWorkspaceTabs.tsx";

import type {
  TabCycleDirection,
  UiState,
} from "../platform/index.ts";
import type { CanvasAdapterId } from "@shipctl/core/configuration";

const SEMANTIC_TERMINAL_DRIVER_ID = terminalDriverId("semantic-terminal");
const DEFAULT_TERMINAL_DIMENSIONS = { cols: 80, rows: 24 } as const;

function fallbackWorkspaceName(repoPath: string) {
  return repoPath.split("/").filter(Boolean).pop() ?? "Project";
}

function selectedGlobalWorkspaceView(
  canvas: WorkspaceCanvas,
): WorkspaceCanvasView | undefined {
  const selectedInstanceIds = new Set(selectedWorkspaceInstanceIds(canvas.projection.document));
  return canvas.projection.views.find((view) => (
    selectedInstanceIds.has(view.instance.instanceId)
    && view.instance.resource.kind === "global"
  ));
}

function selectedProjectWorkspaceView(
  canvas: WorkspaceCanvas,
): WorkspaceCanvasView | undefined {
  const selectedInstanceIds = new Set(selectedWorkspaceInstanceIds(canvas.projection.document));
  return canvas.projection.views.find((view) => (
    selectedInstanceIds.has(view.instance.instanceId)
    && view.instance.resource.kind === "project"
  ));
}

function selectedSemanticWorkspaceView(
  canvas: WorkspaceCanvas,
): WorkspaceCanvasView | undefined {
  const selectedInstanceIds = new Set(selectedWorkspaceInstanceIds(canvas.projection.document));
  return canvas.projection.views.find((view) => (
    selectedInstanceIds.has(view.instance.instanceId)
  ));
}

function runtimeDiagnosticTitle(diagnostic: ApplicationRuntimeDiagnostic): string {
  switch (diagnostic.kind) {
    case "persistence":
      return "Workspace persistence is unavailable";
    case "workspace":
      return diagnostic.code === "workspace.catalog-synchronization-failed"
        ? "Workspace catalog could not be synchronized"
        : "Workspace change could not be saved";
    case "reconciliation":
      return `Runtime revision ${diagnostic.registryRevision ?? "unknown"} was rejected`;
    case "startup":
      return "Runtime modules could not be inspected";
  }
}

export interface AppShellProps {
  /** Resolved once by bootstrap before terminal registry work can start. */
  readonly canvasAdapter: CanvasAdapterView;
  readonly canvasAdapterId: CanvasAdapterId;
}

export default function AppShell({ canvasAdapter, canvasAdapterId }: AppShellProps) {
  useThemeApplicator();

  const { repos, groups, activeRepoPath, fetchRepos, fetchGroups, openRepo, addRepo, removeRepo, renameGroup, deleteGroup, moveRepoToGroup } =
    useRepoStore();
  const pushNotice = useNoticeStore((s) => s.pushNotice);

  const initialProjectAttemptedRef = useRef(false);
  const durableUiStateRef = useRef<UiState | null>(null);
  const [durableUiStateLoaded, setDurableUiStateLoaded] = useState(false);
  const [tabDropProjectPath, setTabDropProjectPath] = useState<string | null>(null);
  const [applicationRuntime] = useState(createDesktopApplicationRuntime);
  const [runtimeSnapshot, setRuntimeSnapshot] = useState(() => applicationRuntime.snapshot());
  const workspaceCanvas = runtimeSnapshot.workspaceCanvas;
  const workspaceCanvasRef = useRef<WorkspaceCanvas | undefined>(workspaceCanvas);
  const workspaceGlobalActionTailRef = useRef<Promise<void>>(Promise.resolve());
  const reportedRuntimeDiagnosticIdsRef = useRef(new Set<string>());
  const {
    moduleActivations,
    activeModules,
    beforeShutdown,
    terminalPresentations,
    workspaceContributions,
  } = runtimeSnapshot.family;
  const lastTabCycleAtRef = useRef(0);

  const canvasSurfaceCatalog = workspaceContributions.canvasSurfaceCatalog;
  const modulePanelContributions = useMemo(
    () => canvasSurfaceCatalog.panels().filter((panel) => panel.moduleId !== "core"),
    [canvasSurfaceCatalog],
  );
  const globalNavigation = useMemo(
    () => canvasSurfaceCatalog.globalNavigation(),
    [canvasSurfaceCatalog],
  );
  const activeTerminalPresentationRegistry = useMemo(
    () => new TerminalPresentationRegistry(terminalPresentations),
    [terminalPresentations],
  );

  const scheduleWorkspaceGlobalAction = useCallback(
    (operation: (canvas: WorkspaceCanvas) => Promise<boolean>): Promise<boolean> => {
      const scheduled = workspaceGlobalActionTailRef.current.then(() => {
        const canvas = workspaceCanvasRef.current;
        return canvas === undefined ? false : operation(canvas);
      });
      workspaceGlobalActionTailRef.current = scheduled.then(() => undefined, () => undefined);
      return scheduled;
    },
    [],
  );

  /** Close the selected semantic view so the mount-stable terminal stage shows. */
  const showTerminalWorkspace = useCallback(async () => {
    try {
      const closed = await scheduleWorkspaceGlobalAction(async (canvas) => {
        const view = selectedSemanticWorkspaceView(canvas);
        if (view === undefined) return false;
        await canvas.execute({ kind: "close", instanceId: view.instance.instanceId });
        return true;
      });
      // Before the semantic workspace has started, the terminal stage is
      // visible by default. Keep transient global-surface state from masking
      // it while startup catches up.
      if (!closed) useUIStore.getState().closeGlobalSurface();
      return true;
    } catch {
      // The runtime canvas bridge records the diagnostic. Do not duplicate it.
      return false;
    }
  }, [scheduleWorkspaceGlobalAction]);

  const toggleSemanticGlobalSurface = useCallback(async (surfaceId: ContributionId) => {
    try {
      const handled = await scheduleWorkspaceGlobalAction(async (canvas) => {
        const current = selectedGlobalWorkspaceView(canvas);
        if (current?.instance.viewTypeId === surfaceId) {
          await canvas.execute({ kind: "close", instanceId: current.instance.instanceId });
          return true;
        }

        await canvas.execute({
          kind: "open",
          instanceId: workspaceGlobalInstanceId(surfaceId),
          viewTypeId: surfaceId,
          resource: { kind: "global" },
        });
        // Opening first keeps the current surface available if the target is
        // rejected by the accepted catalog. The old one is then hidden.
        if (current !== undefined) {
          await canvas.execute({ kind: "close", instanceId: current.instance.instanceId });
        }
        return true;
      });
      if (handled) {
        useUIStore.getState().closeGlobalSurface();
      } else {
        useUIStore.getState().toggleGlobalSurface(surfaceId);
      }
      return true;
    } catch {
      // The runtime canvas bridge records the diagnostic. Do not duplicate it.
      return false;
    }
  }, [scheduleWorkspaceGlobalAction]);

  const handleSelectRepo = useCallback(
    async (repoPath: string) => {
      if (repoPath === activeRepoPath) return true;

      try {
        if (!await showTerminalWorkspace()) return false;
        await openRepo(repoPath);
        initialProjectAttemptedRef.current = true;
        durableUiStateRef.current = await setLastRepoPath(repoPath);
        await notifyModulesProjectOpened(
          repoPath,
          MODULE_HOST_SERVICES,
          moduleActivations,
          activeModules,
        );
        return true;
      } catch (error) {
        pushNotice({
          tone: "error",
          title: "Couldn’t open project",
          message: getErrorMessage(error),
        });
        return false;
      }
    },
    [activeModules, activeRepoPath, showTerminalWorkspace, moduleActivations, openRepo, pushNotice],
  );

  const {
    spawnBlankShell,
    closeTab,
    closeProjectTerminals,
    requestTerminalSessionPlacement,
    requestTerminalSessionRename,
  } = useTerminalActions(activeRepoPath, handleSelectRepo);

  useEffect(() => {
    let cancelled = false;
    void TERMINAL_CLIENT_RUNTIME.startRegistry().catch((error) => {
      if (cancelled) return;
      pushNotice({
        tone: "error",
        title: "Couldn’t restore terminals",
        message: getErrorMessage(error),
      });
    });
    return () => {
      cancelled = true;
      void TERMINAL_CLIENT_RUNTIME.stopRegistry();
    };
  }, [pushNotice]);

  const cycleTabs = useCallback((direction: TabCycleDirection) => {
    // Native menu accelerators and the renderer fallback can both receive the
    // same shortcut on some platforms. Avoid advancing twice in that case.
    const now = performance.now();
    if (now - lastTabCycleAtRef.current < 100) return;
    lastTabCycleAtRef.current = now;
    if (activeRepoPath) useTerminalStore.getState().cycleTab(activeRepoPath, direction);
  }, [activeRepoPath]);

  const getTerminalDimensions = useCallback(
    () => ({ cols: DEFAULT_TERMINAL_DIMENSIONS.cols, rows: DEFAULT_TERMINAL_DIMENSIONS.rows }),
    [],
  );

  useEffect(() => bindTerminalSessionDimensions(() => {
    const { cols, rows } = getTerminalDimensions();
    return { columns: cols, rows };
  }), [getTerminalDimensions]);

  const activeTabId = useTerminalStore(
    (state) => activeRepoPath ? state.projectState[activeRepoPath]?.activeTabId ?? null : null,
  );

  const projectPaths = useMemo(
    () => repos.map((r) => r.path),
    [repos],
  );
  useProjectWatcher(projectPaths, moduleActivations, activeModules);

  const { setActiveTab } = useTerminalStore.getState();

  const { activeGlobalSurfaceId, sidebarVisible, diffPanelVisible } = useUIStore(useShallow((s) => ({
    activeGlobalSurfaceId: s.activeGlobalSurfaceId,
    sidebarVisible: s.sidebarVisible,
    diffPanelVisible: s.diffPanelVisible,
  })));

  const { loadSettings: loadEditorSettings } = useEditorStore.getState();
  const { loadSettings: loadTerminalSettings } = useTerminalSettingsStore.getState();

  useEffect(() => {
    let disposed = false;
    const reportedDiagnosticIds = reportedRuntimeDiagnosticIdsRef.current;
    const applySnapshot = (snapshot: ReturnType<typeof applicationRuntime.snapshot>) => {
      if (disposed) return;
      workspaceCanvasRef.current = snapshot.workspaceCanvas;
      setRuntimeSnapshot(snapshot);
      for (const diagnostic of snapshot.diagnostics) {
        if (reportedDiagnosticIds.has(diagnostic.id)) continue;
        reportedDiagnosticIds.add(diagnostic.id);
        pushNotice({
          tone: "error",
          title: runtimeDiagnosticTitle(diagnostic),
          message: `[${diagnostic.id}] ${diagnostic.code}: ${diagnostic.message}`,
        });
      }
    };

    applySnapshot(applicationRuntime.snapshot());
    const unsubscribe = applicationRuntime.subscribe(applySnapshot);
    // The runtime records startup failures as durable diagnostics. React maps
    // those records to notices rather than owning a second error path.
    void applicationRuntime.start().catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
      workspaceCanvasRef.current = undefined;
      void applicationRuntime.dispose();
    };
  }, [applicationRuntime, pushNotice]);

  useEffect(() => {
    void notifyModulesProjectsChanged(
      repos.map((repo) => repo.path),
      MODULE_HOST_SERVICES,
      moduleActivations,
      activeModules,
    );
  }, [activeModules, repos, moduleActivations]);

  useEffect(() => {
    fetchRepos();
    fetchGroups();
    void loadEditorSettings();
    void loadTerminalSettings();
    void initNotifications();
    getUsername().then((name) => useUIStore.getState().setUsername(name));
    getComputerName().then((name) => useUIStore.getState().setComputerName(name));
  }, [fetchRepos, fetchGroups, loadEditorSettings, loadTerminalSettings]);

  const handleMoveTab = useCallback(
    async (tabId: string, destinationPath: string) => {
      const store = useTerminalStore.getState();
      const sourceEntry = Object.entries(store.projectState).find(([, project]) =>
        project.tabs.some((entry) => entry.id === tabId),
      );
      if (!sourceEntry || sourceEntry[0] === destinationPath) return;
      const [sourcePath, sourceProject] = sourceEntry;
      const tab = sourceProject.tabs.find((entry) => entry.id === tabId);
      if (!tab || tab.kind !== "terminal") return;

      if (!await handleSelectRepo(destinationPath)) return;
      const destinationStore = useTerminalStore.getState();
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
      destinationStore.setActiveTab(destinationPath, tabId);
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

      if (tab.kind === "terminal" && tab.moduleSessionId) {
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
        if (!await showTerminalWorkspace()) return;
        await addRepo(repoPath, MODULE_HOST_SERVICES, moduleActivations);
        // addRepo sets activeRepoPath in the repo store, get the canonical path
        const canonicalPath = useRepoStore.getState().activeRepoPath;
        if (!canonicalPath) return;
        initialProjectAttemptedRef.current = true;
        durableUiStateRef.current = await setLastRepoPath(canonicalPath);
        await notifyModulesProjectOpened(
          canonicalPath,
          MODULE_HOST_SERVICES,
          moduleActivations,
          activeModules,
        );
      } catch (error) {
        pushNotice({
          tone: "error",
          title: "Couldn’t add project",
          message: getErrorMessage(error),
        });
      }
    },
    [activeModules, addRepo, showTerminalWorkspace, moduleActivations, pushNotice],
  );

  const handleRemoveProject = useCallback(
    async (repoPath: string) => {
      const repoName = repoPath.split("/").filter(Boolean).pop() ?? "this project";
      const confirmed = await confirmProjectRemoval(repoName);
      if (!confirmed) return;
      try {
        await closeProjectTerminals(repoPath);
        await removeRepo(repoPath);
        useTerminalStore.getState().removeProject(repoPath);
        await notifyModulesProjectRemoved(
          repoPath,
          MODULE_HOST_SERVICES,
          moduleActivations,
          activeModules,
        );
      } catch (error) {
        pushNotice({
          tone: "error",
          title: "Couldn’t remove project",
          message: getErrorMessage(error),
        });
      }
    },
    [activeModules, closeProjectTerminals, moduleActivations, pushNotice, removeRepo],
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
      const confirmed = await confirmGroupRemoval(groupName);
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

  const handleSelectSidebarTab = useCallback(async (tabId: string) => {
    if (!activeRepoPath) return;
    if (!await showTerminalWorkspace()) return;
    setActiveTab(activeRepoPath, tabId);
    const store = useTerminalStore.getState();
    const allTabs = activeRepoPath ? store.getAllProjectTabs(activeRepoPath) : [];
    const tab = allTabs.find((t) => t.id === tabId);
    if (tab?.kind === "terminal") {
      store.clearTabBell(tab.terminalId);
    }
  }, [activeRepoPath, showTerminalWorkspace, setActiveTab]);

  const handleSelectSidebarProjectTab = useCallback(async (repoPath: string, tabId: string) => {
    if (repoPath !== activeRepoPath) {
      if (!await handleSelectRepo(repoPath)) return;
    } else {
      if (!await showTerminalWorkspace()) return;
    }

    const store = useTerminalStore.getState();
    store.setActiveTab(repoPath, tabId);
    const tab = store.projectState[repoPath]?.tabs.find((entry) => entry.id === tabId);
    if (tab?.kind === "terminal") {
      store.clearTabBell(tab.terminalId);
    }
  }, [activeRepoPath, showTerminalWorkspace, handleSelectRepo]);

  const handleCloseTab = useCallback((tabId: string) => {
    if (!activeRepoPath) return;
    const store = useTerminalStore.getState();
    const tab = store.projectState[activeRepoPath]?.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (tab.kind === "terminal") {
      closeTab(tabId);
    } else {
      store.removeTab(activeRepoPath, tabId);
    }
  }, [activeRepoPath, closeTab]);

  const handleOpenPanel = useCallback(async (panel: PanelContribution) => {
    const projectPath = activeRepoPath;
    if (panel.scope === "project" && projectPath === null) {
      pushNotice({
        tone: "info",
        title: "Project required",
        message: `${panel.label} opens in an active project.`,
      });
      return false;
    }

    try {
      return await scheduleWorkspaceGlobalAction(async (canvas) => {
        const currentGlobal = selectedGlobalWorkspaceView(canvas);
        const isGlobal = panel.scope === "global";
        const instanceId = isGlobal
          ? workspaceGlobalInstanceId(panel.id)
          : workspaceProjectInstanceId(panel.id, projectPath!);
        await canvas.execute({
          kind: "open",
          instanceId,
          viewTypeId: panel.id,
          resource: isGlobal
            ? { kind: "global" }
            : { kind: "project", projectId: projectPath! },
        });
        // Keep the old global surface visible until the admitted target opens;
        // a rejected semantic command therefore leaves a usable workspace.
        if (currentGlobal && currentGlobal.instance.instanceId !== instanceId) {
          await canvas.execute({ kind: "close", instanceId: currentGlobal.instance.instanceId });
        }
        useUIStore.getState().closeGlobalSurface();
        return true;
      });
    } catch {
      // Workspace diagnostics already identify admission/persistence failures.
      return false;
    }
  }, [activeRepoPath, pushNotice, scheduleWorkspaceGlobalAction]);

  const handleNewModuleSession = useCallback(async () => {
    const launcher = modulePanelContributions
      .filter((panel) => panel.newSession)
      .sort((left, right) => (left.newSession?.order ?? 0) - (right.newSession?.order ?? 0))[0];
    if (!launcher) {
      pushNotice({
        tone: "info",
        title: "Session launcher unavailable",
        message: "No enabled module provides a session launcher.",
      });
      return;
    }
    await handleOpenPanel(launcher);
  }, [handleOpenPanel, modulePanelContributions, pushNotice]);

  const handleNewShell = useCallback(async (driverId: TerminalDriverId = SEMANTIC_TERMINAL_DRIVER_ID) => {
    if (!await showTerminalWorkspace()) return;
    const { cols, rows } = getTerminalDimensions();
    void spawnBlankShell(driverId, cols, rows);
  }, [showTerminalWorkspace, getTerminalDimensions, spawnBlankShell]);

  const handleOpenInEditor = useCallback(async (repoPath: string) => {
    const preferredEditor = useEditorStore.getState().settings.preferredEditor;
    if (!preferredEditor) {
      await toggleSemanticGlobalSurface(BUILTIN_GLOBAL_SURFACE_IDS.settings);
      return;
    }

    try {
      await openInEditor(repoPath, preferredEditor);
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
  }, [pushNotice, toggleSemanticGlobalSurface]);

  const handleOpenPanelById = useCallback((panelId: ContributionId) => {
    const panel = canvasSurfaceCatalog.panel(panelId);
    if (!panel) {
      throw new Error(`Panel ${panelId} is unavailable in this build`);
    }
    return handleOpenPanel(panel);
  }, [canvasSurfaceCatalog, handleOpenPanel]);

  const coreCommands = useMemo<readonly CommandContribution[]>(() => [
    {
      id: "core.settings",
      moduleId: "core",
      label: "Settings…",
      run: async () => { await toggleSemanticGlobalSurface(BUILTIN_GLOBAL_SURFACE_IDS.settings); },
    },
    {
      id: "terminal.new-semantic",
      moduleId: "core",
      label: "New Semantic Terminal",
      run: () => handleNewShell(SEMANTIC_TERMINAL_DRIVER_ID),
    },
    {
      id: "terminal.new-thin",
      moduleId: "core",
      label: "New Thin Terminal",
      run: () => handleNewShell(terminalDriverId("thin-terminal")),
    },
    {
      id: "core.new-session",
      moduleId: "core",
      label: "New Session",
      isEnabled: ({ activeProjectId }) => activeProjectId !== null,
      run: handleNewModuleSession,
    },
    {
      id: "core.open-in-editor",
      moduleId: "core",
      label: "Open in Editor",
      isEnabled: ({ activeProjectId }) => activeProjectId !== null,
      run: ({ activeProjectId }) => {
        if (activeProjectId) return handleOpenInEditor(activeProjectId);
      },
    },
    {
      id: "core.toggle-sidebar",
      moduleId: "core",
      label: "Toggle Sidebar",
      run: () => useUIStore.getState().toggleSidebar(),
    },
    {
      id: "core.next-tab",
      moduleId: "core",
      label: "Next Tab",
      run: () => cycleTabs(1),
    },
    {
      id: "core.previous-tab",
      moduleId: "core",
      label: "Previous Tab",
      run: () => cycleTabs(-1),
    },
  ], [
    cycleTabs,
    handleNewModuleSession,
    handleNewShell,
    handleOpenInEditor,
    toggleSemanticGlobalSurface,
  ]);

  const commandRegistry = useMemo(
    () => createCommandRegistry({
      coreCommands,
      acceptedModuleCommands: workspaceContributions.commands(),
      moduleActivations,
    }),
    [coreCommands, moduleActivations, workspaceContributions],
  );

  const dispatchNativeCommand = useCallback((commandId: string) => {
    void commandRegistry.dispatch(commandId, {
      activeProjectId: activeRepoPath,
      openPanel: handleOpenPanelById,
    }).then((result) => {
      if (result.status === "disabled") {
        pushNotice({
          tone: "info",
          title: "Command unavailable",
          message: `${result.command.label} requires an open project.`,
        });
      }
      if (result.status === "failed") {
        pushNotice({
          tone: "error",
          title: `Couldn’t run ${result.command.label}`,
          message: getErrorMessage(result.error),
        });
      }
    });
  }, [activeRepoPath, commandRegistry, handleOpenPanelById, pushNotice]);

  useEffect(() => {
    let cancelled = false;
    void getUiState()
      .then((state) => {
        if (cancelled) return;
        durableUiStateRef.current = state;
        useThemeStore.getState().hydrate(state.themeId, state.customTheme);
      })
      .catch((error) => {
        if (cancelled) return;
        pushNotice({
          tone: "error",
          title: "Couldn’t load UI preferences",
          message: getErrorMessage(error),
        });
      })
      .finally(() => {
        if (!cancelled) setDurableUiStateLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pushNotice]);

  useEffect(() => {
    if (!durableUiStateLoaded || initialProjectAttemptedRef.current || activeRepoPath || repos.length === 0) return;

    initialProjectAttemptedRef.current = true;

    const storedRepoPath = durableUiStateRef.current?.lastRepoPath;
    const initialRepo =
      repos.find((repo) => repo.path === storedRepoPath) ??
      repos[0];

    if (initialRepo) {
      void handleSelectRepo(initialRepo.path);
    }
  }, [durableUiStateLoaded, repos, activeRepoPath, handleSelectRepo]);

  // All native exit routes are confirmed, including Cmd+Q with no active PTYs.
  const quitDialogOpenRef = useRef(false);
  useEffect(() => {
    const unlisten = observeQuitRequests(async (count) => {
      if (quitDialogOpenRef.current) return;
      quitDialogOpenRef.current = true;
      try {
        const confirmed = await confirmApplicationQuit(count);
        if (confirmed) {
          try {
            await beforeShutdown();
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
  }, [beforeShutdown, pushNotice]);

  // The native menu emits stable command IDs. The registry owns their static
  // dispatch, so this listener stays a transport edge instead of a command switch.
  useEffect(() => {
    const unlisten = observeNativeMenuCommands((commandId) => {
      dispatchNativeCommand(commandId);
    });
    return () => { unlisten.then((f) => f()); };
  }, [dispatchNativeCommand]);

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
      const panel = modulePanelContributions.find((contribution) =>
        contribution.shortcut && matchesPanelShortcut(event, contribution.shortcut));
      if (!panel) return;
      event.preventDefault();
      event.stopPropagation();
      void handleOpenPanel(panel);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [cycleTabs, handleOpenPanel, modulePanelContributions]);

  const selectedProjectView = workspaceCanvas
    ? selectedProjectWorkspaceView(workspaceCanvas)
    : undefined;
  const selectedGlobalView = workspaceCanvas
    ? selectedGlobalWorkspaceView(workspaceCanvas)
    : undefined;
  const activePanelId = selectedProjectView
    ? selectedProjectView.instance.viewTypeId as ContributionId
    : null;
  const activePanelProjectPath = selectedProjectView?.instance.resource.kind === "project"
    ? selectedProjectView.instance.resource.projectId
    : null;
  const activePanelProject = useMemo(() => activeRepoPath ? {
    id: activeRepoPath,
    name: fallbackWorkspaceName(activeRepoPath),
    path: activeRepoPath,
  } : null, [activeRepoPath]);
  const semanticWorkspaceOpen = workspaceCanvas !== undefined
    && selectedSemanticWorkspaceView(workspaceCanvas) !== undefined;
  const visibleGlobalSurfaceId = selectedGlobalView
    ? selectedGlobalView.instance.viewTypeId as ContributionId
    : activeGlobalSurfaceId;
  return (
    <CanvasAdapterRuntimeProvider adapterId={canvasAdapterId}>
      <AcceptedWorkspaceContributionRuntimeProvider
        catalog={workspaceContributions}
        moduleActivations={moduleActivations}
      >
        <TerminalPresentationRuntimeProvider
          registry={activeTerminalPresentationRegistry}
          moduleActivations={moduleActivations}
          services={MODULE_HOST_SERVICES}
          activeProjectPath={activeRepoPath}
          activeTabId={activeTabId}
        >
          <div className="app-shell">
            <NoticeCenter />
            <div
              className="drag-region"
              aria-hidden="true"
              onMouseDown={(e) => {
                if (e.buttons === 1) {
                  if (e.detail === 2) {
                    handleTitleBarPrimaryPress(2);
                  } else {
                    handleTitleBarPrimaryPress(1);
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

            <StandardWorkspaceFrame
              navigation={sidebarVisible ? (
                <StandardWorkspaceNavigation
                  repos={repos}
                  groups={groups}
                  activeRepoPath={activeRepoPath}
                  activeTabId={activeTabId}
                  activePanelId={activePanelId}
                  activePanelProjectPath={activePanelProjectPath}
                  activeGlobalSurfaceId={visibleGlobalSurfaceId}
                  onSelectRepo={handleSelectRepo}
                  onAddProject={handleAddProject}
                  onRemoveProject={handleRemoveProject}
                  onNewModuleSession={() => { void handleNewModuleSession(); }}
                  onOpenInEditor={handleOpenInEditor}
                  onSelectTab={(tabId) => { void handleSelectSidebarTab(tabId); }}
                  onSelectProjectTab={(projectPath, tabId) => { void handleSelectSidebarProjectTab(projectPath, tabId); }}
                  onCloseTab={handleCloseTab}
                  onMoveTab={handleMoveTab}
                  onNewShell={() => { void handleNewShell(); }}
                  onRenameGroup={handleRenameGroup}
                  onDeleteGroup={handleDeleteGroup}
                  onMoveToGroup={handleMoveToGroup}
                  onOpenPanel={(panel) => { void handleOpenPanel(panel); }}
                  onToggleGlobalSurface={(surfaceId) => { void toggleSemanticGlobalSurface(surfaceId); }}
                  tabDropProjectPath={tabDropProjectPath}
                  globalNavigation={globalNavigation}
                />
              ) : undefined}
              tabs={(
                <StandardWorkspaceTabs
                  onClose={handleCloseTab}
                  onSelectTab={(tabId) => { void handleSelectSidebarTab(tabId); }}
                  onNewTerminal={(driverId) => { void handleNewShell(driverId); }}
                  panels={modulePanelContributions}
                  onOpenPanel={(panel) => { void handleOpenPanel(panel); }}
                  onOpenInEditor={() => {
                    if (activeRepoPath) void handleOpenInEditor(activeRepoPath);
                  }}
                  onRenameTab={handleRenameTab}
                  onMoveTab={handleMoveTab}
                  onDragProjectChange={setTabDropProjectPath}
                  globalSurfaceOpen={semanticWorkspaceOpen || activeGlobalSurfaceId !== null}
                />
              )}
              trailing={diffPanelVisible && activePanelProject ? (
                <ModuleProjectLayoutSurfaces project={activePanelProject} />
              ) : undefined}
            >
              <CanvasHost adapter={canvasAdapter} workspace={workspaceCanvas} />
            </StandardWorkspaceFrame>
          </div>
        </TerminalPresentationRuntimeProvider>
      </AcceptedWorkspaceContributionRuntimeProvider>
    </CanvasAdapterRuntimeProvider>
  );
}
