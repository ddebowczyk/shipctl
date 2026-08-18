import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import type { RepoInfo, RepoGroup, TerminalTabData } from "@shipctl/core/platform";
import { SquareTerminal } from "lucide-react";
import { tabKindMeta } from "@shipctl/core/shared/views";
import { useTerminalStore } from "@shipctl/core/terminal-host";
import { useRepoStore } from "./useRepoStore.ts";
import { useNoticeStore } from "@shipctl/core/shared";
import { getErrorMessage, selectProjectDirectory } from "@shipctl/core/platform";
import ProjectItem from "./ProjectItem.tsx";
import GroupHeader from "./GroupHeader.tsx";
import { CollapsibleSection } from "@shipctl/core/shared/views";
import { ModuleSessionList } from "@shipctl/core/host/views";
import { TerminalList } from "@shipctl/core/terminal-host/views";
import {
  useProjectFactsMap,
} from "@shipctl/core/host";
import type {
  ActivatedWorkspaceContribution,
  CanvasProjectNavigationSurface,
} from "@shipctl/core/host";
import {
  ModuleProjectNavigationSurfaces,
} from "@shipctl/core/host/views";
import { groupProjects } from "@shipctl/core/projects";
import type {
  ModuleActivationContext,
  ModuleId,
  ProjectActionContribution,
} from "@shipctl/module-api";

interface ProjectListProps {
  repos: RepoInfo[];
  groups: RepoGroup[];
  activeRepoPath: string | null;
  activeTabId: string | null;
  projectActivity: Record<string, { terminalCount: number; hasAttention: boolean; hasCrash: boolean; hasActive: boolean }>;
  onSelectRepo: (repoPath: string) => void;
  onAddProject: (repoPath: string) => Promise<void>;
  onRemoveProject: (repoPath: string) => void;
  onNewModuleSession: () => void;
  onOpenInEditor: (repoPath: string) => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onMoveTab: (tabId: string, destinationPath: string) => void | Promise<void>;
  onNewShell: () => void;
  onRenameGroup: (groupId: string, newName: string) => void;
  onDeleteGroup: (groupId: string) => void;
  onMoveToGroup: (repoPath: string, groupId: string | null) => Promise<void>;
  tabDropProjectPath: string | null;
  projectNavigationContributions: readonly CanvasProjectNavigationSurface[];
  projectActionContributions: readonly ActivatedWorkspaceContribution<
    ProjectActionContribution
  >[];
  moduleActivations: ReadonlyMap<ModuleId, ModuleActivationContext>;
}

