import { CodeXml } from "lucide-react";
import { useUIStore } from "@shipctl/core/shared";
import { BUILTIN_GLOBAL_SURFACE_IDS } from "@shipctl/core/shared";

interface IdeLaunchRowProps {
  repoPath: string;
  onOpenInEditor: (repoPath: string) => void;
}

export default function IdeLaunchRow({
  repoPath,
  onOpenInEditor,
}: IdeLaunchRowProps) {
  const isSettingsSurfaceActive = useUIStore(
    (state) => state.activeGlobalSurfaceId === BUILTIN_GLOBAL_SURFACE_IDS.settings,
  );

  return (
    <button
      onClick={() => onOpenInEditor(repoPath)}
      className={`section-toggle ${isSettingsSurfaceActive ? "!text-[var(--text-primary)] !bg-white/6" : ""}`}
    >
      <CodeXml size={14} className="shrink-0" />
      <span className="truncate">IDE</span>
    </button>
  );
}
