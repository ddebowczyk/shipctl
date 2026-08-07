import { useState, useCallback } from "react";
import type { TerminalTabData, TabActivity } from "../../lib/types";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { handleActionKey } from "../../lib/a11y";
import { FolderInput, X } from "lucide-react";
import ContextMenu from "../shared/ContextMenu";
import type { ContextMenuItem } from "../shared/ContextMenu";
import { buildProjectMoveMenuItems } from "../shared/projectMoveMenu";
import { useRepoStore } from "../../stores/useRepoStore";
import { useProjectFactsMap } from "../../core/modules";
import ActivityIndicator, { getTabActivityStatus } from "./ActivityIndicator";

interface AssistantButtonProps {
  tab: TerminalTabData;
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
  projectPath: string;
  onMoveTab: (tabId: string, destinationPath: string) => void | Promise<void>;
}

export default function AssistantButton({
  tab,
  isActive,
  onClick,
  onClose,
  projectPath,
  onMoveTab,
}: AssistantButtonProps) {
  const logoUrl = tab.assistantId ? assistantLogoSrc[tab.assistantId] : null;
  const activity: TabActivity | undefined = useTerminalStore((s) => s.tabActivity[tab.ptyId]);
  const repos = useRepoStore((s) => s.repos);
  const groups = useRepoStore((s) => s.groups);
  const projectFacts = useProjectFactsMap(repos);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const restoreStatus = tab.captureState === "pending"
    ? { label: "saving", title: "Identifying this session for restore", color: "var(--text-muted)" }
    : tab.captureState === "failed"
      ? { label: "not saved", title: "This live session cannot be restored", color: "var(--status-attention)" }
      : null;

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
        aria-label={`Open assistant tab ${tab.label}`}
      >
        {logoUrl && <img src={logoUrl} alt="" width={14} height={14} className={tab.assistantId ? getAssistantLogoClass(tab.assistantId) : undefined} />}
        <span className="truncate text-left">{tab.label}</span>
        {restoreStatus && (
          <span
            className="ml-auto shrink-0 text-[10px]"
            style={{ color: restoreStatus.color }}
            title={restoreStatus.title}
          >
            {restoreStatus.label}
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
