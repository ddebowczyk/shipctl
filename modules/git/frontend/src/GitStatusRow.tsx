import { GitBranch } from "lucide-react";
import type { ProjectNavigationContributionProps } from "@shep/module-api";
import { useGitStore } from "./store";

export default function GitStatusRow({ project, active, open }: ProjectNavigationContributionProps) {
  const status = useGitStore((s) => s.projectGitStatus[project.path]);

  if (!status?.is_git_repo) return null;

  const changeCount = status.staged + status.unstaged + status.untracked;
  const label = status.branch && status.branch !== "(detached)" ? status.branch : "Files";

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
      {(status.ahead > 0 || status.behind > 0) && (
        <span className="badge">
          {status.ahead > 0 && `↑${status.ahead}`}
          {status.ahead > 0 && status.behind > 0 && " "}
          {status.behind > 0 && `↓${status.behind}`}
        </span>
      )}
      {status.dirty && <span className="sidebar-status-dot sidebar-status-dot--attention" />}
    </button>
  );
}
