import { ChevronDown, ChevronRight } from "lucide-react";

interface SidebarSectionToggleProps {
  label: string;
  collapsed: boolean;
  badge?: number | string | null;
  onToggle: () => void;
}

export default function SidebarSectionToggle({
  label,
  collapsed,
  badge,
  onToggle,
}: SidebarSectionToggleProps) {
  return (
    <button
      className="section-toggle sidebar-section-toggle"
      onClick={onToggle}
      title={collapsed ? `Show ${label.toLowerCase()}` : `Hide ${label.toLowerCase()}`}
      aria-expanded={!collapsed}
    >
      <span className="sidebar-section-toggle__label truncate">{label}</span>
      {badge != null && <span className="badge">{badge}</span>}
      <span className="sidebar-section-toggle__chevron shrink-0">
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
      </span>
    </button>
  );
}
