import { GitBranch } from "lucide-react";
import type { ProjectNavigationContributionProps } from "@shipctl/module-api";
import { useGitStore } from "./store";

export default function GitStatusRow({ project, active, open }: ProjectNavigationContributionProps) {
  const status = useGitStore((s) => s.projectGitStatus[project.path]);

  if (!status?.isRepository) return null;

  const changeCount = status.stagedCount + status.unstagedCount + status.untrackedCount;
  const label = status.branchName && status.branchName !== "(detached)"
    ? status.branchName
    : "Files";

  return (
    <button
      onClick={open}
      className={`section-toggle ${active ? "!text-[var(--text-primary)] !bg-white/6" : ""}`}
    >
      <span className="shrink-0" style={{ color: "var(--section-icon-color)" }}><GitBranch size={14} /></span>
      <span className="truncate" title={label}>{label}</span>
      {changeCount > 0 && (
        <span className="badge">{changeCount}</span>
      )}
      {(status.aheadCount > 0 || status.behindCount > 0) && (
        <span className="badge">
          {status.aheadCount > 0 && `↑${status.aheadCount}`}
          {status.aheadCount > 0 && status.behindCount > 0 && " "}
          {status.behindCount > 0 && `↓${status.behindCount}`}
        </span>
      )}
      {status.dirty && <span className="sidebar-status-dot sidebar-status-dot--attention" />}
    </button>
  );
}
