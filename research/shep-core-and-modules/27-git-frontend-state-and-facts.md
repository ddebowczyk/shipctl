# Git frontend state and project facts

Date: 2026-08-07

Task: `shep-3w1.8.3.2.3`

## Outcome

The Git frontend module at `modules/git/frontend` now owns its transport DTOs,
namespaced Tauri client, project-status store, per-project panel state, generic
project-facts provider, and refresh/removal lifecycle policy.

The host composes `gitModule` only through `src/core/modules/enabledModules.ts`.
The temporary facts adapter in `builtinProjectAdapters.ts` has been deleted, so
there is one project-facts provider and one status-state owner.

## Generic host cutover

Host chrome no longer reads `GitStatus` or the Git Zustand store to render:

- active branch labels and clean/changed color;
- assistant-session branch labels;
- project and tab move-menu ordering;
- worktree lineage labels; or
- project grouping order.

These consumers subscribe through `useProjectFactsMap` and read only the
module API's `ProjectFacts.revision` and `ProjectFacts.lineage` fields. The
mapping hook retains stable snapshots so React's external-store contract is
preserved across unchanged Git refreshes.

The filesystem watcher now dispatches generic module lifecycle notifications.
Git refresh and removal are implemented by `gitModule.projectLifecycle`, and
`AppShell` no longer performs parallel Git-store refresh or cleanup calls.

## Transitional visual bridge

Git panels, the Git sidebar row, and worktree action remain in host-era visual
paths for the next safe slice. They reach module-owned state and clients
through `ENABLED_GIT_FRONTEND`, exported only from the allowed composition
file. The old store and Tauri functions are compatibility import adapters; they
contain no Git state or native command identifiers.

This bridge is intentionally named as compatibility, not legacy. Task
`shep-3w1.8.3.2.4` removes it when the visual files, styles, registrations, and
project-import behavior move into the module.

## Frontend profiles

The normal profile composes `gitModule`. Setting
`VITE_SHEP_GIT_MODULE=disabled` omits its facts and lifecycle contribution, and
`pnpm verify:git-frontend-disabled` proves that transitional profile builds.
Git visual code remains compiled in that intermediate profile because its
physical extraction is deliberately the next slice; full source-absent
plug-out is the acceptance boundary of that slice.

## Verification evidence

```sh
pnpm test:git-characterization
pnpm test:project-surfaces
pnpm test:module-boundaries
pnpm build
pnpm verify:git-frontend-disabled
pnpm typecheck:panel-host-smoke
```

Results: seven frontend and nine backend Git characterization tests passed;
22 project-rail and composition tests passed; module boundaries passed; and
both enabled and Git-contribution-disabled frontend production builds passed.

The characterization now asserts module-owned lifecycle refresh/removal and
statically rejects direct Git-store dependencies in generic host project
chrome.
