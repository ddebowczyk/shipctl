# Git visual surfaces and plug-out gate

Date: 2026-08-07

Task: `shep-3w1.8.3.2.4`

Gate: `shep-3w1.8.3.3`

## Outcome

Git is now an encapsulated vertical module. `modules/git/frontend` owns the
Files panel, file tree and viewers, diff rendering and summary, project status
row, Create Worktree interaction, settings section, styles, stores, DTOs,
native client, and project lifecycle/import policy. `modules/git/backend` owns
the namespaced Tauri commands and Git implementation.

The host imports `gitModule` only in `src/core/modules/enabledModules.ts`.
Everything else is composed through generic panel, navigation, project action,
project layout, project facts, project import, settings, appearance, notice,
and lifecycle contracts.

## Preserved behavior

- The persisted panel remains `core.git`, with project scope, per-project
  singleton behavior, label `Files`, and shortcut `Cmd+G`.
- Pre-generic `kind: git` tabs hydrate through module-owned migration metadata.
- Selection, expansion, viewer mode, preferred diff area, sidebar collapse,
  and scroll state remain independently keyed by project.
- Adding a main worktree can still discover linked worktrees when the module
  setting is enabled; adding a linked worktree still discovers its main
  worktree.
- The status row, diff summary, worktree action, notices, theme-dependent code
  rendering, and unavailable-panel recovery retain their existing host slots.

Characterization now checks the complete contribution identity, generic
shortcut matching, project-import setting behavior, lifecycle refresh/removal,
project facts, panel state, namespaced commands, and absence of direct Git
implementation dependencies from host project chrome.

## Host rails added by this slice

The module API gained three capability-neutral contracts needed by the moved
surfaces:

- a panel host port for opening, revealing, and closing contributed panels;
- an appearance snapshot/subscription port for theme-aware rendering; and
- a project-import contribution for discovering related project paths.

The project watcher remains host infrastructure: it watches registered project
roots and broadcasts lifecycle changes to all enabled modules. Its existing
native event wire name is retained as a compatibility detail; no frontend host
branch interprets Git state.

## Resource ownership

Git-only CSS and frontend dependencies now belong to
`modules/git/frontend/package.json`. The application package no longer declares
the tree, diff, Markdown, or Shiki dependencies. The panel-host smoke fixture
also consumes the public `gitModule` entrypoint and namespaced commands instead
of deleted host stores and flat commands.

## Plug-out proof

`scripts/verify-git-plugout.mjs` verifies three shapes:

1. enabled: characterization, host contracts, production builds, Rust tests,
   and Tauri build;
2. disabled: frontend composition omitted and native Cargo feature omitted;
3. source absent: both Git packages, composition entries, Cargo dependency and
   feature, host adapter, permissions, profile, smoke dependency, and root
   package dependency are physically removed in a disposable copy.

The source-absent profile was executed successfully. Its package graph had six
workspace packages, no `@shep/module-git` or `tauri-plugin-shep-git`, and it
passed generic tests, panel persistence/recovery tests, module boundaries,
smoke typechecking, production frontend build, 43 host Rust tests, and a Tauri
debug build. The standalone frontend-disabled and native-disabled builds also
passed.

## Smoke scope

Automated coverage exercises the changed Git panel, status, tree, diff,
worktree, project lifecycle/import, shortcut, migration, unavailable-panel,
error-containment, and native-command paths. The complete enabled, disabled,
and source-absent matrix also builds a desktop executable in every profile.

The full Phase 0 interactive desktop checklist was not run because the user's
live Shep process owns active PTY and agent sessions. No claim is made here
about unrelated interactive terminal, assistant, shutdown, or restoration
paths; they were deliberately left undisturbed.

## Verification evidence

```sh
pnpm test:git-characterization
pnpm test:project-surfaces
pnpm test:global-surfaces
pnpm test:panels
pnpm check:module-boundaries
pnpm typecheck:panel-host-smoke
pnpm exec tsc --noEmit
pnpm verify:git-frontend-disabled
pnpm verify:git-native-disabled
pnpm verify:git-plugout -- --source-absent-only
pnpm verify:git-plugout
git diff --check
```

Results: nine frontend and nine backend Git characterization tests passed; 23
project-surface tests passed; all generic surface/panel tests passed; enabled,
frontend-disabled, native-disabled, and physically source-absent builds passed.
The final complete matrix passed from committed checkpoint `4ee1d6e`.
