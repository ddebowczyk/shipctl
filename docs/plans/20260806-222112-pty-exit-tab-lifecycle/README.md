# PTY exit and terminal-tab lifecycle plan

Status: proposed; review and live-code re-baseline are required before creating
implementation subtasks.

Snapshot: 2026-08-06 on `codex/assistant-session-continuity` at `d4b3b7f`.

## Bottom line

Shep should automatically close only a blank interactive shell tab after its
PTY reports successful completion. A non-zero completion should leave that tab
open, make it non-interactive, and show neutral app-owned text such as
`Terminal exited with status 7` plus a close action.

The fix belongs on both sides of the existing boundary:

- Rust/Tauri owns PTY process lifecycle, reaping, and idempotent cleanup.
- TypeScript owns tab-role policy, focus selection, terminal disposal, and the
  retained non-zero status UI.
- The existing per-PTY Tauri `Channel<PtyOutput>` remains the event transport.
  A second global event emitter is not needed for this problem.

The backend must reap every naturally completed PTY, regardless of whether its
frontend tab is retained. The frontend must not call the current `kill_pty`
path in response to natural completion because that path intentionally signals
the process tree.

## Scope decision

The initial auto-close policy is deliberately narrow:

- Blank interactive shell: status 0 closes automatically; non-zero retains a
  read-only tab and shows the status.
- Saved workspace command: retain output and existing command-state behavior
  for every status.
- Assistant session: preserve current continuity behavior for every status.

A blank interactive shell is currently represented by `kind === "terminal"`,
`commandName === null`, and `assistantId === null`. The implementation should
replace this structural inference with an explicit role only if the fresh
codebase analysis shows that the ongoing refactor has established an
appropriate discriminator.

## Why non-zero is not automatically an error

In zsh, bare `exit` returns the current shell status. For example,
`false; exit` returns 1 while `true; exit` returns 0. A non-zero status can
therefore be intentional or inherited; it is not proof that Shep or the PTY
crashed.

Use `Terminal exited with status N` for a generic shell. Keep stronger
`failed` or `crashed` language only where a saved command's product semantics
already define non-zero as failure.

## Plan documents

- [Current state and constraints](./01-current-state-and-constraints.md)
- [Target design and policy](./02-target-design.md)
- [Implementation and verification](./03-implementation-and-verification.md)
- [bd epic body and re-baseline gate](./bd-epic.md)

## Acceptance summary

The implementation is complete only when all of the following hold:

- A blank shell finishing successfully through `exit`, `exit 0`, or end-of-file
  closes its tab and activates the deterministic neighboring tab.
- A blank shell finishing non-zero remains visible, preserves its output, does
  not accept input, and reports the status without pretending it is PTY output.
- Natural completion removes the PTY from host-side live-session accounting
  without sending termination signals.
- Saved-command tabs and assistant tabs do not acquire blanket auto-close
  behavior.
- Manual close of a live PTY and application shutdown retain their bounded
  process-tree termination behavior.
- Final buffered output is flushed before terminal disposal or status display.
- Duplicate and racing close/exit/shutdown paths are idempotent.
- Rust lifecycle tests, TypeScript policy tests, production build, and macOS
  manual scenarios pass.

## Planning gate

This directory records a design against one fast-moving snapshot. It is not
permission to create stale, file-by-file tasks.

After this plan is reviewed, the epic owner must first re-run the analysis in
[the implementation guide](./03-implementation-and-verification.md). Only then
may they create child issues from the candidate work packages, rewritten to
match the live ownership boundaries, filenames, tests, and current behavior.
