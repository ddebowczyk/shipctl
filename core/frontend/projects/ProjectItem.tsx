import { useState, useCallback, useMemo } from "react";
import type {
  ModuleActivationContext,
  ModuleActivationId,
  ModuleId,
  ProjectAction,
  ProjectActionContribution,
  ProjectSurfaceAction,
} from "@shipctl/module-api";
import type { RepoInfo, RepoGroup } from "@shipctl/core/platform";
import { getEditorLabel } from "@shipctl/core/settings";
import { useEditorStore } from "@shipctl/core/settings";
import {
  Folder,
  FolderOpen,
  FolderInput,
  GitFork,
  Plus,
  Copy,
  Trash2,
  SquareArrowOutUpRight,
  Sparkles,
  Check,
} from "lucide-react";
import { createPortal } from "react-dom";
import { ContextMenu } from "@shipctl/core/shared/views";
import type { ContextMenuItem } from "@shipctl/core/shared/views";
import { useNoticeStore } from "@shipctl/core/shared";
import { getErrorMessage } from "@shipctl/core/platform";
import { handleActionKey } from "@shipctl/core/shared";
import { revealInFinder } from "@shipctl/core/platform";
import {
  useModuleProjectActions,
} from "@shipctl/core/host";
import type { ActivatedWorkspaceContribution } from "@shipctl/core/host";
import {
  ModuleProjectActionSurface,
} from "@shipctl/core/host/views";
import { ActivityIndicator, getAggregateActivityStatus } from "@shipctl/core/shared/views";

interface ProjectItemProps {
  repo: RepoInfo;
  isActive: boolean;
  isExpanded: boolean;
  activity?: { terminalCount: number; hasAttention: boolean; hasCrash: boolean; hasActive: boolean };
  worktreeParent?: string | null;
  groups: RepoGroup[];
  onClick: () => void;
  onRemove: () => void;
  onOpenInEditor: () => void;
  onAddProject: (repoPath: string) => Promise<void>;
  onMoveToGroup: (repoPath: string, groupId: string | null) => Promise<void>;
  onNewGroupForRepo: (repoPath: string) => void;
  isDropTarget: boolean;
  projectActionContributions: readonly ActivatedWorkspaceContribution<
    ProjectActionContribution
  >[];
  moduleActivations: ReadonlyMap<ModuleId, ModuleActivationContext>;
}

