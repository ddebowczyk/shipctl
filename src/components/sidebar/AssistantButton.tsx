import { useState, useCallback } from "react";
import type { TerminalTabData, TabActivity } from "../../lib/types";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { handleActionKey } from "../../lib/a11y";
import { X } from "lucide-react";
import ContextMenu from "../shared/ContextMenu";
import type { ContextMenuItem } from "../shared/ContextMenu";
import ActivityIndicator, { getTabActivityStatus } from "./ActivityIndicator";

interface AssistantButtonProps {
  tab: TerminalTabData;
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
}

export default function AssistantButton({
  tab,
  isActive,
  onClick,
  onClose,
}: AssistantButtonProps) {
  const logoUrl = tab.assistantId ? assistantLogoSrc[tab.assistantId] : null;
  const activity: TabActivity | undefined = useTerminalStore((s) => s.tabActivity[tab.ptyId]);
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

  const menuItems: ContextMenuItem[] = [
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
