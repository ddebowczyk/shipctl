import { useEffect, useRef, useState } from "react";
import type { ProjectActionSurfaceProps } from "@shep/module-api";

import { getErrorMessage } from "../../lib/errors";
import { gitCreateWorktree } from "../../lib/tauri";

export default function CreateWorktreeProjectActionSurface({
  project,
  position,
  close,
  host,
  services,
}: ProjectActionSurfaceProps) {
  const [branchName, setBranchName] = useState("");
  const [creating, setCreating] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointer = (event: MouseEvent) => {
      if (!surfaceRef.current?.contains(event.target as Node)) close();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", handlePointer, true);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer, true);
      document.removeEventListener("keydown", handleKey);
    };
  }, [close]);

  const branchSlugPreview = branchName
    .trim()
    .split("")
    .map((char) => (/^[A-Za-z0-9_-]$/.test(char) ? char : "-"))
    .join("")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const createPathPreview = branchSlugPreview
    ? `.shep-worktrees/${project.name}/${branchSlugPreview}`
    : `.shep-worktrees/${project.name}/...`;

  const createWorktree = async () => {
    const requestedBranch = branchName.trim();
    if (!requestedBranch || creating) return;
    setCreating(true);
    try {
      const created = await gitCreateWorktree(project.path, requestedBranch);
      await host.addProject(created.path);
      if (project.groupId) {
        await host.moveProjectToGroup(created.path, project.groupId);
      }
      close();
    } catch (error) {
      services.notices.push({
        tone: "error",
        title: "Couldn't create worktree",
        message: getErrorMessage(error),
      });
      setCreating(false);
    }
  };

  return (
    <div
      ref={surfaceRef}
      className="context-menu"
      style={{ left: position.x, top: position.y, minWidth: 280 }}
    >
      <div style={{ padding: "6px 10px 2px", fontSize: 11, opacity: 0.5 }}>
        Create worktree
      </div>
      <form
        className="branch-dropdown__create-form"
        onSubmit={(event) => {
          event.preventDefault();
          void createWorktree();
        }}
        style={{ padding: "8px" }}
      >
        <input
          className="branch-dropdown__input"
          type="text"
          autoFocus
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="feature/my-change"
          value={branchName}
          onChange={(event) => setBranchName(event.target.value)}
          disabled={creating}
        />
      </form>
      <div style={{ padding: "0 10px 8px", fontSize: 11, opacity: 0.5, lineHeight: 1.4 }}>
        Creates a new branch and worktree under
        <div style={{ marginTop: 4, opacity: 0.8, wordBreak: "break-all" }}>
          {createPathPreview}
        </div>
      </div>
      <div style={{ padding: "6px 8px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
        <button
          type="button"
          className="btn-primary"
          style={{ width: "100%", fontSize: 12, padding: "4px 0" }}
          disabled={!branchName.trim() || creating}
          onClick={() => void createWorktree()}
        >
          {creating ? "Creating..." : "Create Worktree"}
        </button>
      </div>
    </div>
  );
}
