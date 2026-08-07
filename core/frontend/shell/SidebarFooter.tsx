import type { ComponentType } from "react";
import type { GlobalNavigationContribution } from "@shep/module-api";
import { ChartNoAxesCombined, Circle, Radio } from "lucide-react";
import { useUIStore } from "../shared/index.ts";
import { GearIcon } from "../shared/views.ts";

const ICONS: Readonly<Record<string, ComponentType<{ size?: number }>>> = {
  "chart-no-axes-combined": ChartNoAxesCombined,
  radio: Radio,
  settings: GearIcon,
};

export default function SidebarFooter({
  navigation,
}: {
  readonly navigation: readonly GlobalNavigationContribution[];
}) {
  const activeSurfaceId = useUIStore((state) => state.activeGlobalSurfaceId);
  const base = "sidebar-footer-btn";

  return (
    <div className="border-t border-[var(--glass-border)] px-2 pt-2 pb-1.5">
      <div className="flex items-stretch gap-1">
        {navigation.map((contribution) => {
          const Icon = ICONS[contribution.icon.name] ?? Circle;
          const active = activeSurfaceId === contribution.surfaceId;
          return (
            <button
              key={contribution.id}
              onClick={() => {
                useUIStore.getState().toggleGlobalSurface(contribution.surfaceId);
              }}
              className={`${base} ${active ? "active" : ""}`}
              aria-label={`Open ${contribution.label.toLowerCase()}`}
            >
              <Icon size={contribution.icon.name === "settings" ? 20 : 18} />
              <span className="text-[10px]">{contribution.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
