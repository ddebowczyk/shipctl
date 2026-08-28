import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Circle, FolderInput, FolderTree, GitBranch, List, PanelsTopLeft, SquareTerminal } from "lucide-react";
import {
  terminalDriverId,
  type PanelContribution,
  type TerminalDriverId,
} from "@shipctl/module-api";
import { useTerminalStore } from "@shipctl/core/terminal-host";
import { handleActionKey } from "@shipctl/core/shared";
import {
  ContextMenu,
  extraActions,
  tabKindMeta,
  type ContextMenuItem,
} from "@shipctl/core/shared/views";
import { useRepoStore } from "@shipctl/core/projects";
import { buildProjectMoveMenuItems } from "@shipctl/core/projects/views";
import { useProjectFactsMap } from "@shipctl/core/host";
import type { UnifiedTab } from "@shipctl/core/platform";
import type { WorkspaceTabProjection } from "@shipctl/core/workspace";

const PANEL_ICONS = {
  "folder-tree": FolderTree,
  list: List,
  "square-terminal": SquareTerminal,
} as const;

function panelIcon(panel: PanelContribution, size: number) {
  const Icon = PANEL_ICONS[panel.icon.name as keyof typeof PANEL_ICONS] ?? Circle;
  return <Icon size={size} />;
}

