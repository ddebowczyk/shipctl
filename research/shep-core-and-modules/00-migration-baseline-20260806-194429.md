# Shep modularization migration baseline

- Captured: 2026-08-06 19:44:29 CEST
- Beads task: `shep-3w1.1.1`
- Scope: observation and verification only; no runtime source changes

## Baseline result

The current dirty worktree is buildable before modularization begins.

| Check | Result | Evidence |
| --- | --- | --- |
| Frontend production build | Pass | TypeScript and Vite completed |
| Native unit and doc tests | Pass | 59 passed; 0 failed |
| Existing diff whitespace check | Pass | `git diff --check`; no output |
| Beads migration plan lint | Pass | `bd lint shep-3w1 --json`; 0 issues |
| Beads dependency graph | Pass | `bd dep cycles --json`; no cycles |

`pnpm build` completed in 6.39 seconds. Native verification used
`cargo test --manifest-path src-tauri/Cargo.toml`.

The frontend build emitted two non-blocking warnings:

- Node reported that `module.register()` is deprecated in favor of
  `module.registerHooks()`.
- Vite reported chunks larger than 500 kB after minification. The largest
  application entry shown was approximately 866 kB; several syntax assets were
  also above the threshold.

These warnings predate the migration baseline. They are not Phase 0 failures
and should not be opportunistically fixed by modularization tasks unless a task
directly owns their cause.

## Toolchain

- macOS 26.2, build 25C56
- Node.js 26.5.1
- pnpm 10.28.0
- Rust 1.97.1
- Cargo 1.97.1
- `bd` 1.1.2
- `ast-grep` 0.44.0
- Frontend package version 0.5.0
- Native package version 0.5.0; Rust edition 2021; declared minimum Rust 1.77.2

The frontend build script is `tsc && vite build`. The native crate is not yet a
Cargo workspace; Phase 2 owns that transition.

## Pre-existing dirty paths

The following paths were already modified or untracked when the baseline task
started. Their contents belong to ongoing user work and must not be reverted,
normalized, or silently absorbed by migration tasks.

```text
M .gitignore
M src-tauri/src/commands.rs
M src-tauri/src/fonts.rs
M src-tauri/src/git.rs
M src-tauri/src/menu.rs
M src-tauri/src/pi_config.rs
M src-tauri/src/skills.rs
M src-tauri/src/todos.rs
M src-tauri/src/usage/helpers.rs
M src-tauri/src/usage/ingest.rs
M src-tauri/src/usage/mod.rs
M src-tauri/src/usage/providers.rs
M src-tauri/src/usage/queries.rs
M src-tauri/src/watcher.rs
M src/components/layout/AppShell.tsx
M src/lib/types.ts
M src/stores/useTerminalStore.ts
?? docs/plans/20260806-001338-agent-activity-evidence/
?? research/
```

Phase 1 intersects the three dirty frontend paths. Before editing any of them,
the task owner must inspect the current diff and merge around those changes.

## Current panel surface

The live tab model contains six tab kinds:

- PTY-backed: terminal and assistant.
- Local panel tabs: Files/Git, Commands, New Agent launcher, and To-dos.

`AppShell` also directly owns three global overlays (Settings, Usage, and Ports)
and the diff side panel. Phase 1 must inventory these surfaces even if the first
generic registry covers tab-hosted panels only; leaving an undocumented render
branch would produce a false modularity claim.

## Manual smoke contract

This checklist is the regression contract for every phase gate. Phase 0 defines
it; later tasks execute the relevant subset and the phase-closing gate executes
the full set against a built app.

### Projects and shell lifecycle

- Launch Shep with existing project groups and projects; confirm selection and
  sidebar state load without data loss.
- Switch between at least two projects and confirm each project retains its own
  active tab and tab order.
- Move a tab to another project and confirm source and destination state remain
  coherent.
- Resize and toggle the sidebar; confirm configured width, font, and project
  hierarchy remain usable.
- Close and reopen the window through the supported workflow; verify accidental
  quit protection and expected workspace restoration behavior.

### Terminal and assistant continuity

- Open a terminal, run a command that produces output, switch away, and return;
  confirm the PTY remains alive and output is retained.
- Open at least one managed assistant and one terminal-launched assistant;
  confirm focus, input, output, and status indicators do not cross tabs.
- Use Cmd+Tab and Shift+Cmd+Tab to cycle forward and backward exactly once per
  shortcut.
- Use Cmd++ and Cmd+- in a terminal and confirm terminal font scaling does not
  alter sidebar or panel typography.
- Close a normal terminal and an assistant tab; confirm only the intended PTY or
  managed session is stopped and neighboring tabs remain usable.
- Where restart testing is authorized, confirm captured Claude/Codex continuity
  records resume the intended provider session rather than launching a fresh
  conversation.

### Tab-hosted panels

- Open Files/Git in a Git repository and confirm tree, status, diff selection,
  and the diff side panel render; verify a non-Git project shows its designed
  unavailable state.
- Open Commands, launch and stop a configured command, and confirm the resulting
  terminal handoff and working directory.
- Open New Agent, select an available provider/model, launch it, and confirm the
  new assistant tab receives focus.
- Open To-dos in projects with and without TODO files; confirm loading, empty,
  parse, update, and project-switch behavior.
- Reorder tab-hosted panels among PTY tabs and confirm active state and labels
  remain stable.

### Global overlays and settings

- Open and close Settings, Usage, and Ports; confirm each overlays the active tab
  and returns focus/state to it on close.
- Change a reversible setting and confirm persistence after reopening its panel.
- Confirm Usage handles available, stale, and unavailable provider data without
  blocking terminal interaction.
- Confirm Ports refresh and project scoping do not alter unrelated sessions.

### Persistence and failure recovery

- Restart from representative persisted state containing terminal, assistant,
  and each local panel-tab kind; confirm supported tabs restore as designed.
- Load a fixture containing an unknown panel contribution ID; startup must not
  crash or silently delete the record.
- Disable a registered module with one of its tabs persisted; show a generic
  unavailable-panel state with a safe remove path.
- Load malformed persisted panel data; isolate the bad record and leave the rest
  of the workspace usable.
- Force one lazy panel import or backend request to fail; the error boundary must
  contain the failure without taking down AppShell or PTYs.

## Repeatable commands

```bash
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
bd lint shep-3w1 --json
bd dep cycles --json
bd ready --parent shep-3w1 --type task --json
```

No manual smoke actions were executed during Phase 0 because this task is the
contract-definition baseline. The automated baseline is green; phase gates own
manual execution against their changed runtime paths.
