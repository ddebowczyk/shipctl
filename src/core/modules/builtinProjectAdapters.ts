import type {
  ProjectActionContribution,
  ProjectLayoutContribution,
} from "@shep/module-api";

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
