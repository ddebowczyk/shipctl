import type { ProjectNavigationContributionProps } from "@shipctl/module-api";
import { List } from "lucide-react";

import { useCommandsStore } from "./store";

export default function CommandsProjectRow({
  project,
  active,
  open,
}: ProjectNavigationContributionProps) {
  const count = useCommandsStore(
    (state) => state.projectCommands[project.path]?.length ?? 0,
  );

  return (
    <button
      onClick={open}
      className={`section-toggle ${active ? "!text-[var(--text-primary)] !bg-white/6" : ""}`}
    >
      <span
        className="shrink-0 w-[14px] flex items-center justify-center"
        style={{ color: "var(--section-icon-color)" }}
      >
        <List size={14} />
      </span>
      <span className="truncate">Commands</span>
      {count > 0 && <span className="badge">{count}</span>}
    </button>
  );
}