function NewSessionButton({
  onNewTerminal,
  panels,
  onOpenPanel,
  onOpenInEditor,
}: {
  readonly onNewTerminal: (driverId: TerminalDriverId) => void;
  readonly panels: readonly PanelContribution[];
  readonly onOpenPanel: (panel: PanelContribution) => void;
  readonly onOpenInEditor: () => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;
    const handle = (event: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(event.target as Node)
        && btnRef.current && !btnRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const menuItems = [
    {
      key: "semantic-terminal",
      meta: { ...tabKindMeta.terminal, label: "Semantic terminal" },
      action: () => onNewTerminal(terminalDriverId("semantic-terminal")),
    },
    {
      key: "thin-terminal",
      meta: { ...tabKindMeta.terminal, label: "TTY terminal" },
      action: () => onNewTerminal(terminalDriverId("thin-terminal")),
    },
    ...panels
      .filter((panel) => panel.scope === "project" && panel.newSession)
      .sort((left, right) => (left.newSession?.order ?? 0) - (right.newSession?.order ?? 0))
      .map((panel) => ({
        key: panel.id,
        meta: {
          label: panel.newSession?.label ?? panel.label,
          icon: (size: number) => panelIcon(panel, size),
          shortcut: panel.shortcut,
        },
        action: () => onOpenPanel(panel),
      })),
    { key: "editor", meta: extraActions.openInEditor, action: onOpenInEditor },
  ];

  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left });
    }
    setOpen(!open);
  };

  return (
    <>
      <button
        ref={btnRef}
        className="tab tab-auto !px-3 font-semibold"
        onClick={handleToggle}
        title="New session"
        aria-label="Open new session"
      >
        +
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="context-menu"
          style={{ top: pos.top, left: pos.left }}
        >
          {menuItems.map(({ key, meta, action }) => (
            <button
              key={key}
              className="context-menu__item"
              onClick={() => { action(); setOpen(false); }}
            >
              <span className="context-menu__icon">{meta.icon(14)}</span>
              <span>{meta.label}</span>
              {meta.shortcut && <span className="context-menu__shortcut">{meta.shortcut}</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Render the icon for a tab based on its kind. */
function TabIcon({ tab, panels }: { readonly tab: UnifiedTab; readonly panels: readonly PanelContribution[] }) {
  if (tab.kind === "terminal" && tab.modulePresentation?.icon) {
    const icon = tab.modulePresentation.icon;
    return <img src={icon.src} alt={icon.alt ?? ""} width={12} height={12} className={icon.className} />;
  }
  if (tab.kind === "panel") {
    const panel = panels.find(({ id }) => id === tab.panelId);
    return panel ? <>{panelIcon(panel, 12)}</> : <PanelsTopLeft size={12} />;
  }
  const meta = tabKindMeta[tab.kind];
  return meta ? <>{meta.icon(12)}</> : null;
}

export interface StandardWorkspaceTabsProps {
  readonly onClose: (tabId: string) => void;
  readonly onSelectTab: (tabId: string) => void;
  readonly onNewTerminal: (driverId: TerminalDriverId) => void;
  readonly panels: readonly PanelContribution[];
  readonly onOpenPanel: (panel: PanelContribution) => void;
  readonly onOpenInEditor: () => void;
  readonly onRenameTab: (tabId: string, label: string) => void | Promise<void>;
  readonly onMoveTab: (tabId: string, destinationPath: string) => void | Promise<void>;
  readonly onDragProjectChange: (projectPath: string | null) => void;
  readonly globalSurfaceOpen: boolean;
  readonly workspaceTabs: readonly WorkspaceTabProjection[];
  readonly onSelectWorkspaceTab: (instanceId: string) => void;
  readonly onCloseWorkspaceTab: (instanceId: string) => void;
}

export default function StandardWorkspaceTabs({
  onClose,
  onSelectTab,
  onNewTerminal,
  panels,
  onOpenPanel,
  onOpenInEditor,
  onRenameTab,
  onMoveTab,
  onDragProjectChange,
  globalSurfaceOpen,
  workspaceTabs,
  onSelectWorkspaceTab,
  onCloseWorkspaceTab,
}: StandardWorkspaceTabsProps) {
  const activeProjectPath = useRepoStore((state) => state.activeRepoPath);
  const projectState = useTerminalStore(
    (state) => (activeProjectPath ? state.projectState[activeProjectPath] : null),
  );
  const repos = useRepoStore((state) => state.repos);
  const groups = useRepoStore((state) => state.groups);
  const projectName = activeProjectPath ? activeProjectPath.split("/").pop() : null;
  const projectFacts = useProjectFactsMap(repos);
  const activeFacts = activeProjectPath ? projectFacts[activeProjectPath] : null;
  const branch = activeFacts?.revision?.label ?? null;
  const branchIconColor = !activeFacts?.revision
    ? undefined
    : activeFacts.revision.state === "changed"
      ? "var(--status-attention)"
      : "var(--status-clean)";
  const tabs = projectState?.tabs ?? [];
  const activeTabId = projectState?.activeTabId ?? null;
  const { reorderTab } = useTerminalStore.getState();

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const dragRef = useRef({
    startX: 0,
    didDrag: false,
    dropIndex: null as number | null,
    dropProjectPath: null as string | null,
  });
  const containerRef = useRef<HTMLDivElement>(null);

  const computeDropIndex = useCallback((clientX: number) => {
    const container = containerRef.current;
    if (!container) return null;
    const tabElements = Array.from(container.querySelectorAll<HTMLElement>("[data-tab-index]"));
    for (let index = 0; index < tabElements.length; index += 1) {
      const rect = tabElements[index]?.getBoundingClientRect();
      if (rect && clientX < rect.left + rect.width / 2) return index;
    }
    return tabElements.length;
  }, []);

  const getProjectPathAt = useCallback((clientX: number, clientY: number) => {
    const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-project-path]");
    return target?.dataset.projectPath ?? null;
  }, []);

  const handlePointerDown = useCallback((event: React.PointerEvent, tabId: string) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".icon-btn")) return;
    const drag = dragRef.current;
    drag.startX = event.clientX;
    drag.didDrag = false;
    drag.dropIndex = null;

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      setDragTabId(null);
      setDropIndex(null);
      onDragProjectChange(null);
      drag.didDrag = false;
      drag.dropProjectPath = null;
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (!drag.didDrag && Math.abs(moveEvent.clientX - drag.startX) > 4) {
        drag.didDrag = true;
        setDragTabId(tabId);
      }
      if (drag.didDrag) {
        const draggedTab = tabs.find((tab) => tab.id === tabId);
        const projectPath = draggedTab?.kind === "terminal"
          ? getProjectPathAt(moveEvent.clientX, moveEvent.clientY)
          : null;
        const canMoveToProject = Boolean(projectPath && projectPath !== activeProjectPath);
        drag.dropProjectPath = canMoveToProject ? projectPath : null;
        onDragProjectChange(drag.dropProjectPath);

        if (drag.dropProjectPath) {
          drag.dropIndex = null;
          setDropIndex(null);
        } else {
          const index = computeDropIndex(moveEvent.clientX);
          drag.dropIndex = index;
          setDropIndex(index);
        }
      }
    };

    const onUp = () => {
      if (drag.didDrag && drag.dropProjectPath) {
        void onMoveTab(tabId, drag.dropProjectPath);
      } else if (drag.didDrag && drag.dropIndex !== null && activeProjectPath) {
        reorderTab(activeProjectPath, tabId, drag.dropIndex);
      }
      cleanup();
    };

    const onCancel = () => cleanup();

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }, [activeProjectPath, computeDropIndex, getProjectPathAt, onDragProjectChange, onMoveTab, reorderTab, tabs]);

  const handleSelectTab = (tabId: string) => {
    if (!activeProjectPath) return;
    onSelectTab(tabId);
  };

  const isRenameable = (tab: UnifiedTab) => tab.kind === "terminal";
  const tabMenuTab = tabMenu ? tabs.find((tab) => tab.id === tabMenu.tabId) : null;
  const moveToChildren = buildProjectMoveMenuItems({
    repos,
    groups,
    projectFacts,
    currentProjectPath: activeProjectPath,
    onMove: (destinationPath) => {
      if (tabMenuTab) void onMoveTab(tabMenuTab.id, destinationPath);
    },
  });
  const tabMenuItems: ContextMenuItem[] = tabMenuTab
    ? [
        ...(isRenameable(tabMenuTab) && moveToChildren.length > 0
          ? [{
              label: "Move to project",
              icon: <FolderInput size={14} />,
              children: moveToChildren,
            }]
          : []),
        ...(isRenameable(tabMenuTab) && moveToChildren.length > 0
          ? [{ separator: true, label: "_separator_close" }]
          : []),
        {
          label: "Close tab",
          onClick: () => onClose(tabMenuTab.id),
        },
      ]
    : [];

  return (
    <div className="tab-bar">
      <div
        ref={containerRef}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        role="tablist"
        aria-label="Workspace tabs"
      >
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeTabId && !globalSurfaceOpen;
          const isDragging = tab.id === dragTabId;
          const showDropBefore = dropIndex !== null && dragTabId && tab.id !== dragTabId && dropIndex === index;
          const showDropAfter = dropIndex !== null && dragTabId && tab.id !== dragTabId && dropIndex === index + 1 && index === tabs.length - 1;

          return (
            <div
              key={tab.id}
              data-tab-index={index}
              className={`tab ${isActive ? "active" : ""}${isDragging ? " dragging" : ""}${showDropBefore ? " drop-before" : ""}${showDropAfter ? " drop-after" : ""}`}
              onClick={() => {
                if (!dragRef.current.didDrag) handleSelectTab(tab.id);
              }}
              onKeyDown={(event) => handleActionKey(event, () => handleSelectTab(tab.id))}
              onPointerDown={(event) => handlePointerDown(event, tab.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                setTabMenu({ x: event.clientX, y: event.clientY, tabId: tab.id });
              }}
              role="tab"
              tabIndex={0}
              aria-selected={isActive}
              aria-label={`Open tab ${tab.label}`}
            >
              <TabIcon tab={tab} panels={panels} />
              {editingTabId === tab.id ? (
                <input
                  className="tab-rename-input"
                  defaultValue={tab.label}
                  autoFocus
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onFocus={(event) => event.target.select()}
                  onBlur={(event) => {
                    const value = event.target.value.trim();
                    if (value && value !== tab.label) void onRenameTab(tab.id, value);
                    setEditingTabId(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") {
                      event.currentTarget.value = tab.label;
                      event.currentTarget.blur();
                    }
                  }}
                  onClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                />
              ) : (
                <span
                  className="truncate max-w-32"
                  onDoubleClick={isRenameable(tab) ? (event) => {
                    event.stopPropagation();
                    setEditingTabId(tab.id);
                  } : undefined}
                >
                  {tab.label}
                </span>
              )}
              <button
                className="tab-close"
                aria-label={`Close tab ${tab.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}

        {workspaceTabs.map((tab) => {
          const panel = panels.find(({ id }) => id === tab.viewTypeId);
          return (
            <div
              key={tab.id}
              className={`tab ${tab.selected ? "active" : ""}`}
              onClick={() => onSelectWorkspaceTab(tab.id)}
              onKeyDown={(event) => handleActionKey(event, () => onSelectWorkspaceTab(tab.id))}
              role="tab"
              tabIndex={0}
              aria-selected={tab.selected}
              aria-label={`Open tab ${tab.label}`}
            >
              {panel ? panelIcon(panel, 12) : <PanelsTopLeft size={12} />}
              <span className="truncate max-w-32">{tab.label}</span>
              {tab.closeable && (
                <button
                  className="tab-close"
                  aria-label={`Close tab ${tab.label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseWorkspaceTab(tab.id);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}

        <NewSessionButton
          onNewTerminal={onNewTerminal}
          panels={panels}
          onOpenPanel={onOpenPanel}
          onOpenInEditor={onOpenInEditor}
        />
      </div>
      {projectName && (
        <span className="tab-bar__breadcrumb">
          {projectName}
          {branch && (
            <>
              <span className="tab-bar__breadcrumb-on">on</span>
              <GitBranch size={15} className="tab-bar__breadcrumb-icon" style={branchIconColor ? { color: branchIconColor } : undefined} />
              {branch}
            </>
          )}
        </span>
      )}
      {tabMenu && tabMenuTab && createPortal(
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={tabMenuItems}
          onClose={() => setTabMenu(null)}
        />,
        document.body,
      )}
    </div>
  );
}