export default function ProjectItem({
  repo,
  isActive,
  isExpanded,
  activity,
  worktreeParent,
  groups,
  onClick,
  onRemove,
  onOpenInEditor,
  onAddProject,
  onMoveToGroup,
  onNewGroupForRepo,
  isDropTarget,
  projectActionContributions,
  moduleActivations,
}: ProjectItemProps) {
  const activityStatus = getAggregateActivityStatus({
    hasCrash: activity?.hasCrash,
    hasAttention: activity?.hasAttention,
    hasActive: activity?.hasActive,
    hasRunning: Boolean(activity && activity.terminalCount > 0),
  });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [actionSurface, setActionSurface] = useState<{
    action: ProjectSurfaceAction;
    moduleId: ModuleId;
    activationId: ModuleActivationId;
    position: { x: number; y: number };
  } | null>(null);
  const projectRef = useMemo(() => ({
    id: repo.path,
    name: repo.name,
    path: repo.path,
    groupId: repo.group,
  }), [repo.group, repo.name, repo.path]);
  const projectActions = useModuleProjectActions(
    projectRef,
    moduleActivations,
    projectActionContributions,
  );
  const preferredEditor = useEditorStore((s) => s.settings.preferredEditor);
  const pushNotice = useNoticeStore((s) => s.pushNotice);
  const preferredEditorLabel = getEditorLabel(preferredEditor);
  const editorActionLabel = preferredEditorLabel
    ? `Open in ${preferredEditorLabel}`
    : "Set Editor Preference";

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
    void projectActions.refresh();
  }, [projectActions]);

  const handleClose = useCallback(() => {
    setMenu(null);
  }, []);

  // Build "Move to" submenu children
  const otherGroups = groups.filter((g) => g.id !== repo.group);
  const moveToChildren: ContextMenuItem[] = [
    ...otherGroups.map((g) => ({
      label: g.name,
      onClick: () => onMoveToGroup(repo.path, g.id),
    })),
    ...(otherGroups.length > 0 || repo.group ? [{ separator: true, label: "_sep_new" }] : []),
    {
      label: "New Group",
      onClick: () => onNewGroupForRepo(repo.path),
    },
    ...(repo.group
      ? [
          { separator: true, label: "_sep_remove" },
          {
            label: "Remove from group",
            onClick: () => onMoveToGroup(repo.path, null),
          },
        ]
      : []),
  ];

  const actionMenuItem = (
    action: ProjectAction,
    moduleId: ModuleId,
    activationId: ModuleActivationId,
  ): ContextMenuItem => ({
    label: action.label,
    icon: action.selected === undefined
      ? action.icon?.name === "plus"
        ? <Plus size={14} />
        : undefined
      : <Check size={14} className={action.selected ? "opacity-100" : "opacity-0"} />,
    keepOpen: action.keepOpen,
    danger: action.danger,
    onClick: () => {
      if (action.surface) {
        setActionSurface({
          action,
          moduleId,
          activationId,
          position: menu ?? { x: 200, y: 200 },
        });
        return;
      }
      void Promise.resolve()
        .then(() => action.run())
        .catch(() => undefined);
    },
  });
  const contributedActionItems: ContextMenuItem[] = projectActions.groups.flatMap((group) => {
    const actions = group.actions.map((action) => (
      actionMenuItem(action, group.moduleId, group.activationId)
    ));
    return group.label === null
      ? actions
      : [{
          label: group.label,
          icon: group.icon?.name === "sparkles" ? <Sparkles size={14} /> : undefined,
          children: actions,
        }];
  });

  const menuItems: ContextMenuItem[] = [
    {
      label: editorActionLabel,
      icon: <SquareArrowOutUpRight size={14} />,
      onClick: onOpenInEditor,
    },
    {
      label: "Open in Finder",
      icon: <FolderOpen size={14} />,
      onClick: () => {
        revealInFinder(repo.path)
          .catch((error) => {
            pushNotice({
              tone: "error",
              title: "Couldn't open in Finder",
              message: getErrorMessage(error),
            });
          });
      },
    },
    {
      label: "Copy Path",
      icon: <Copy size={14} />,
      onClick: () => {
        navigator.clipboard.writeText(repo.path)
          .then(() => {
            pushNotice({
              tone: "success",
              title: "Copied project path",
              message: repo.path,
            });
          })
          .catch((error) => {
            pushNotice({
              tone: "error",
              title: "Couldn't copy project path",
              message: getErrorMessage(error),
            });
          });
      },
    },
    {
      label: "Move to",
      icon: <FolderInput size={14} />,
      children: moveToChildren,
    },
    ...contributedActionItems,
    {
      label: "Remove Project",
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: onRemove,
    },
  ];

  return (
    <>
      <div
        className={`list-item ${isActive ? "project-active" : ""}${isDropTarget ? " project-drop-target" : ""}`}
        data-project-path={repo.path}
        onClick={onClick}
        onContextMenu={handleContextMenu}
        onKeyDown={(event) => handleActionKey(event, onClick)}
        title={repo.path}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-label={repo.name}
      >
        {worktreeParent ? (
          <GitFork size={14} className="shrink-0" style={{ opacity: 0.6 }} />
        ) : (
          isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />
        )}
        <span className="truncate font-medium">
          {worktreeParent ? `${worktreeParent} > ${repo.name}` : repo.name}
        </span>
        <span className="flex-1" />
        {!isExpanded && activityStatus && (
          <ActivityIndicator status={activityStatus} />
        )}
      </div>
      {menu && createPortal(
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={handleClose}
        />,
        document.body,
      )}
      {actionSurface && (
        <ModuleProjectActionSurface
          action={actionSurface.action}
          moduleId={actionSurface.moduleId}
          activationId={actionSurface.activationId}
          project={projectRef}
          position={actionSurface.position}
          close={() => setActionSurface(null)}
          host={{
            addProject: onAddProject,
            moveProjectToGroup: onMoveToGroup,
          }}
          moduleActivations={moduleActivations}
        />
      )}
    </>
  );
}
