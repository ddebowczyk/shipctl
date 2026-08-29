import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  ContributionId,
  GlobalNavigationContribution,
  PanelContribution,
} from "@shipctl/module-api";
import { getErrorMessage, type RepoInfo, type RepoGroup } from "@shipctl/core/platform";
import { useTerminalStore } from "@shipctl/core/terminal-host";
import {
  AgentSessionList,
  type AgentSessionItem,
} from "@shipctl/core/terminal-host/views";
import { useProjectFactsMap } from "@shipctl/core/host";
import { ModuleSidebarSurfaces } from "@shipctl/core/host/views";
import { useProjectSettingsStore } from "@shipctl/core/projects";
import { ProjectList } from "@shipctl/core/projects/views";
import { useNoticeStore } from "@shipctl/core/shared";
import { SidebarSectionToggle } from "@shipctl/core/shared/views";

import StandardWorkspaceNavigationFooter from "./StandardWorkspaceNavigationFooter.tsx";
import { resizedStandardWorkspaceNavigationWidth } from "./standardWorkspaceNavigationSizing.ts";
import { useStandardWorkspaceSettingsStore } from "./useStandardWorkspaceSettingsStore.ts";

const USAGE_SURFACE_ID = "core.usage" as ContributionId;
const HIDDEN_USAGE_SURFACE_IDS: ReadonlySet<ContributionId> = new Set([USAGE_SURFACE_ID]);

interface NavigationResizeState {
  pointerId: number;
  startPointerX: number;
  startWidth: number;
  currentWidth: number;
  availableWidth: number;
}

function availableNavigationWidth(navigation: HTMLDivElement): number {
  const navigationRect = navigation.getBoundingClientRect();
  const followingElement = navigation.nextElementSibling;
  if (followingElement instanceof HTMLElement) {
    return navigationRect.width + followingElement.getBoundingClientRect().width;
  }
  return navigation.parentElement?.getBoundingClientRect().width ?? navigationRect.width;
}

export interface StandardWorkspaceNavigationProps {
  readonly repos: readonly RepoInfo[];
  readonly groups: readonly RepoGroup[];
  readonly activeRepoPath: string | null;
  readonly activeTabId: string | null;
  readonly activePanelId: ContributionId | null;
  readonly activePanelProjectPath: string | null;
  readonly activeGlobalSurfaceId: ContributionId | null;
  readonly usagePanelVisible: boolean;
  readonly projectsPanelVisible: boolean;
  readonly onSelectRepo: (repoPath: string) => void | Promise<boolean>;
  readonly onAddProject: (repoPath: string) => Promise<void>;
  readonly onRemoveProject: (repoPath: string) => void | Promise<void>;
  readonly onNewModuleSession: () => void;
  readonly onOpenInEditor: (repoPath: string) => void | Promise<void>;
  readonly onSelectTab: (tabId: string) => void;
  readonly onSelectProjectTab: (repoPath: string, tabId: string) => void | Promise<void>;
  readonly onCloseTab: (tabId: string) => void;
  readonly onMoveTab: (tabId: string, destinationPath: string) => void | Promise<void>;
  readonly onNewShell: () => void;
  readonly onRenameGroup: (groupId: string, newName: string) => void | Promise<void>;
  readonly onDeleteGroup: (groupId: string) => void | Promise<void>;
  readonly onMoveToGroup: (repoPath: string, groupId: string | null) => Promise<void>;
  readonly onOpenPanel: (panel: PanelContribution) => void | Promise<void>;
  readonly onToggleGlobalSurface: (surfaceId: ContributionId) => void;
  readonly tabDropProjectPath: string | null;
  readonly globalNavigation: readonly GlobalNavigationContribution[];
}

