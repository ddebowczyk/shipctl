# Implementation and verification

## Mandatory re-baseline before subtasks

The codebase is being deeply refactored. Before creating any child issue, the
epic owner must perform and record a fresh analysis.

1. Read this entire plan directory and the current architecture/refactor gate
   under `research/shep-core-and-modules/`.
2. Capture `git status --short --branch` and `git log -5 --oneline`.
3. Preserve unrelated modified and untracked files; identify ownership before
   changing anything.
4. Run syntax-aware outlines for the live PTY manager/session, frontend PTY
   orchestration, tab store, and terminal view.
5. Search all spawn, data, exit, write, resize, close, shutdown, session-count,
   saved-command, and assistant-continuity callers.
6. Reproduce `exit 0` and one non-zero case in the current app if a safe native
   build is available.
7. Run the current frontend build and Rust tests; record unrelated baseline
   failures rather than hiding them.
8. Compare live code with the decisions and assumptions in this plan.
9. Add a dated variance note to the epic or this directory for every changed
   owner, contract, filename, test command, or product behavior.
10. Rewrite the candidate work packages below into concrete child issues only
    after that comparison. Add dependencies after all child IDs exist.

Suggested discovery commands, adjusted to the live tree:

```bash
git status --short --branch
git log -5 --oneline
ast-grep outline src-tauri/src/pty src/hooks/usePty.ts \
  src/components/terminal/TerminalView.tsx \
  src/stores/useTerminalStore.ts --json=stream
rg -n "PtyOutput|spawn_pty|write_pty|kill_pty|session_count|closeTab" \
  src src-tauri/src
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
```

The filenames are snapshot evidence, not a requirement to preserve the current
layout.

## Candidate work packages

These are planning units for future child issues, not issues to create blindly.

### 0. Re-baseline and characterize the lifecycle

Purpose: freeze the live behavior before changing a foundational runtime.

Specific steps:

- complete the mandatory analysis above;
- document the live sequence for natural exit, explicit close, saved command,
  assistant completion, and application shutdown;
- characterize shell-child completion separately from PTY EOF, including a
  fixture whose descendant temporarily retains the slave stream;
- add the smallest tests needed to expose stale host sessions and current tab
  policy;
- decide whether an explicit tab-role discriminator is now available;
- record the selected host-cleanup seam and event contract;
- update later child descriptions to match the current refactor.

Exit evidence:

- original behavior is reproducible or its replacement is documented;
- tests fail for the missing natural-exit cleanup/policy for the expected
  reason;
- no implementation task relies on stale paths or assumptions.

### 1. Make the Rust host own PTY completion and reaping

Purpose: ensure naturally completed PTYs leave live host accounting without
termination signals.

Specific steps:

- introduce an internal completion path from session wait to manager cleanup;
- coordinate child status with final output drain and a bounded
  descendant-held-stream policy;
- make natural completion, explicit close, and shutdown transitions idempotent;
- preserve final-data-before-exit ordering;
- expose only supported status facts;
- retain shared-deadline process-tree termination for requested shutdown;
- verify direct shells and assistant-spawned PTYs use the same lifecycle;
- ensure `session_count`, writes, resizes, and late kills observe completed PTYs
  consistently.

Required tests:

- status 0 and non-zero natural completion remove the manager entry exactly
  once;
- natural completion does not call termination;
- explicit close and natural completion racing are safe;
- shutdown and completion racing are safe;
- final data is emitted before exit;
- child exit with a descendant-held slave does not hang indefinitely or lose
  the documented final-output boundary;
- session count returns to the expected value.

### 2. Centralize TypeScript completion handling and blank-shell policy

Purpose: apply product policy by role without weakening command or assistant
behavior.

Specific steps:

- create one testable completion reducer/handler;
- flush pending output before removal or retained-state rendering;
- identify blank shells through the live explicit role contract;
- remove successful blank-shell tabs without invoking `kill_pty`;
- preserve saved-command and assistant completion behavior;
- make duplicate, missing-tab, project-move, and manual-close races no-ops;
- clean terminal cache and activity state only at the correct lifecycle point.

Required tests:

- successful blank shell auto-closes and selects the correct neighbor;
- successful command and assistant tabs remain;
- non-zero blank shell remains;
- no natural-exit policy calls the destructive close command;
- duplicate exit does not remove another tab or corrupt activity;
- a moved tab is removed from current placement, not assumed launch placement.

### 3. Add retained non-zero terminal completion UI

