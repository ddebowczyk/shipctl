import type { ProjectFacts, ShepModule } from "@shep/module-api";

import * as client from "./client";
import { useGitPanelStore } from "./panelStore";
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
} as const satisfies ShepModule;

/** Removed when Git visual surfaces move into this package. */
export const gitFrontendCompatibility = {
  ...client,
  useGitStore,
  useGitPanelStore,
} as const;

export * from "./client";
export type * from "./types";
export type { ProjectPanelState } from "./panelStore";
export { useGitPanelStore, useGitStore };
