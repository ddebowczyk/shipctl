import { useState, useCallback, useRef } from "react";
import { Folders, Pencil, Trash2 } from "lucide-react";
import { createPortal } from "react-dom";
import { ContextMenu } from "@shipctl/core/shared/views";
import type { ContextMenuItem } from "@shipctl/core/shared/views";
import type { RepoGroup } from "@shipctl/core/platform";
import { ActivityIndicator, getAggregateActivityStatus } from "@shipctl/core/shared/views";

interface GroupHeaderProps {
  group: RepoGroup;
  isExpanded: boolean;
  activity?: { hasAttention: boolean; hasCrash: boolean; hasActivity: boolean; hasActive: boolean };
  onToggle: () => void;
  onRename: (groupId: string, newName: string) => void;
  onDelete: (groupId: string) => void;
}

export default function GroupHeader({
  group,
  isExpanded,
  activity,
  onToggle,
  onRename,
  onDelete,
}: GroupHeaderProps) {
  const activityStatus = getAggregateActivityStatus({
    hasCrash: activity?.hasCrash,
    hasAttention: activity?.hasAttention,
    hasActive: activity?.hasActive,
    hasRunning: activity?.hasActivity,
  });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(group.name);
  const renameSubmittedRef = useRef(false);
  const renameInputRef = useCallback((el: HTMLInputElement | null) => {
    if (el) { el.focus(); el.select(); }
  }, []);

  const handleCloseMenu = useCallback(() => setMenu(null), []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleStartRename = useCallback(() => {
    renameSubmittedRef.current = false;
    setRenameValue(group.name);
    setRenaming(true);
  }, [group.name]);

  const handleSubmitRename = useCallback(() => {
    if (renameSubmittedRef.current) return;
    renameSubmittedRef.current = true;
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== group.name) {
      onRename(group.id, trimmed);
    }
    setRenaming(false);
  }, [renameValue, group.id, group.name, onRename]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSubmitRename();
      } else if (e.key === "Escape") {
        renameSubmittedRef.current = true;
        setRenaming(false);
      }
    },
    [handleSubmitRename],
  );

  const menuItems: ContextMenuItem[] = [
    {
      label: "Rename Group",
      icon: <Pencil size={14} />,
      onClick: handleStartRename,
    },
    {
      label: "Delete Group",
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => onDelete(group.id),
    },
  ];

  return (
    <>
      <div
        className="group-header"
        onClick={onToggle}
        onContextMenu={handleContextMenu}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        aria-expanded={isExpanded}
        aria-label={group.name}
      >
        <Folders size={14} style={{ opacity: isExpanded ? 1 : 0.6, flexShrink: 0 }} />
        {renaming ? (
          <input
            ref={renameInputRef}
            className="group-header__rename-input"
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleSubmitRename}
            onKeyDown={handleRenameKeyDown}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="group-header__name truncate">{group.name}</span>
        )}
        <span className="flex-1" />
        {!isExpanded && activityStatus && (
          <ActivityIndicator status={activityStatus} />
        )}
      </div>
      {menu &&
        createPortal(
          <ContextMenu
            x={menu.x}
            y={menu.y}
            items={menuItems}
            onClose={handleCloseMenu}
          />,
          document.body,
        )}
    </>
  );
}