Purpose: explain a dead shell without fabricating PTY output.

Specific steps:

- render an app-owned `Terminal exited with status N` state;
- make completed terminals read-only in normal and custom-keybinding paths;
- add an accessible close action using frontend-only cleanup for reaped PTYs;
- preserve scrollback, selection, links, and copy behavior;
- align sidebar wording for generic shells with neutral status language;
- verify light/dark themes and keyboard focus.

Required tests:

- status text and status number render correctly;
- completed terminal input does not invoke `write_pty`;
- close removes the tab without invoking process-tree termination;
- saved-command failure wording remains intentionally role-specific.

### 4. Protect command and assistant continuity integrations

Purpose: prove the shared lifecycle does not erase or corrupt higher-level
consumers.

Specific steps:

- characterize saved-command status and PTY-ID clearing on all dispositions;
- preserve assistant restore probation, capture timers, rearm/discard rules,
  and shutdown freeze;
- remove or narrow `stoppingPtys` only after equivalent typed behavior exists;
- verify direct spawn, new assistant spawn, and resumed assistant spawn consume
  the same completion contract;
- add regression tests for fast failed resume and established natural exit.

Exit evidence:

- no blanket auto-close applies to command or assistant tabs;
- restore records have the same intended survival/removal semantics;
- application shutdown does not race new frontend mutations.

### 5. Run macOS integration proof and close documentation

Purpose: validate real PTY/job-control behavior beyond unit tests.

Automated gates:

```bash
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
markdownlint docs/plans/<this-directory>/*.md
git diff --check
```

Run any current panel-host or persistence gates found during the re-baseline.

Manual macOS matrix:

| Scenario | Expected result |
| --- | --- |
| Blank shell: `exit 0` | Tab closes; next deterministic tab gets focus |
| Blank shell: bare `exit` after `true` | Tab closes |
| Bare `exit` after `false` | Read-only tab remains with status 1 |
| Blank shell: `exit 7` | Tab remains, read-only, status 7 shown |
| Blank shell: end-of-file | Policy follows authoritative completion status |
| Typing in completed non-zero tab | No backend write occurs |
| Successful saved command completes | Output tab remains |
| Failed saved command completes | Output tab remains with intentional status |
| Assistant exits naturally | Existing restore/discard policy remains |
| Fast resume failure | Durable restore record is rearmed as before |
| Manual close of live shell | Existing bounded tree termination works |
| Exit with detached child | No explicit tree kill; child survives |
| Descendant retains PTY slave | Bounded documented drain behavior |
| Exit races manual close | No duplicate signal or corrupt state |
| Multiple tabs/projects | Correct placed tab closes; focus is stable |
| App quit with live PTYs | Shared grace deadline and force-kill fallback work |
| App quit after natural exits | Session count excludes already reaped PTYs |

Use a disposable detached-process fixture and clean it up after the test. Do
not infer survival from shell job-control behavior alone; distinguish what zsh
does from any signal Shep sends.

## Dependency shape

After creating child issues from the refreshed packages, use this default
shape unless the new architecture requires a documented change:

```text
0 Re-baseline and characterize
|
v
1 Rust lifecycle/reaping
|
v
2 TypeScript lifecycle/policy
|\
| +--> 3 Non-zero completion UI
|
+----> 4 Command/assistant regression protection
          \                         /
           +----> 5 macOS proof ---+
```

Package 0 blocks every implementation package. Package 1 blocks package 2.
Packages 3 and 4 depend on package 2. Package 5 depends on packages 3 and 4.
Add dependencies only after all child IDs exist and verify them with `bd dep`
and `bd blocked` commands supported by the installed version.

## Plan review checklist

Before child creation, a reviewer must confirm:

- the issue is not being solved by parsing the text `exit`;
- natural completion cannot reach a process-tree kill path;
- host-side cleanup does not depend on frontend delivery;
- successful auto-close applies only to the intended shell role;
- non-zero shell language is neutral;
- command output and assistant continuity are preserved;
- final output ordering and xterm cache disposal are explicit;
- race and idempotency tests exist;
- macOS-specific termination is not presented as cross-platform proof;
- every task cites live files and commands from the fresh analysis;
- unrelated worktree changes remain untouched.

## Definition of done

The epic is done only after every refreshed child issue is closed, automated
and manual evidence is attached, the original hanging-tab reproduction is
resolved, and no known regression remains in manual close, app shutdown,
commands, or assistant continuity.
