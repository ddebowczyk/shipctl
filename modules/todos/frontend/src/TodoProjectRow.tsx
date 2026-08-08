import { useSyncExternalStore } from "react";
import type { ProjectNavigationContributionProps } from "@shipctl/module-api";
import { ListTodo } from "lucide-react";

import { useTodoStore } from "./store";

export default function TodoProjectRow({
  project,
  active,
  open,
  services,
}: ProjectNavigationContributionProps) {
  const settings = useSyncExternalStore(
    services.settings.subscribe,
    services.settings.getSnapshot,
  );
  const showTodos = settings.values.showTodos !== false;
  const files = useTodoStore((state) => state.projectTodos[project.path]);

  if (!showTodos) return null;

  const openCount =
    files?.reduce(
      (sum, file) => sum + file.items.filter((item) => !item.checked).length,
      0,
    ) ?? 0;

  return (
    <button
      onClick={open}
      className={`section-toggle ${active ? "!text-[var(--text-primary)] !bg-white/6" : ""}`}
    >
      <span className="shrink-0" style={{ color: "var(--section-icon-color)" }}>
        <ListTodo size={14} />
      </span>
      <span className="truncate">To-dos</span>
      {openCount > 0 && <span className="badge">{openCount}</span>}
    </button>
  );
}
