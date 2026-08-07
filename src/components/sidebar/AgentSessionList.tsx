import { useCallback, useState } from "react";
import type { TabActivity, TerminalTabData } from "../../lib/types";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import { handleActionKey } from "../../lib/a11y";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useRepoStore } from "../../stores/useRepoStore";
import { useProjectFactsMap } from "../../core/modules";
import tabKindMeta from "../../lib/tabKindMeta";
import SidebarSectionToggle from "./SidebarSectionToggle";
import ActivityIndicator, { getTabActivityStatus } from "./ActivityIndicator";
import { FolderInput } from "lucide-react";
import ContextMenu from "../shared/ContextMenu";
import type { ContextMenuItem } from "../shared/ContextMenu";
import { buildProjectMoveMenuItems } from "../shared/projectMoveMenu";

export interface AgentSessionItem {
  tab: TerminalTabData;
  projectPath: string;
  projectName: string;
  branchName: string | null;
}

interface AgentSessionListProps {
  sessions: AgentSessionItem[];
  activeRepoPath: string | null;
  activeTabId: string | null;
  onSelectSession: (repoPath: string, tabId: string) => void;
  onMoveTab: (tabId: string, destinationPath: string) => void | Promise<void>;
}

const MAX_VISIBLE_SESSIONS = 4;

function AgentSessionRow({
  item,
  isActive,
  onSelect,
  onMoveTab,
}: {
  item: AgentSessionItem;
  isActive: boolean;
  onSelect: () => void;
  onMoveTab: (tabId: string, destinationPath: string) => void | Promise<void>;
}) {
  const { tab, projectName, branchName } = item;
  const contributedIcon = tab.modulePresentation?.icon;
  const logoUrl = contributedIcon?.src ?? (tab.assistantId ? assistantLogoSrc[tab.assistantId] : null);
  const logoClassName = contributedIcon?.className
    ?? (tab.assistantId ? getAssistantLogoClass(tab.assistantId) : undefined);
  const activity: TabActivity | undefined = useTerminalStore((s) => s.tabActivity[tab.ptyId]);
  const repos = useRepoStore((s) => s.repos);
  const groups = useRepoStore((s) => s.groups);
  const projectFacts = useProjectFactsMap(repos);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const title = branchName ? `${projectName} - ${branchName}` : projectName;
  const moveToChildren = buildProjectMoveMenuItems({
    repos,
    groups,
    projectFacts,
    currentProjectPath: item.projectPath,
    onMove: (destinationPath) => { void onMoveTab(tab.id, destinationPath); },
  });
  const menuItems: ContextMenuItem[] = moveToChildren.length > 0
    ? [{
        label: "Move to project",
        icon: <FolderInput size={14} />,
        children: moveToChildren,
      }]
    : [];

  return (
    <>
      <div
        className={`list-item agent-session-row ${isActive ? "active" : ""}`}
        onClick={onSelect}
        onContextMenu={(event) => {
          event.preventDefault();
          if (menuItems.length > 0) setMenu({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => handleActionKey(event, onSelect)}
        title={title}
        role="button"
        tabIndex={0}
        aria-pressed={isActive}
        aria-label={`Open agent session in ${title}`}
      >
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={contributedIcon?.alt ?? ""}
            width={14}
            height={14}
            className={logoClassName}
          />
        ) : (
          <span className="shrink-0">{tabKindMeta.assistant.icon(14)}</span>
        )}
        <span className="agent-session-row__text">
          <span className="agent-session-row__project">{projectName}</span>
          {branchName && <span className="agent-session-row__branch">{branchName}</span>}
        </span>
        <ActivityIndicator
          status={getTabActivityStatus(activity)}
          activity={activity}
          className="agent-session-row__indicator"
        />
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </>
  );
}

export default function AgentSessionList({
  sessions,
  activeRepoPath,
  activeTabId,
  onSelectSession,
  onMoveTab,
}: AgentSessionListProps) {
  // Always starts expanded on launch; collapsing is per-session only.
  const [collapsed, setCollapsed] = useState(false);
  const visibleSessions = collapsed ? [] : sessions.slice(0, MAX_VISIBLE_SESSIONS);
  const overflowCount = Math.max(0, sessions.length - MAX_VISIBLE_SESSIONS);

  const handleToggle = useCallback(() => {
    setCollapsed((value) => !value);
  }, []);

  if (sessions.length === 0) return null;

  return (
    <div className="sidebar-section px-2 pb-1">
      <SidebarSectionToggle
        label="Agent Sessions"
        collapsed={collapsed}
        badge={sessions.length}
        onToggle={handleToggle}
      />

      {!collapsed && (
        <div className="sidebar-section__list">
          {visibleSessions.map((item) => (
            <AgentSessionRow
              key={`${item.projectPath}:${item.tab.id}`}
              item={item}
              isActive={item.projectPath === activeRepoPath && item.tab.id === activeTabId}
              onSelect={() => onSelectSession(item.projectPath, item.tab.id)}
              onMoveTab={onMoveTab}
            />
          ))}
          {overflowCount > 0 && (
            <div className="sidebar-section__overflow">+{overflowCount} more in projects</div>
          )}
        </div>
      )}
    </div>
  );
}
