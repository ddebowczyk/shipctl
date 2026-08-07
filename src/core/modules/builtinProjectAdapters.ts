import type {
  ProjectActionContribution,
  ProjectFacts,
  ProjectFactsProviderContribution,
  ProjectLayoutContribution,
} from "@shep/module-api";

import type { GitStatus } from "../../lib/types";
import { useGitStore } from "../../stores/useGitStore";

const factCache = new WeakMap<GitStatus, ProjectFacts | null>();

function factsForStatus(status: GitStatus | undefined): ProjectFacts | null {
  if (!status?.is_git_repo) return null;
  const cached = factCache.get(status);
  if (cached !== undefined) return cached;
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

/** Temporary adapter removed when the Git frontend module owns this provider. */
export const BUILTIN_PROJECT_FACTS_PROVIDERS = [
  {
    id: "git.project-facts",
    moduleId: "shep.git",
    getFacts: (project) => factsForStatus(
      useGitStore.getState().projectGitStatus[project.path],
    ),
    subscribe: (listener) => useGitStore.subscribe(listener),
    refresh: (project) => useGitStore.getState().refreshStatus(project.path),
  },
] as const satisfies readonly ProjectFactsProviderContribution[];

/** Temporary adapter removed when the Git frontend module owns this surface. */
export const BUILTIN_PROJECT_LAYOUT_CONTRIBUTIONS = [
  {
    id: "git.diff-summary",
    moduleId: "shep.git",
    slot: "workspace.trailing",
    order: 10,
    load: () => import("../../components/git/DiffSummaryProjectSurface"),
  },
] as const satisfies readonly ProjectLayoutContribution[];

/** Temporary adapter removed when the Git frontend module owns this action. */
export const BUILTIN_PROJECT_ACTION_CONTRIBUTIONS = [
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
          surface: {
            load: () => import("../../components/git/CreateWorktreeProjectActionSurface"),
          },
        },
      ],
    }),
  },
] as const satisfies readonly ProjectActionContribution[];
