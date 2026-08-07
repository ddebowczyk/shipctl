import { useCallback, useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTerminalStore } from "../terminal/index.ts";
import { useUIStore } from "../shared/index.ts";
import { useShallow } from "zustand/shallow";
import { Circle, FolderInput, FolderTree, GitBranch, List, PanelsTopLeft, SquareTerminal } from "lucide-react";
import type { PanelContribution } from "@shep/module-api";
import { handleActionKey } from "../shared/index.ts";
import { useRepoStore } from "../projects/index.ts";
import {
  useProjectFactsMap,
} from "../host/index.ts";
import { ContextMenu } from "../shared/views.ts";
import type { ContextMenuItem } from "../shared/views.ts";
import { tabKindMeta, extraActions } from "../shared/views.ts";
import type { UnifiedTab } from "../platform/index.ts";
import { buildProjectMoveMenuItems } from "../projects/views.ts";


const PANEL_ICONS = {
  "folder-tree": FolderTree,
  list: List,
  "square-terminal": SquareTerminal,
} as const;

function panelIcon(panel: PanelContribution, size: number) {
  const Icon = PANEL_ICONS[panel.icon.name as keyof typeof PANEL_ICONS] ?? Circle;
  return <Icon size={size} />;
}

function NewSessionButton({ onNewShell, panels, onOpenPanel, onOpenInEditor }: { onNewShell: () => void; panels: readonly PanelContribution[]; onOpenPanel: (panel: PanelContribution) => void; onOpenInEditor: () => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const menuItems = [
    { key: "terminal", meta: tabKindMeta.terminal, action: onNewShell },
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

/** Render the icon for a tab based on its kind */
function TabIcon({ tab, panels }: { tab: UnifiedTab; panels: readonly PanelContribution[] }) {
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

interface TabBarProps {
  onClose: (tabId: string) => void;
  onNewShell: () => void;
  panels: readonly PanelContribution[];
  onOpenPanel: (panel: PanelContribution) => void;
  onOpenInEditor: () => void;
  onRenameTab: (tabId: string, label: string) => void | Promise<void>;
  onMoveTab: (tabId: string, destinationPath: string) => void | Promise<void>;
  onDragProjectChange: (projectPath: string | null) => void;
}

export default function TabBar({
  onClose,
  onNewShell,
  panels,
  onOpenPanel,
  onOpenInEditor,
  onRenameTab,
  onMoveTab,
  onDragProjectChange,
}: TabBarProps) {
  const { activeProjectPath, projectState } = useTerminalStore(
    useShallow((s) => ({ activeProjectPath: s.activeProjectPath, projectState: s.activeProjectPath ? s.projectState[s.activeProjectPath] : null })),
  );
  const projectTerminals = projectState;
  const repos = useRepoStore((s) => s.repos);
  const groups = useRepoStore((s) => s.groups);
  const projectName = activeProjectPath ? activeProjectPath.split("/").pop() : null;
  const projectFacts = useProjectFactsMap(repos);
  const activeFacts = activeProjectPath ? projectFacts[activeProjectPath] : null;
  const branch = activeFacts?.revision?.label ?? null;
  const branchIconColor = !activeFacts?.revision
    ? undefined
    : activeFacts.revision.state === "changed"
      ? "var(--status-attention)"
      : "var(--status-clean)";
  const tabs = projectTerminals?.tabs ?? [];
  const activeTabId = projectTerminals?.activeTabId ?? null;
  const { setActiveTab, reorderTab } = useTerminalStore.getState();

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
    const tabEls = Array.from(container.querySelectorAll<HTMLElement>("[data-tab-index]"));
    for (let i = 0; i < tabEls.length; i++) {
      const rect = tabEls[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return i;
    }
    return tabEls.length;
  }, []);

  const getProjectPathAt = useCallback((clientX: number, clientY: number) => {
    const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-project-path]");
    return target?.dataset.projectPath ?? null;
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent, tabId: string) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".icon-btn")) return;
    const d = dragRef.current;
    d.startX = e.clientX;
    d.didDrag = false;
    d.dropIndex = null;

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      setDragTabId(null);
      setDropIndex(null);
      onDragProjectChange(null);
      d.didDrag = false;
      d.dropProjectPath = null;
    };

    const onMove = (ev: PointerEvent) => {
      if (!d.didDrag && Math.abs(ev.clientX - d.startX) > 4) {
        d.didDrag = true;
        setDragTabId(tabId);
      }
      if (d.didDrag) {
        const draggedTab = tabs.find((tab) => tab.id === tabId);
        const projectPath = draggedTab?.kind === "terminal"
          ? getProjectPathAt(ev.clientX, ev.clientY)
          : null;
        const canMoveToProject = Boolean(projectPath && projectPath !== activeProjectPath);
        d.dropProjectPath = canMoveToProject ? projectPath : null;
        onDragProjectChange(d.dropProjectPath);

        if (d.dropProjectPath) {
          d.dropIndex = null;
          setDropIndex(null);
        } else {
          const idx = computeDropIndex(ev.clientX);
          d.dropIndex = idx;
          setDropIndex(idx);
        }
      }
    };

    const onUp = () => {
      if (d.didDrag && d.dropProjectPath) {
        void onMoveTab(tabId, d.dropProjectPath);
      } else if (d.didDrag && d.dropIndex !== null) {
        reorderTab(tabId, d.dropIndex);
      }
      cleanup();
    };

    const onCancel = () => cleanup();

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }, [activeProjectPath, computeDropIndex, getProjectPathAt, onDragProjectChange, onMoveTab, reorderTab, tabs]);

  const anyGlobalSurface = useUIStore((state) => state.activeGlobalSurfaceId !== null);

  const handleSelectTab = (tabId: string) => {
    useUIStore.getState().closeGlobalSurface();
    setActiveTab(tabId);
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.kind === "terminal") {
      useTerminalStore.getState().clearTabBell(tab.ptyId);
    }
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
        ...(isRenameable(tabMenuTab) && moveToChildren.length > 0 ? [{ separator: true, label: "_separator_close" }] : []),
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
        {tabs.map((tab, i) => {
          const isActive = tab.id === activeTabId && !anyGlobalSurface;
          const isDragging = tab.id === dragTabId;

          const showDropBefore = dropIndex !== null && dragTabId && tab.id !== dragTabId && dropIndex === i;
          const showDropAfter = dropIndex !== null && dragTabId && tab.id !== dragTabId && dropIndex === i + 1 && i === tabs.length - 1;

          return (
            <div
              key={tab.id}
              data-tab-index={i}
              className={`tab ${isActive ? "active" : ""}${isDragging ? " dragging" : ""}${showDropBefore ? " drop-before" : ""}${showDropAfter ? " drop-after" : ""}`}
              onClick={() => {
                if (!dragRef.current.didDrag) handleSelectTab(tab.id);
              }}
              onKeyDown={(event) => handleActionKey(event, () => handleSelectTab(tab.id))}
              onPointerDown={(e) => handlePointerDown(e, tab.id)}
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
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => {
                    const val = e.target.value.trim();
                    if (val && val !== tab.label) void onRenameTab(tab.id, val);
                    setEditingTabId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") {
                      e.currentTarget.value = tab.label;
                      e.currentTarget.blur();
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <span
                    className="truncate max-w-32"
                    onDoubleClick={isRenameable(tab) ? (e) => {
                      e.stopPropagation();
                      setEditingTabId(tab.id);
                    } : undefined}
                  >
                    {tab.label}
                  </span>
                </>
              )}
              <button
                className="tab-close"
                aria-label={`Close tab ${tab.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}

        <NewSessionButton onNewShell={onNewShell} panels={panels} onOpenPanel={onOpenPanel} onOpenInEditor={onOpenInEditor} />
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
      {tabMenu && tabMenuTab && (
        createPortal(
          <ContextMenu
            x={tabMenu.x}
            y={tabMenu.y}
            items={tabMenuItems}
            onClose={() => setTabMenu(null)}
          />,
          document.body,
        )
      )}
    </div>
  );
}
