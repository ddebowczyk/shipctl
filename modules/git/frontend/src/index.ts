import type { ProjectFacts, ShepModule } from "@shep/module-api";

import "./git.css";

import * as client from "./client";
import { useGitStore } from "./store";
import type { GitStatus } from "./types";

const factCache = new WeakMap<GitStatus, ProjectFacts>();

function factsForStatus(status: GitStatus | undefined): ProjectFacts | null {
  if (!status?.is_git_repo) return null;
  const cached = factCache.get(status);
  if (cached) return cached;
  const facts: ProjectFacts = {
    ...(status.branch
      ? { revision: { label: status.branch, state: status.dirty ? "changed" : "clean" } }
      : {}),
    ...(status.worktree_parent
      ? { lineage: { parentLabel: status.worktree_parent } }
      : {}),
  };
  factCache.set(status, facts);
  return facts;
}

export const gitModule = {
  id: "shep.git",
  version: "0.0.0",
  panels: [
    {
      id: "core.git",
      moduleId: "shep.git",
      scope: "project",
      label: "Files",
      icon: { name: "folder-tree" },
      shortcut: "⌘G",
      singleton: "per-project",
      order: 10,
      unavailable: {
        title: "Files panel unavailable",
        description: "The Git and file browser module could not be loaded.",
      },
      legacyTab: { kind: "git", label: "Files" },
      load: () => import("./GitPanel"),
    },
  ],
  projectNavigation: [
    {
      id: "git.project-navigation",
      moduleId: "shep.git",
      panelId: "core.git",
      order: 10,
      load: () => import("./GitStatusRow"),
    },
  ],
  projectLayout: [
    {
      id: "git.diff-summary",
      moduleId: "shep.git",
      slot: "workspace.trailing",
      order: 10,
      load: () => import("./DiffSummaryPanel"),
    },
  ],
  projectActions: [
    {
      id: "git.project-actions",
      moduleId: "shep.git",
      order: 30,
      getGroup: () => ({
        label: null,
        actions: [
          {
            id: "git.create-worktree",
            label: "Create Worktree",
            icon: { name: "plus" },
            surface: { load: () => import("./CreateWorktreeProjectActionSurface") },
          },
        ],
      }),
    },
  ],
  projectFactsProvider: {
    id: "git.project-facts",
    moduleId: "shep.git",
    getFacts: (project) => factsForStatus(
      useGitStore.getState().projectGitStatus[project.path],
    ),
    subscribe: (listener) => useGitStore.subscribe(listener),
    refresh: (project) => useGitStore.getState().refreshStatus(project.path),
  },
  projectLifecycle: {
    onProjectsChanged: (projectPaths) => useGitStore.getState().refreshAll(projectPaths),
    onFilesystemChanged: (projectPaths) => useGitStore.getState().refreshAll(projectPaths),
    onProjectRemoved: (projectPath) => useGitStore.getState().removeProject(projectPath),
  },
  projectImport: {
    id: "git.related-projects",
    moduleId: "shep.git",
    relatedPaths: async (projectPath, { expandRelated }, services) => {
      const worktrees = await client.gitListWorktrees(projectPath);
      const current = worktrees.find((worktree) => worktree.path === projectPath);
      if (!current) return [];
      if (!current.is_main) {
        return worktrees.filter((worktree) => worktree.is_main).map((worktree) => worktree.path);
      }
      const autoImportWorktrees = services.settings.getSnapshot().values.autoImportWorktrees !== false;
      return expandRelated && autoImportWorktrees
        ? worktrees.filter((worktree) => !worktree.is_main).map((worktree) => worktree.path)
        : [];
    },
  },
  settings: [
    {
      id: "git.settings",
      moduleId: "shep.git",
      order: 10,
      load: () => import("./GitSettingsSection"),
    },
  ],
} as const satisfies ShepModule;
