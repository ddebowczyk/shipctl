import { useState, useCallback } from "react";
import type { TerminalTabData, TabActivity } from "@shipctl/core/platform";
import { useTerminalStore } from "@shipctl/core/terminal";
import { handleActionKey } from "@shipctl/core/shared";
import { FolderInput, X } from "lucide-react";
import { ContextMenu } from "@shipctl/core/shared/views";
import type { ContextMenuItem } from "@shipctl/core/shared/views";
import { buildProjectMoveMenuItems } from "@shipctl/core/projects/views";
import { useRepoStore } from "@shipctl/core/projects";
import {
  useProjectFactsMap,
} from "./index.ts";
import { ActivityIndicator, getTabActivityStatus } from "@shipctl/core/shared/views";

interface ModuleSessionButtonProps {
  tab: TerminalTabData;
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
  projectPath: string;
  onMoveTab: (tabId: string, destinationPath: string) => void | Promise<void>;
}

export default function ModuleSessionButton({
  tab,
  isActive,
  onClick,
  onClose,
  projectPath,
  onMoveTab,
}: ModuleSessionButtonProps) {
  const contributedIcon = tab.modulePresentation?.icon;
  const logoUrl = contributedIcon?.src ?? null;
  const logoClassName = contributedIcon?.className;
  const activity: TabActivity | undefined = useTerminalStore((s) => s.tabActivity[tab.terminalId]);
  const repos = useRepoStore((s) => s.repos);
  const groups = useRepoStore((s) => s.groups);
  const projectFacts = useProjectFactsMap(repos);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const statusBadge = tab.modulePresentation?.badge ?? null;
  const statusBadgeColor = statusBadge
    ? statusBadge.tone === "attention"
      ? "var(--status-attention)"
      : statusBadge.tone === "success"
        ? "var(--status-success)"
        : "var(--text-muted)"
    : undefined;

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const moveToChildren = buildProjectMoveMenuItems({
    repos,
    groups,
    projectFacts,
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
        className={`list-item w-full ${isActive ? "active" : ""}`}
        onClick={onClick}
        onContextMenu={handleContextMenu}
        onKeyDown={(event) => handleActionKey(event, onClick)}
        title={tab.label}
        role="button"
        tabIndex={0}
        aria-pressed={isActive}
        aria-label={`Open module session ${tab.label}`}
      >
        {logoUrl && <img src={logoUrl} alt={contributedIcon?.alt ?? ""} width={14} height={14} className={logoClassName} />}
        <span className="truncate text-left">{tab.label}</span>
        {statusBadge && (
          <span
            className="ml-auto shrink-0 text-[10px]"
            style={{ color: statusBadgeColor }}
            title={statusBadge.title}
          >
            {statusBadge.label}
          </span>
        )}
        <ActivityIndicator status={getTabActivityStatus(activity)} activity={activity} />
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </>
  );
}