export default function StandardWorkspaceNavigation({
  repos,
  groups,
  activeRepoPath,
  activeTabId,
  activePanelId,
  activePanelProjectPath,
  activeGlobalSurfaceId,
  usagePanelVisible,
  projectsPanelVisible,
  onSelectRepo,
  onAddProject,
  onRemoveProject,
  onNewModuleSession,
  onOpenInEditor,
  onSelectTab,
  onSelectProjectTab,
  onCloseTab,
  onMoveTab,
  onNewShell,
  onRenameGroup,
  onDeleteGroup,
  onMoveToGroup,
  onOpenPanel,
  onToggleGlobalSurface,
  tabDropProjectPath,
  globalNavigation,
}: StandardWorkspaceNavigationProps) {
  // Projects always starts expanded on launch; collapsing is per-session only.
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const projectState = useTerminalStore((state) => state.projectState);
  const tabActivity = useTerminalStore((state) => state.tabActivity);
  const projectFacts = useProjectFactsMap(repos);
  const projectSettings = useProjectSettingsStore((state) => state.settings);
  const projectSettingsLoaded = useProjectSettingsStore((state) => state.hasLoaded);
  const loadProjectSettings = useProjectSettingsStore((state) => state.loadSettings);
  const sidebarSettings = useStandardWorkspaceSettingsStore((state) => state.settings);
  const sidebarSettingsLoaded = useStandardWorkspaceSettingsStore((state) => state.hasLoaded);
  const sidebarSettingsSaving = useStandardWorkspaceSettingsStore((state) => state.isSaving);
  const loadSidebarSettings = useStandardWorkspaceSettingsStore((state) => state.loadSettings);
  const updateSidebarSettings = useStandardWorkspaceSettingsStore((state) => state.updateSettings);
  const [previewSidebarWidth, setPreviewSidebarWidth] = useState<number | null>(null);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const navigationResizeStateRef = useRef<NavigationResizeState | null>(null);

  // Only subscribe to the fields that affect the sidebar activity indicators.
  // Returns a stable string so the selector doesn't trigger re-renders when
  // unrelated tabActivity fields change.
  const activityKey = useTerminalStore((state) => {
    const parts: string[] = [];
    for (const [terminalId, activity] of Object.entries(state.tabActivity)) {
      if (activity.active || activity.bell || !activity.alive) {
        parts.push(`${terminalId}:${activity.active ? "a" : ""}${activity.bell ? "b" : ""}${!activity.alive ? `x${activity.exitCode}` : ""}`);
      }
    }
    return parts.join(",");
  });

  const projectActivity = useMemo(() => {
    const activity: Record<string, { terminalCount: number; hasAttention: boolean; hasCrash: boolean; hasActive: boolean }> = {};
    for (const repo of repos) {
      const project = projectState[repo.path];
      const repoTabs = project?.tabs ?? [];
      let hasAttention = false;
      let hasCrash = false;
      let hasActive = false;
      let liveTerminalCount = 0;
      for (const tab of repoTabs) {
        if (tab.kind !== "terminal") continue;
        const tabState = tabActivity[tab.terminalId];
        if (tabState) {
          if (tabState.bell) hasAttention = true;
          if (tabState.active) hasActive = true;
          if (!tabState.alive && tabState.exitCode !== 0) hasCrash = true;
        }
        if (!tabState || tabState.alive) liveTerminalCount += 1;
      }
      activity[repo.path] = {
        terminalCount: liveTerminalCount,
        hasAttention,
        hasCrash,
        hasActive,
      };
    }
    return activity;
  }, [repos, projectState, activityKey, tabActivity]);

  const agentSessions = useMemo<AgentSessionItem[]>(() => {
    const repoNames = new Map(repos.map((repo) => [repo.path, repo.name]));
    const sessions: AgentSessionItem[] = [];
    for (const [repoPath, state] of Object.entries(projectState)) {
      const projectName = repoNames.get(repoPath) ?? repoPath.split("/").filter(Boolean).pop() ?? repoPath;
      const branchName = projectFacts[repoPath]?.revision?.label.trim() || null;
      for (const tab of state.tabs) {
        if (tab.kind !== "terminal" || !tab.modulePresentation?.showInSessionList) continue;
        const activity = tabActivity[tab.terminalId];
        if (activity && !activity.alive && activity.exitCode === 0) continue;
        sessions.push({ tab, projectPath: repoPath, projectName, branchName });
      }
    }

    return sessions.sort((left, right) => {
      const leftIsActive = left.projectPath === activeRepoPath && left.tab.id === activeTabId;
      const rightIsActive = right.projectPath === activeRepoPath && right.tab.id === activeTabId;
      if (leftIsActive !== rightIsActive) return leftIsActive ? -1 : 1;

      const leftActivity = tabActivity[left.tab.terminalId];
      const rightActivity = tabActivity[right.tab.terminalId];
      const leftNeedsAttention = Boolean(leftActivity?.bell || (leftActivity && !leftActivity.alive && leftActivity.exitCode !== 0));
      const rightNeedsAttention = Boolean(rightActivity?.bell || (rightActivity && !rightActivity.alive && rightActivity.exitCode !== 0));
      if (leftNeedsAttention !== rightNeedsAttention) return leftNeedsAttention ? -1 : 1;

      const leftIsStreaming = Boolean(leftActivity?.active);
      const rightIsStreaming = Boolean(rightActivity?.active);
      if (leftIsStreaming !== rightIsStreaming) return leftIsStreaming ? -1 : 1;

      const leftAlive = leftActivity?.alive ?? true;
      const rightAlive = rightActivity?.alive ?? true;
      if (leftAlive !== rightAlive) return leftAlive ? -1 : 1;

      return left.projectName.localeCompare(right.projectName) || left.tab.label.localeCompare(right.tab.label);
    });
  }, [repos, projectState, tabActivity, projectFacts, activeRepoPath, activeTabId]);

  const handleToggleProjects = useCallback(() => {
    setProjectsCollapsed((value) => !value);
  }, []);

  useEffect(() => {
    if (!projectSettingsLoaded) void loadProjectSettings();
  }, [projectSettingsLoaded, loadProjectSettings]);

  useEffect(() => {
    if (!sidebarSettingsLoaded) void loadSidebarSettings();
  }, [sidebarSettingsLoaded, loadSidebarSettings]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || sidebarSettingsSaving) return;
    const navigation = event.currentTarget.parentElement;
    if (!(navigation instanceof HTMLDivElement)) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startWidth = navigation.getBoundingClientRect().width;
    navigationResizeStateRef.current = {
      pointerId: event.pointerId,
      startPointerX: event.clientX,
      startWidth,
      currentWidth: startWidth,
      availableWidth: availableNavigationWidth(navigation),
    };
    setPreviewSidebarWidth(startWidth);
    setIsResizingSidebar(true);
  }, [sidebarSettingsSaving]);

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = navigationResizeStateRef.current;
    if (resizeState?.pointerId !== event.pointerId) return;
    event.preventDefault();
    const width = resizedStandardWorkspaceNavigationWidth(
      resizeState.startWidth,
      resizeState.startPointerX,
      event.clientX,
      resizeState.availableWidth,
    );
    resizeState.currentWidth = width;
    setPreviewSidebarWidth(width);
  }, []);

  const handleResizePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = navigationResizeStateRef.current;
    if (resizeState?.pointerId !== event.pointerId) return;
    navigationResizeStateRef.current = null;
    setIsResizingSidebar(false);
    if (resizeState.currentWidth !== resizeState.startWidth) {
      void updateSidebarSettings({ width: resizeState.currentWidth }).catch((error) => {
        useNoticeStore.getState().pushNotice({
          tone: "error",
          title: "Couldn't save sidebar width",
          message: getErrorMessage(error),
        });
      });
    }
    setPreviewSidebarWidth(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, [updateSidebarSettings]);

  const cancelResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (navigationResizeStateRef.current?.pointerId !== event.pointerId) return;
    navigationResizeStateRef.current = null;
    setPreviewSidebarWidth(null);
    setIsResizingSidebar(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleResizeLostPointerCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (navigationResizeStateRef.current?.pointerId !== event.pointerId) return;
    navigationResizeStateRef.current = null;
    setPreviewSidebarWidth(null);
    setIsResizingSidebar(false);
  }, []);

  const sidebarStyle = useMemo(() => ({
    width: `${previewSidebarWidth ?? sidebarSettings.width}px`,
    fontFamily: sidebarSettings.fontFamily,
    "--text-body": `${sidebarSettings.fontSize}px`,
    "--text-label": `${Math.max(10, sidebarSettings.fontSize - 2)}px`,
    "--text-badge": `${Math.max(9, sidebarSettings.fontSize - 3)}px`,
  }) as CSSProperties, [previewSidebarWidth, sidebarSettings]);

  return (
    <div
      className={`app-sidebar${isResizingSidebar ? " app-sidebar--resizing" : ""} shrink-0 flex flex-col h-full pr-4 mr-4 border-r border-[var(--glass-border)]`}
      style={sidebarStyle}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        className="app-sidebar__resize-handle"
        role="separator"
        aria-label="Resize left navigation"
        aria-orientation="vertical"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onPointerCancel={cancelResize}
        onLostPointerCapture={handleResizeLostPointerCapture}
      />
      <div className="flex-1 overflow-y-auto min-h-0">
        {projectSettings.showAgentSessionsInSidebar && (
          <AgentSessionList
            sessions={agentSessions}
            activeRepoPath={activeRepoPath}
            activeTabId={activeTabId}
            onSelectSession={onSelectProjectTab}
            onMoveTab={onMoveTab}
          />
        )}
        {projectsPanelVisible && (
          <div className="sidebar-section px-2 pb-2">
            <SidebarSectionToggle
              label="Projects"
              collapsed={projectsCollapsed}
              badge={repos.length}
              onToggle={handleToggleProjects}
            />
            {!projectsCollapsed && (
              <ProjectList
                repos={[...repos]}
                groups={[...groups]}
                activeRepoPath={activeRepoPath}
                activeTabId={activeTabId}
                activePanelId={activePanelId}
                activePanelProjectPath={activePanelProjectPath}
                projectActivity={projectActivity}
                onSelectRepo={onSelectRepo}
                onAddProject={onAddProject}
                onRemoveProject={onRemoveProject}
                onNewModuleSession={onNewModuleSession}
                onOpenInEditor={onOpenInEditor}
                onSelectTab={onSelectTab}
                onCloseTab={onCloseTab}
                onMoveTab={onMoveTab}
                onNewShell={onNewShell}
                onRenameGroup={onRenameGroup}
                onDeleteGroup={onDeleteGroup}
                onMoveToGroup={onMoveToGroup}
                onOpenPanel={onOpenPanel}
                tabDropProjectPath={tabDropProjectPath}
              />
            )}
          </div>
        )}
      </div>
      <ModuleSidebarSurfaces
        onToggleGlobalSurface={onToggleGlobalSurface}
        hiddenSurfaceIds={usagePanelVisible ? undefined : HIDDEN_USAGE_SURFACE_IDS}
      />
      <StandardWorkspaceNavigationFooter
        navigation={globalNavigation}
        activeSurfaceId={activeGlobalSurfaceId}
        onToggleSurface={onToggleGlobalSurface}
      />
    </div>
  );
}
