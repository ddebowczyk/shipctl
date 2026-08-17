import { useEffect, useCallback, useRef, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ACTIVATION_TERMINAL_SESSIONS,
  terminalHostAdapter,
  terminalPresentationRegistry,
} from "../terminal-host/index.ts";
import {
  createModuleActivationIdentity,
  SemanticServiceRegistry,
} from "../runtime/index.ts";
import {
  terminalDriverId,
  type CommandContribution,
  type ContributionId,
  type ModuleActivationContext,
  type ModuleId,
  type PanelContribution,
  type TerminalDriverId,
  type TerminalHostDescriptor,
} from "@shipctl/module-api";
import {
  createCanvasModel,
  type CanvasActions,
  type CanvasPorts,
} from "@shipctl/core/canvas";
import { CanvasHost, type CanvasAdapterView } from "@shipctl/core/canvas/views";
import {
  CURRENT_CANVAS_WORKSPACE_ID,
  InMemoryWorkspacePersistence,
  WorkspaceAuthority,
  WorkspaceCanvasBridge,
  createCurrentCanvasWorkspaceCatalog,
  createWorkspaceServiceProvider,
  type WorkspaceCanvas,
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
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { BUILTIN_GLOBAL_SURFACE_LOADERS } from "./builtinGlobalSurfaceLoaders.ts";
import {
  getUsername,
  getComputerName,
  getUiState,
  openInEditor,
  setLastRepoPath,
  shutdownAndQuit,
  createGitServiceProvider,
  createProcessesServiceProvider,
  createProjectDocumentsServiceProvider,
  createSkillInstallationServiceProvider,
  createCredentialStoreServiceProvider,
  createAssistantLaunchServiceProvider,
  createUsageSourcesServiceProvider,
  createPluginDataServiceProvider,
  createMessagesServiceProvider,
  createSchedulerServiceProvider,
  createSemanticTerminalsServiceProvider,
  createTerminalSessionsServiceProvider,
  createTauriWorkspacePersistencePort,
  reportModuleReconciliationFailure,
} from "../platform/index.ts";
import { useThemeStore } from "../appearance/index.ts";
import { useEditorStore } from "../settings/index.ts";
import { useTerminalSettingsStore } from "../terminal-host/index.ts";
import { initNotifications } from "../terminal-host/index.ts";
import { getErrorMessage } from "../platform/index.ts";
import { useNoticeStore } from "../shared/index.ts";
import {
  bindTerminalSessionDimensions,
  BUILTIN_GLOBAL_NAVIGATION,
  createBuiltinGlobalSurfaceContributions,
  MODULE_HOST_SERVICES,
  ENABLED_MODULES,
  notifyModulesBeforeShutdown,
  notifyModulesProjectOpened,
  notifyModulesProjectRemoved,
  notifyModulesProjectsChanged,
  panelIdForTab,
  AcceptedWorkspaceCatalogController,
  LiveModuleSupervisor,
  publishFrontendRuntimeSnapshot,
  type ShipctlModule,
  type LiveModuleFamily,
  WorkspaceContributionCatalog,
} from "../host/index.ts";
import {
  matchesPanelShortcut,
} from "../host/index.ts";
import { createCommandRegistry } from "./commandRegistry.ts";
import { CanvasAdapterRuntimeProvider } from "./canvasAdapterRuntime.tsx";

import type {
  CanvasAdapterId,
  TabCycleDirection,
  TerminalTabData,
  UiState,
  UnifiedTab,
} from "../platform/index.ts";
import type { TerminalId } from "@shipctl/core/terminal-host";

// Stable empty arrays to avoid infinite re-render loops with zustand v5's
// useSyncExternalStore — selectors must return the same reference for the same state.
const EMPTY_TABS: UnifiedTab[] = [];
const SEMANTIC_SERVICE_PROVIDERS = [
  createGitServiceProvider(),
  createProcessesServiceProvider(),
  createProjectDocumentsServiceProvider(),
  createSkillInstallationServiceProvider(),
  createCredentialStoreServiceProvider(),
  createAssistantLaunchServiceProvider(),
  createUsageSourcesServiceProvider(),
  createPluginDataServiceProvider(),
];
const SEMANTIC_SERVICES = new SemanticServiceRegistry(SEMANTIC_SERVICE_PROVIDERS);
const CORE_ACTIVATION = SEMANTIC_SERVICES.activate(
  createModuleActivationIdentity("core", "host"),
).context;
const CORE_MODULE_ACTIVATIONS: ReadonlyMap<ModuleId, ModuleActivationContext> = new Map([
  ["core", CORE_ACTIVATION],
]);
const SEMANTIC_TERMINAL_DRIVER_ID = terminalDriverId("semantic-terminal");
const DEFAULT_TERMINAL_DIMENSIONS = { cols: 80, rows: 24 } as const;

function withCoreActivation(
  activations: ReadonlyMap<ModuleId, ModuleActivationContext>,
): ReadonlyMap<ModuleId, ModuleActivationContext> {
  return new Map([["core", CORE_ACTIVATION], ...activations]);
}

function terminalSlotDescriptor(terminalId: TerminalId): TerminalHostDescriptor {
  const descriptor = TERMINAL_CLIENT_RUNTIME.descriptor(terminalId);
  return {
    id: terminalId,
    driverId: descriptor?.driverId ?? SEMANTIC_TERMINAL_DRIVER_ID,
    lifecycle: descriptor?.lifecycle ?? "starting",
    columns: descriptor?.columns ?? 0,
    rows: descriptor?.rows ?? 0,
    label: descriptor?.metadata.label ?? "Terminal",
    projectPath: descriptor?.metadata.projectPath ?? null,
  };
}

function fallbackWorkspaceName(repoPath: string) {
  return repoPath.split("/").filter(Boolean).pop() ?? "Project";
}

/**
 * Build the host's private renderer catalog from an already activated runtime
 * family. The resulting semantic catalog contains only data; React loaders
 * remain behind this host boundary.
 */
function createWorkspaceContributions(
  family: Pick<
    LiveModuleFamily,
    "registryRevision" | "modules" | "activationContextsByModule"
  >,
): WorkspaceContributionCatalog {
  return WorkspaceContributionCatalog.create({
    registryRevision: family.registryRevision,
    modules: family.modules,
    activationContextsByModule: family.activationContextsByModule,
    hostContributions: [{
      moduleId: "core",
      activation: CORE_ACTIVATION,
      globalSurfaces: createBuiltinGlobalSurfaceContributions(BUILTIN_GLOBAL_SURFACE_LOADERS),
      globalNavigation: BUILTIN_GLOBAL_NAVIGATION,
    }],
  }).withHostWorkspaceDefinitions(createCurrentCanvasWorkspaceCatalog().definitions);
}

const INITIAL_WORKSPACE_CONTRIBUTIONS = createWorkspaceContributions({
  registryRevision: 0,
  modules: [],
  activationContextsByModule: new Map<ModuleId, ModuleActivationContext>(),
});

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
  const [workspaceCanvas, setWorkspaceCanvas] = useState<WorkspaceCanvas | undefined>();
  const [moduleRuntime, setModuleRuntime] = useState({
    moduleActivations: CORE_MODULE_ACTIVATIONS,
    activeModules: [] as readonly ShipctlModule[],
    workspaceContributions: INITIAL_WORKSPACE_CONTRIBUTIONS,
  });
  const { moduleActivations, activeModules } = moduleRuntime;
  const lastTabCycleAtRef = useRef(0);

  const canvasSurfaceCatalog = moduleRuntime.workspaceContributions.canvasSurfaceCatalog;
  const modulePanelContributions = useMemo(
    () => canvasSurfaceCatalog.panels().filter((panel) => panel.moduleId !== "core"),
    [canvasSurfaceCatalog],
  );
  const globalNavigation = useMemo(
    () => canvasSurfaceCatalog.globalNavigation(),
    [canvasSurfaceCatalog],
  );
  const activeTerminalPresentationRegistry = useMemo(
    () => terminalPresentationRegistry(activeModules),
    [activeModules],
  );

  const handleSelectRepo = useCallback(
    async (repoPath: string) => {
      if (repoPath === activeRepoPath) return true;

      try {
        useUIStore.getState().closeGlobalSurface();
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
    [activeModules, activeRepoPath, moduleActivations, openRepo, pushNotice],
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

  // Derive active project's tabs and commands from stores
  const activeProjectTerminals = useTerminalStore(
    (s) => (activeRepoPath ? s.projectState[activeRepoPath] : null),
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
  useProjectWatcher(projectPaths, moduleActivations, activeModules);
  // Collect only PTY-backed tabs for terminal presentation (panel tabs have no terminal)
  const allTerminalTabs = useMemo(() => {
    const all: Array<{ tab: TerminalTabData; projectPath: string }> = [];
    for (const [projectPath, ps] of Object.entries(projectState)) {
      for (const tab of ps.tabs) {
        if (tab.kind === "terminal") {
          all.push({ tab, projectPath });
        }
      }
    }

    // Canvas owns the stable presentation order. The source list remains a
    // complete inventory, independent from tab display order.
    return all;
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

  useEffect(() => {
    let disposed = false;
    let supervisor: LiveModuleSupervisor | undefined;
    let workspaceController: AcceptedWorkspaceCatalogController | undefined;
    let workspaceCanvasBridge: WorkspaceCanvasBridge | undefined;
    void (async () => {
      let workspaceAuthority: WorkspaceAuthority;
      try {
        workspaceAuthority = await WorkspaceAuthority.open({
          workspaceId: CURRENT_CANVAS_WORKSPACE_ID,
          catalog: INITIAL_WORKSPACE_CONTRIBUTIONS.workspaceCatalog(),
          persistence: createTauriWorkspacePersistencePort(),
          deferCatalogReconciliationUntilFirstAcceptedSnapshot: true,
        });
      } catch (error) {
        if (disposed) return;
        pushNotice({
          tone: "error",
          title: "Workspace state will not persist this run",
          message: getErrorMessage(error),
        });
        workspaceAuthority = await WorkspaceAuthority.open({
          workspaceId: CURRENT_CANVAS_WORKSPACE_ID,
          catalog: INITIAL_WORKSPACE_CONTRIBUTIONS.workspaceCatalog(),
          persistence: new InMemoryWorkspacePersistence(),
          deferCatalogReconciliationUntilFirstAcceptedSnapshot: true,
        });
      }
      if (disposed) return;

      workspaceCanvasBridge = new WorkspaceCanvasBridge({
        authority: workspaceAuthority,
        onFailure: (_action, error) => {
          if (disposed) return;
          pushNotice({
            tone: "error",
            title: "Workspace change could not be saved",
            message: getErrorMessage(error),
          });
        },
      });
      workspaceCanvasBridge.subscribe((canvas) => {
        if (!disposed) setWorkspaceCanvas(canvas);
      });
      setWorkspaceCanvas(workspaceCanvasBridge.snapshot());

      workspaceController = new AcceptedWorkspaceCatalogController({
        authority: workspaceAuthority,
        onFailure: (failure) => {
          if (disposed) return;
          pushNotice({
            tone: "error",
            title: "Workspace catalog could not be synchronized",
            message: `Revision ${failure.catalogRevision}: ${failure.message}`,
          });
        },
      });
      supervisor = new LiveModuleSupervisor({
        staticModules: ENABLED_MODULES,
        services: MODULE_HOST_SERVICES,
        createSemanticServices: (bindings, deactivateActivation) => new SemanticServiceRegistry([
          ...SEMANTIC_SERVICE_PROVIDERS,
          createWorkspaceServiceProvider({ authority: workspaceAuthority }),
          createMessagesServiceProvider({
            clientsByActivation: bindings.clientsByActivation,
            deactivateActivation,
          }),
          createSchedulerServiceProvider({
            bindingsByActivation: bindings.schedulerBindingsByActivation,
          }),
          createTerminalSessionsServiceProvider({
            bindingsByActivation: bindings.terminalBindingsByActivation,
            runtime: ACTIVATION_TERMINAL_SESSIONS,
            terminalHost: terminalHostAdapter,
          }),
          createSemanticTerminalsServiceProvider({
            bindingsByActivation: bindings.terminalBindingsByActivation,
            runtime: ACTIVATION_TERMINAL_SESSIONS,
          }),
        ]),
        createWorkspaceContributions,
        publish: (family) => {
          if (disposed) return;
          const workspaceContributions = family.workspaceContributions;
          if (workspaceContributions === undefined) {
            pushNotice({
              tone: "error",
              title: "Workspace contributions were not published",
              message: "The accepted runtime family has no canvas contribution catalog.",
            });
            return;
          }
          setModuleRuntime({
            activeModules: family.modules,
            moduleActivations: withCoreActivation(family.activationContextsByModule),
            workspaceContributions,
          });
          // This observer runs only after route/schedule reconciliation and
          // semantic host-service publication have committed. Its failure is a
          // workspace diagnostic, never a rejected runtime revision.
          void workspaceController?.submit(workspaceContributions.workspaceCatalog());
        },
        reportApplied: async (family) => {
          await publishFrontendRuntimeSnapshot(
            {
              registryRevision: family.registryRevision,
              activationContextsByModule: family.activationContextsByModule,
              artifactDescriptorsByModule: family.artifactDescriptorsByModule,
              activationOutcomes: [...family.artifactDescriptorsByModule.keys()].map((moduleId) => ({
                moduleId,
                status: "active" as const,
                phase: "active" as const,
              })),
            },
            family.modules,
          );
        },
        reportRejected: async (diagnostic) => {
          await reportModuleReconciliationFailure({
            schemaVersion: 1,
            registryRevision: diagnostic.desiredRevision,
            moduleId: diagnostic.moduleId,
            activationId: diagnostic.activationId,
            phase: diagnostic.stage,
            code: diagnostic.code,
            message: diagnostic.message,
          });
          pushNotice({
            tone: "error",
            title: `Runtime revision ${diagnostic.desiredRevision} was rejected`,
            message: `${diagnostic.code}: ${diagnostic.message}`,
          });
        },
      });
      await supervisor.start();
    })().catch((error) => {
      if (disposed) return;
      pushNotice({
        tone: "error",
        title: "Runtime modules could not be inspected",
        message: getErrorMessage(error),
      });
    });

    return () => {
      disposed = true;
      workspaceCanvasBridge?.dispose();
      workspaceController?.dispose();
      void supervisor?.dispose();
    };
  }, []);

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
        useUIStore.getState().closeGlobalSurface();
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
    [activeModules, addRepo, moduleActivations, pushNotice],
  );

  const handleRemoveProject = useCallback(
    async (repoPath: string) => {
      const repoName = repoPath.split("/").filter(Boolean).pop() ?? "this project";
      const confirmed = await ask(
        `Remove "${repoName}" from Shipctl? The files on disk will not be deleted.`,
        { title: "Remove project", kind: "warning", okLabel: "Remove", cancelLabel: "Cancel" },
      );
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
    if (!activeRepoPath) return;
    useUIStore.getState().closeGlobalSurface();
    setActiveTab(activeRepoPath, tabId);
    const store = useTerminalStore.getState();
    const allTabs = activeRepoPath ? store.getAllProjectTabs(activeRepoPath) : [];
    const tab = allTabs.find((t) => t.id === tabId);
    if (tab?.kind === "terminal") {
      store.clearTabBell(tab.terminalId);
    }
  }, [setActiveTab, activeRepoPath]);

  const handleSelectSidebarProjectTab = useCallback(async (repoPath: string, tabId: string) => {
    useUIStore.getState().closeGlobalSurface();
    if (repoPath !== activeRepoPath) {
      if (!await handleSelectRepo(repoPath)) return;
    }

    const store = useTerminalStore.getState();
    store.setActiveTab(repoPath, tabId);
    const tab = store.projectState[repoPath]?.tabs.find((entry) => entry.id === tabId);
    if (tab?.kind === "terminal") {
      store.clearTabBell(tab.terminalId);
    }
  }, [activeRepoPath, handleSelectRepo]);

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

  const handleNewModuleSession = useCallback(() => {
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
    if (!activeRepoPath) return;
    useTerminalStore.getState().addContributedPanelTab(activeRepoPath, launcher.id, launcher.label);
    useUIStore.getState().closeGlobalSurface();
  }, [activeRepoPath, modulePanelContributions, pushNotice]);

  const handleOpenPanel = useCallback((panel: PanelContribution) => {
    if (!activeRepoPath) return;
    useTerminalStore.getState().addContributedPanelTab(
      activeRepoPath,
      panel.id,
      panel.label,
    );
  }, [activeRepoPath]);

  const handleReorderTab = useCallback((tabId: string, destinationIndex: number) => {
    if (!activeRepoPath) return;
    useTerminalStore.getState().reorderTab(activeRepoPath, tabId, destinationIndex);
  }, [activeRepoPath]);

  const handleNewShell = useCallback((driverId: TerminalDriverId = SEMANTIC_TERMINAL_DRIVER_ID) => {
    useUIStore.getState().closeGlobalSurface();
    const { cols, rows } = getTerminalDimensions();
    void spawnBlankShell(driverId, cols, rows);
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

  const handleOpenPanelById = useCallback((panelId: ContributionId) => {
    const panel = canvasSurfaceCatalog.panel(panelId);
    if (!panel) {
      throw new Error(`Panel ${panelId} is unavailable in this build`);
    }
    handleOpenPanel(panel);
  }, [canvasSurfaceCatalog, handleOpenPanel]);

  const coreCommands = useMemo<readonly CommandContribution[]>(() => [
    {
      id: "core.settings",
      moduleId: "core",
      label: "Settings…",
      run: () => useUIStore.getState().toggleGlobalSurface(BUILTIN_GLOBAL_SURFACE_IDS.settings),
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
  ]);

  const commandRegistry = useMemo(
    () => createCommandRegistry({ coreCommands, modules: activeModules }),
    [activeModules, coreCommands],
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
    const unlisten = listen<number>("quit-requested", async (event) => {
      if (quitDialogOpenRef.current) return;
      quitDialogOpenRef.current = true;
      try {
        const count = event.payload;
        const confirmed = await ask(
          count > 0
            ? `Quit Shipctl and stop ${count} running session${count === 1 ? "" : "s"}?`
            : "Quit Shipctl?",
          { title: "Quit Shipctl", kind: "warning", okLabel: "Quit", cancelLabel: "Cancel" },
        );
        if (confirmed) {
          try {
            await notifyModulesBeforeShutdown(
              MODULE_HOST_SERVICES,
              moduleActivations,
              activeModules,
            );
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
  }, [activeModules, moduleActivations, pushNotice]);

  // The native menu emits stable command IDs. The registry owns their static
  // dispatch, so this listener stays a transport edge instead of a command switch.
  useEffect(() => {
    const unlisten = listen<string>("menu-event", (event) => {
      dispatchNativeCommand(event.payload);
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
      handleOpenPanel(panel);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [cycleTabs, handleOpenPanel, modulePanelContributions]);

  const activePanelId = activeTab ? panelIdForTab(activeTab) : null;
  const activePanelProject = useMemo(() => activeRepoPath ? {
    id: activeRepoPath,
    name: fallbackWorkspaceName(activeRepoPath),
    path: activeRepoPath,
  } : null, [activeRepoPath]);
  const canvasModel = useMemo(() => createCanvasModel({
    repos,
    groups,
    sidebarVisible,
    tabDropProjectPath,
    activeProjectPath: activeRepoPath,
    activeTabId,
    tabs,
    activeTab,
    activeGlobalSurfaceId,
    activePanelId,
    activeProject: activePanelProject,
    panels: modulePanelContributions,
    globalNavigation,
    terminalSlots: allTerminalTabs.map(({ tab, projectPath }) => ({
      tab,
      projectPath,
      descriptor: terminalSlotDescriptor(tab.terminalId),
    })),
    trailingLayoutVisible: diffPanelVisible,
  }), [
    activeGlobalSurfaceId,
    activePanelId,
    activePanelProject,
    activeRepoPath,
    activeTab,
    activeTabId,
    allTerminalTabs,
    diffPanelVisible,
    groups,
    globalNavigation,
    modulePanelContributions,
    repos,
    sidebarVisible,
    tabDropProjectPath,
    tabs,
  ]);
  const canvasActions = useMemo<CanvasActions>(() => ({
    selectRepo: handleSelectRepo,
    addProject: handleAddProject,
    removeProject: handleRemoveProject,
    newModuleSession: handleNewModuleSession,
    openInEditor: handleOpenInEditor,
    selectTab: handleSelectSidebarTab,
    selectProjectTab: handleSelectSidebarProjectTab,
    closeTab: handleCloseTab,
    moveTab: handleMoveTab,
    newDefaultTerminal: () => handleNewShell(),
    newTerminal: handleNewShell,
    openPanel: handleOpenPanel,
    renameTab: handleRenameTab,
    reorderTab: handleReorderTab,
    renameGroup: handleRenameGroup,
    deleteGroup: handleDeleteGroup,
    moveToGroup: handleMoveToGroup,
    setTabDropProjectPath,
    toggleGlobalSurface: (surfaceId) => useUIStore.getState().toggleGlobalSurface(surfaceId),
    closeGlobalSurface: () => useUIStore.getState().closeGlobalSurface(),
    setTabTitle: (tabId, title) => {
      if (title) useTerminalStore.getState().updateTab(tabId, { label: title });
    },
  }), [
    handleAddProject,
    handleCloseTab,
    handleDeleteGroup,
    handleMoveTab,
    handleMoveToGroup,
    handleNewModuleSession,
    handleNewShell,
    handleOpenInEditor,
    handleOpenPanel,
    handleRemoveProject,
    handleRenameGroup,
    handleRenameTab,
    handleReorderTab,
    handleSelectRepo,
    handleSelectSidebarProjectTab,
    handleSelectSidebarTab,
  ]);
  const canvasPorts = useMemo<CanvasPorts>(() => ({
    projectPaths,
    surfaceCatalog: canvasSurfaceCatalog,
    terminalPresentationRegistry: activeTerminalPresentationRegistry,
    moduleHostServices: MODULE_HOST_SERVICES,
    moduleActivations,
  }), [activeTerminalPresentationRegistry, canvasSurfaceCatalog, moduleActivations, projectPaths]);
  return (
    <CanvasAdapterRuntimeProvider adapterId={canvasAdapterId}>
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

      <CanvasHost
        adapter={canvasAdapter}
        model={canvasModel}
        actions={canvasActions}
        ports={canvasPorts}
        workspace={workspaceCanvas}
      />
    </div>
    </CanvasAdapterRuntimeProvider>
  );
}
