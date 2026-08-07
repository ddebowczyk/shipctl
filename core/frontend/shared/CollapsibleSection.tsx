import type { ReactNode } from "react";

interface CollapsibleSectionProps {
  label: string;
  icon: ReactNode;
  badge?: string | number | null;
  hasItems?: boolean;
  defaultOpen?: boolean;
  onAdd?: () => void;
  children: ReactNode;
}

export default function CollapsibleSection({
  label,
  icon,
  badge,
  hasItems = false,
  onAdd,
  children,
}: CollapsibleSectionProps) {
  return (
    <>
      <div className="section-toggle group">
        <button
          onClick={() => onAdd?.()}
          className="flex items-center gap-1.5 flex-1 min-w-0"
          title={`New ${label.replace(/s$/, "").toLowerCase()}`}
        >
          <span className="shrink-0 w-[14px] flex items-center justify-center" style={{ color: "var(--section-icon-color)" }}>{icon}</span>
          <span className="truncate">{label}</span>
          {badge != null && (
            <span className="badge">{badge}</span>
          )}
        </button>
      </div>
      {hasItems && (
        <div className="mt-0.5 pl-4">
          {children}
        </div>
      )}
    </>
  );
}