export default function ProjectList({
  repos,
  groups,
  activeRepoPath,
  activeTabId,
  projectActivity,
  onSelectRepo,
  onAddProject,
  onRemoveProject,
  onNewModuleSession,
  onOpenInEditor,
  onSelectTab,
  onCloseTab,
  onMoveTab,
  onNewShell,
  onRenameGroup,
  onDeleteGroup,
  onMoveToGroup,
  tabDropProjectPath,
  projectNavigationContributions,
  projectActionContributions,
  moduleActivations,
}: ProjectListProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(activeRepoPath ? [activeRepoPath] : []),
  );
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const createGroupSubmittedRef = useRef(false);
  const pendingMoveRepoPath = useRef<string | null>(null);

  // Auto-expand the active project when activeRepoPath changes externally
  // (e.g. session restore, programmatic selection). Legitimate useEffect:
  // syncing local UI state in response to an external prop change.
  useEffect(() => {
    if (!activeRepoPath) return;
    setExpandedPaths((prev) => {
      if (prev.has(activeRepoPath)) return prev;
      return new Set(prev).add(activeRepoPath);
    });
    // Also expand the parent group if the active repo belongs to one
    const activeRepo = repos.find((r) => r.path === activeRepoPath);
    if (activeRepo?.group) {
      setExpandedGroups((prev) => {
        if (prev.has(activeRepo.group!)) return prev;
        return new Set(prev).add(activeRepo.group!);
      });
    }
  }, [activeRepoPath, repos]);

  const handleProjectClick = (repoPath: string) => {
    if (repoPath === activeRepoPath) {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(repoPath)) next.delete(repoPath);
        else next.add(repoPath);
        return next;
      });
    } else {
      setExpandedPaths((prev) => {
        if (prev.has(repoPath)) return prev;
        return new Set(prev).add(repoPath);
      });
      // Auto-expand the group containing the clicked repo
      const repo = repos.find((r) => r.path === repoPath);
      if (repo?.group) {
        setExpandedGroups((prev) => {
          if (prev.has(repo.group!)) return prev;
          return new Set(prev).add(repo.group!);
        });
      }
      onSelectRepo(repoPath);
    }
  };

  const handleToggleGroup = useCallback((groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const handleAddClick = async () => {
    const selected = await selectProjectDirectory();
    if (selected) {
      onAddProject(selected);
    }
  };

  const handleCreateGroupSubmit = useCallback(() => {
    if (createGroupSubmittedRef.current) return;
    createGroupSubmittedRef.current = true;
    const trimmed = newGroupName.trim();
    const repoToMove = pendingMoveRepoPath.current;
    pendingMoveRepoPath.current = null;
    if (trimmed && repoToMove) {
      useRepoStore.getState().createGroup(trimmed)
        .then((group) => onMoveToGroup(repoToMove, group.id))
        .catch((error) => {
          useNoticeStore.getState().pushNotice({
            tone: "error",
            title: "Couldn't create group",
            message: getErrorMessage(error),
          });
        });
    }
    setCreatingGroup(false);
    setNewGroupName("");
  }, [newGroupName, onMoveToGroup]);

  // Get tabs for the active project (stable ref from store)
  const projectTabs = useTerminalStore(
    (s) => activeRepoPath ? s.projectState[activeRepoPath]?.tabs ?? null : null,
  );

  const sessionTabs = useMemo(() => {
    if (!projectTabs) return [];
    return projectTabs.filter((tab): tab is TerminalTabData =>
      tab.kind === "terminal" && tab.modulePresentation?.showInSessionList === true);
  }, [projectTabs]);

  const shellTabs = useMemo(() => {
    if (!projectTabs) return [];
    return projectTabs.filter((tab): tab is TerminalTabData =>
      tab.kind === "terminal" && !tab.modulePresentation?.showInSessionList);
  }, [projectTabs]);

  const projectFacts = useProjectFactsMap(repos);

  // Build grouped layout
  const { sections: groupedSections, ungroupedRepos } = useMemo(
    () => groupProjects(repos, groups, projectFacts),
    [repos, groups, projectFacts],
  );

  const groupActivity = useMemo(() => {
    const result: Record<string, { hasAttention: boolean; hasCrash: boolean; hasActivity: boolean; hasActive: boolean }> = {};
    for (const { group, repos: groupRepos } of groupedSections) {
      let hasAttention = false;
      let hasCrash = false;
      let hasActivity = false;
      let hasActive = false;
      for (const repo of groupRepos) {
        const a = projectActivity[repo.path];
        if (a) {
          if (a.terminalCount > 0) hasActivity = true;
          if (a.hasAttention) hasAttention = true;
          if (a.hasCrash) hasCrash = true;
          if (a.hasActive) hasActive = true;
        }
      }
      result[group.id] = { hasAttention, hasCrash, hasActivity, hasActive };
    }
    return result;
  }, [groupedSections, projectActivity]);

  const renderRepoItem = (repo: RepoInfo) => {
    const isActive = repo.path === activeRepoPath;
    const isExpanded = isActive && expandedPaths.has(repo.path);
    const worktreeParent = projectFacts[repo.path]?.lineage?.parentLabel ?? null;
    return (
      <div key={repo.path}>
        <ProjectItem
          repo={repo}
          isActive={isActive}
          isExpanded={isExpanded}
          activity={projectActivity[repo.path]}
          worktreeParent={worktreeParent}
          groups={groups}
          onOpenInEditor={() => onOpenInEditor(repo.path)}
          onRemove={() => onRemoveProject(repo.path)}
          onClick={() => handleProjectClick(repo.path)}
          onAddProject={onAddProject}
          onMoveToGroup={onMoveToGroup}
          projectActionContributions={projectActionContributions}
          moduleActivations={moduleActivations}
          isDropTarget={tabDropProjectPath === repo.path}
          onNewGroupForRepo={(repoPath) => {
            pendingMoveRepoPath.current = repoPath;
            createGroupSubmittedRef.current = false;
            setCreatingGroup(true);
          }}
        />
        {isExpanded && (
          <div className="mt-1 mb-2 flex flex-col gap-0.5 pl-2">
            <CollapsibleSection
              label="Agents"
              icon={<SquareTerminal size={14} />}
              badge={sessionTabs.length || null}
              hasItems={sessionTabs.length > 0}
              onAdd={onNewModuleSession}
            >
              <ModuleSessionList
                sessions={sessionTabs}
                activeTabId={activeTabId}
                onSelectTab={onSelectTab}
                onCloseTab={onCloseTab}
                projectPath={repo.path}
                onMoveTab={onMoveTab}
              />
            </CollapsibleSection>

            <CollapsibleSection
              label={tabKindMeta.terminal.label + "s"}
              icon={tabKindMeta.terminal.icon(14)}
              badge={shellTabs.length || null}
              hasItems={shellTabs.length > 0}
              onAdd={onNewShell}
            >
              <TerminalList
                tabs={shellTabs}
                activeTabId={activeTabId}
                onSelectTab={onSelectTab}
                onCloseTab={onCloseTab}
                projectPath={repo.path}
                onMoveTab={onMoveTab}
              />
            </CollapsibleSection>

            <ModuleProjectNavigationSurfaces
              contributions={projectNavigationContributions}
              project={{ id: repo.path, name: repo.name, path: repo.path }}
              activeTabId={activeTabId}
              moduleActivations={moduleActivations}
            />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-0.5 pb-2">
      {groupedSections.map(({ group, repos: groupRepos }) => {
        const isGroupExpanded = expandedGroups.has(group.id);
        return (
          <div key={group.id}>
            <GroupHeader
              group={group}
              isExpanded={isGroupExpanded}
              activity={groupActivity[group.id]}
              onToggle={() => handleToggleGroup(group.id)}
              onRename={onRenameGroup}
              onDelete={onDeleteGroup}
            />
            {isGroupExpanded && (
              <div className="pl-4">
                {groupRepos.length === 0 ? (
                  <div className="group-empty-hint">No projects in this group</div>
                ) : (
                  groupRepos.map(renderRepoItem)
                )}
              </div>
            )}
          </div>
        );
      })}

      {ungroupedRepos.map(renderRepoItem)}

      <button className="btn-ghost w-full mt-1" onClick={handleAddClick}>
        <span>+</span>
        <span>Add Project</span>
      </button>
      {creatingGroup && (
        <form
          className="group-create-form"
          onSubmit={(e) => {
            e.preventDefault();
            handleCreateGroupSubmit();
          }}
        >
          <input
            className="group-create-form__input"
            type="text"
            placeholder="Group name"
            autoFocus
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onBlur={handleCreateGroupSubmit}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                createGroupSubmittedRef.current = true;
                setCreatingGroup(false);
                setNewGroupName("");
              }
            }}
          />
        </form>
      )}
    </div>
  );
}
