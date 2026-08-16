import type { ProjectFacts, ShipctlModule } from "@shipctl/module-api";

import "./git.css";

import { gitClientFor } from "./gitClient";
import { useGitStore } from "./store";
import type { GitStatus } from "./types";

const factCache = new WeakMap<GitStatus, ProjectFacts>();

function factsForStatus(status: GitStatus | undefined): ProjectFacts | null {
  if (!status?.isRepository) return null;
  const cached = factCache.get(status);
  if (cached) return cached;
  const facts: ProjectFacts = {
    ...(status.branchName
      ? { revision: { label: status.branchName, state: status.dirty ? "changed" : "clean" } }
      : {}),
    ...(status.worktreeParentProjectId
      ? { lineage: { parentLabel: status.worktreeParentProjectId } }
      : {}),
  };
  factCache.set(status, facts);
  return facts;
}

export const gitModule = {
  id: "shipctl.git",
  version: "0.0.0",
  panels: [
    {
      id: "core.git",
      moduleId: "shipctl.git",
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
      migrationAlias: { kind: "git", label: "Files" },
      load: () => import("./GitPanel"),
    },
  ],
  projectNavigation: [
    {
      id: "git.project-navigation",
      moduleId: "shipctl.git",
      panelId: "core.git",
      order: 10,
      load: () => import("./GitStatusRow"),
    },
  ],
  projectLayout: [
    {
      id: "git.diff-summary",
      moduleId: "shipctl.git",
      slot: "workspace.trailing",
      order: 10,
      load: () => import("./DiffSummaryPanel"),
    },
  ],
  projectActions: [
    {
      id: "git.project-actions",
      moduleId: "shipctl.git",
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
    moduleId: "shipctl.git",
    getFacts: (project) => factsForStatus(
      useGitStore.getState().projectGitStatus[project.path],
    ),
    subscribe: (listener) => useGitStore.subscribe(listener),
  },
  projectLifecycle: {
    onProjectsChanged: (projectPaths, _services, activation) => (
      useGitStore.getState().refreshAll(projectPaths, gitClientFor(activation))
    ),
    onFilesystemChanged: (projectPaths, _services, activation) => (
      useGitStore.getState().refreshAll(projectPaths, gitClientFor(activation))
    ),
    onProjectRemoved: (projectPath) => useGitStore.getState().removeProject(projectPath),
  },
  projectImport: {
    id: "git.related-projects",
    moduleId: "shipctl.git",
    relatedPaths: async (projectPath, { expandRelated }, services, activation) => {
      const worktrees = await gitClientFor(activation).listWorktrees(projectPath);
      const current = worktrees.find((worktree) => worktree.projectId === projectPath);
      if (!current) return [];
      if (!current.isMain) {
        return worktrees.filter((worktree) => worktree.isMain).map((worktree) => worktree.projectId);
      }
      const autoImportWorktrees = services.settings.getSnapshot().values.autoImportWorktrees !== false;
      return expandRelated && autoImportWorktrees
        ? worktrees.filter((worktree) => !worktree.isMain).map((worktree) => worktree.projectId)
        : [];
    },
  },
  settings: [
    {
      id: "git.settings",
      moduleId: "shipctl.git",
      order: 10,
      load: () => import("./GitSettingsSection"),
    },
  ],
} as const satisfies ShipctlModule;
