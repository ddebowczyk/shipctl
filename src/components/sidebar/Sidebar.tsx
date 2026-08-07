import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { GlobalNavigationContribution } from "@shep/module-api";
import type { RepoInfo, RepoGroup, CommandState } from "../../lib/types";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useCommandStore } from "../../stores/useCommandStore";
import { useProjectFactsMap } from "../../core/modules";
import { useProjectSettingsStore } from "../../stores/useProjectSettingsStore";
import { useSidebarSettingsStore } from "../../stores/useSidebarSettingsStore";
import ProjectList from "./ProjectList";
import SidebarFooter from "./SidebarFooter";
import SidebarUsage from "./SidebarUsage";
import AgentSessionList, { type AgentSessionItem } from "./AgentSessionList";
import SidebarSectionToggle from "./SidebarSectionToggle";

interface SidebarProps {
  repos: RepoInfo[];
  groups: RepoGroup[];
  activeRepoPath: string | null;
  activeTabId: string | null;
  commands: CommandState[];
  onSelectRepo: (repoPath: string) => void;
  onAddProject: (repoPath: string) => Promise<void>;
  onRemoveProject: (repoPath: string) => void;
  onNewAssistant: () => void;
  onOpenInEditor: (repoPath: string) => void;
  onSelectTab: (tabId: string) => void;
  onSelectProjectTab: (repoPath: string, tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onMoveTab: (tabId: string, destinationPath: string) => void | Promise<void>;
  onNewShell: () => void;
  onRenameGroup: (groupId: string, newName: string) => void;
  onDeleteGroup: (groupId: string) => void;
  onMoveToGroup: (repoPath: string, groupId: string | null) => Promise<void>;
  tabDropProjectPath: string | null;
  globalNavigation: readonly GlobalNavigationContribution[];
}

export default function Sidebar({
  repos,
  groups,
  activeRepoPath,
  activeTabId,
  commands,
  onSelectRepo,
  onAddProject,
  onRemoveProject,
  onNewAssistant,
  onOpenInEditor,
  onSelectTab,
  onSelectProjectTab,
  onCloseTab,
  onMoveTab,
  onNewShell,
  onRenameGroup,
  onDeleteGroup,
  onMoveToGroup,
  tabDropProjectPath,
  globalNavigation,
}: SidebarProps) {
  // Projects always starts expanded on launch; collapsing is per-session only.
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const projectState = useTerminalStore((s) => s.projectState);
  const projectCommands = useCommandStore((s) => s.projectCommands);
  const tabActivity = useTerminalStore((s) => s.tabActivity);
  const projectFacts = useProjectFactsMap(repos);
  const projectSettings = useProjectSettingsStore((s) => s.settings);
  const projectSettingsLoaded = useProjectSettingsStore((s) => s.hasLoaded);
  const loadProjectSettings = useProjectSettingsStore((s) => s.loadSettings);
  const sidebarSettings = useSidebarSettingsStore((s) => s.settings);
  const sidebarSettingsLoaded = useSidebarSettingsStore((s) => s.hasLoaded);
  const loadSidebarSettings = useSidebarSettingsStore((s) => s.loadSettings);

  // Only subscribe to the fields that affect the sidebar activity indicators.
  // Returns a stable string so the selector doesn't trigger re-renders when
  // unrelated tabActivity fields change.
  const activityKey = useTerminalStore((s) => {
    const parts: string[] = [];
    for (const [ptyId, a] of Object.entries(s.tabActivity)) {
      if (a.active || a.bell || !a.alive) {
        parts.push(`${ptyId}:${a.active ? "a" : ""}${a.bell ? "b" : ""}${!a.alive ? `x${a.exitCode}` : ""}`);
      }
    }
    return parts.join(",");
  });

  const projectActivity = useMemo(() => {
    const tabActivity = useTerminalStore.getState().tabActivity;
    const activity: Record<string, { terminalCount: number; runningCount: number; hasAttention: boolean; hasCrash: boolean; hasActive: boolean }> = {};
    for (const repo of repos) {
      const ps = projectState[repo.path];
      const repoTabs = ps?.tabs ?? [];
      const cmds = projectCommands[repo.path] ?? [];
      let hasAttention = false;
      let hasCrash = false;
      let hasActive = false;
      let liveTerminalCount = 0;
      for (const tab of repoTabs) {
        if (tab.kind !== "terminal" && tab.kind !== "assistant") continue;
        const a = tabActivity[tab.ptyId];
        if (a) {
          if (a.bell) hasAttention = true;
          if (a.active) hasActive = true;
          if (!a.alive && a.exitCode !== 0) hasCrash = true;
        }
        if (!a || a.alive) liveTerminalCount += 1;
      }
      activity[repo.path] = {
        terminalCount: liveTerminalCount,
        runningCount: cmds.filter((c) => c.status === "running").length,
        hasAttention,
        hasCrash,
        hasActive,
      };
    }
    return activity;
  }, [repos, projectState, projectCommands, activityKey]);

  const agentSessions = useMemo<AgentSessionItem[]>(() => {
    const repoNames = new Map(repos.map((repo) => [repo.path, repo.name]));

    const sessions: AgentSessionItem[] = [];
    for (const [repoPath, state] of Object.entries(projectState)) {
      const projectName = repoNames.get(repoPath) ?? repoPath.split("/").filter(Boolean).pop() ?? repoPath;
      const branchName = projectFacts[repoPath]?.revision?.label.trim() || null;
      for (const tab of state.tabs) {
        if (tab.kind !== "assistant") continue;
        const activity = tabActivity[tab.ptyId];
        if (activity && !activity.alive && activity.exitCode === 0) continue;
        sessions.push({ tab, projectPath: repoPath, projectName, branchName });
      }
    }

    return sessions.sort((a, b) => {
      const aIsActive = a.projectPath === activeRepoPath && a.tab.id === activeTabId;
      const bIsActive = b.projectPath === activeRepoPath && b.tab.id === activeTabId;
      if (aIsActive !== bIsActive) return aIsActive ? -1 : 1;

      const aActivity = tabActivity[a.tab.ptyId];
      const bActivity = tabActivity[b.tab.ptyId];
      const aNeedsAttention = Boolean(aActivity?.bell || (aActivity && !aActivity.alive && aActivity.exitCode !== 0));
      const bNeedsAttention = Boolean(bActivity?.bell || (bActivity && !bActivity.alive && bActivity.exitCode !== 0));
      if (aNeedsAttention !== bNeedsAttention) return aNeedsAttention ? -1 : 1;

      const aIsStreaming = Boolean(aActivity?.active);
      const bIsStreaming = Boolean(bActivity?.active);
      if (aIsStreaming !== bIsStreaming) return aIsStreaming ? -1 : 1;

      const aAlive = aActivity?.alive ?? true;
      const bAlive = bActivity?.alive ?? true;
      if (aAlive !== bAlive) return aAlive ? -1 : 1;

      return a.projectName.localeCompare(b.projectName) || a.tab.label.localeCompare(b.tab.label);
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

  const sidebarStyle = useMemo(() => ({
    width: `${sidebarSettings.width}px`,
    fontFamily: sidebarSettings.fontFamily,
    "--text-body": `${sidebarSettings.fontSize}px`,
    "--text-label": `${Math.max(10, sidebarSettings.fontSize - 2)}px`,
    "--text-badge": `${Math.max(9, sidebarSettings.fontSize - 3)}px`,
  }) as CSSProperties, [sidebarSettings]);

  return (
    <div
      className="app-sidebar shrink-0 flex flex-col h-full pr-4 mr-4 border-r border-[var(--glass-border)]"
      style={sidebarStyle}
      onContextMenu={(e) => e.preventDefault()}
    >
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
        <div className="sidebar-section px-2 pb-2">
          <SidebarSectionToggle
            label="Projects"
            collapsed={projectsCollapsed}
            badge={repos.length}
            onToggle={handleToggleProjects}
          />
          {!projectsCollapsed && (
            <ProjectList
              repos={repos}
              groups={groups}
              activeRepoPath={activeRepoPath}
              activeTabId={activeTabId}
              commands={commands}
              projectActivity={projectActivity}
              onSelectRepo={onSelectRepo}
              onAddProject={onAddProject}
              onRemoveProject={onRemoveProject}
              onNewAssistant={onNewAssistant}
              onOpenInEditor={onOpenInEditor}
              onSelectTab={onSelectTab}
              onCloseTab={onCloseTab}
              onMoveTab={onMoveTab}
              onNewShell={onNewShell}
              onRenameGroup={onRenameGroup}
              onDeleteGroup={onDeleteGroup}
              onMoveToGroup={onMoveToGroup}
              tabDropProjectPath={tabDropProjectPath}
            />
          )}
        </div>
      </div>
      <SidebarUsage />
      <SidebarFooter navigation={globalNavigation} />
    </div>
  );
}
