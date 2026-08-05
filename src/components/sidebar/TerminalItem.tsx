import { useState, useCallback } from "react";
import type { TerminalTabData, TabActivity } from "../../lib/types";
import { FolderInput, X } from "lucide-react";
import tabKindMeta from "../../lib/tabKindMeta";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { handleActionKey } from "../../lib/a11y";
import ContextMenu from "../shared/ContextMenu";
import type { ContextMenuItem } from "../shared/ContextMenu";
import { buildProjectMoveMenuItems } from "../shared/projectMoveMenu";
import { useRepoStore } from "../../stores/useRepoStore";
import { useGitStore } from "../../stores/useGitStore";
import ActivityIndicator, { getTabActivityStatus } from "./ActivityIndicator";

interface TerminalItemProps {
  tab: TerminalTabData;
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
  projectPath: string;
  onMoveTab: (tabId: string, destinationPath: string) => void | Promise<void>;
}

export default function TerminalItem({
  tab,
  isActive,
  onClick,
  onClose,
  projectPath,
  onMoveTab,
}: TerminalItemProps) {
  const activity: TabActivity | undefined = useTerminalStore((s) => s.tabActivity[tab.ptyId]);
  const repos = useRepoStore((s) => s.repos);
  const groups = useRepoStore((s) => s.groups);
  const gitStatuses = useGitStore((s) => s.projectGitStatus);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const moveToChildren = buildProjectMoveMenuItems({
    repos,
    groups,
    gitStatuses,
    currentProjectPath: projectPath,
    onMove: (destinationPath) => { void onMoveTab(tab.id, destinationPath); },
  });
  const menuItems: ContextMenuItem[] = [
    ...(moveToChildren.length > 0
      ? [
          {
            label: "Move to project",
            icon: <FolderInput size={14} />,
            children: moveToChildren,
          },
          { separator: true, label: "_separator_close" },
        ]
      : []),
    {
      label: "Close",
      icon: <X size={14} />,
      danger: true,
      onClick: onClose,
    },
  ];

  return (
    <>
      <div
        className={`list-item ${isActive ? "active" : ""}`}
        onClick={onClick}
        onContextMenu={handleContextMenu}
        onKeyDown={(event) => handleActionKey(event, onClick)}
        role="button"
        tabIndex={0}
        aria-pressed={isActive}
        aria-label={`Open terminal tab ${tab.label}`}
      >
        <span className="shrink-0">{tabKindMeta.terminal.icon(14)}</span>
        <span className="min-w-0 truncate text-left">{tab.label}</span>
        <ActivityIndicator status={getTabActivityStatus(activity)} activity={activity} />
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </>
  );
}
