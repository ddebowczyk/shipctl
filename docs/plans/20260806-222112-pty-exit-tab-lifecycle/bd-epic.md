# PTY exit and terminal-tab lifecycle

## Purpose

Implement host-owned PTY completion/reaping and role-aware terminal-tab exit
behavior so a successfully exited blank shell closes automatically, while a
non-zero blank shell remains inspectable with an honest status message.

## Context

- Planning source:
  `docs/plans/20260806-222112-pty-exit-tab-lifecycle/README.md`
- Detailed execution guide:
  `docs/plans/20260806-222112-pty-exit-tab-lifecycle/03-implementation-and-verification.md`
- Snapshot analyzed: branch `codex/assistant-session-continuity`, commit
  `d4b3b7f`, 2026-08-06
- The repository is under a deep refactor. Snapshot filenames and seams are
  evidence, not implementation instructions.
- The existing per-PTY Tauri channel already carries data and exit events.
  Rust owns process resources; TypeScript owns tab-role policy.

## Expected Outcomes

- Naturally completed PTYs are reaped by the Rust host exactly once without
  sending process-tree termination signals.
- A blank interactive shell completing with status 0 closes its tab and moves
  focus predictably.
- A blank shell completing non-zero remains read-only and shows
  `Terminal exited with status N` in app-owned UI.
- Saved-command and assistant tabs retain their current output and continuity
  semantics.
- Manual close and app shutdown retain bounded process-tree termination.
- Final output, race handling, session counts, and cleanup are covered by tests
  and macOS integration evidence.
- Child completion and PTY EOF are coordinated so a descendant-held slave
  cannot hang a completed shell indefinitely.

## Prerequisites

- [ ] Claim this epic before planning implementation work.
- [ ] Read every Markdown file in the planning directory.
- [ ] Read the current `research/shep-core-and-modules/` architecture and gate
      documents.
- [ ] Confirm the live branch, commit, status, and unrelated worktree changes.
- [ ] Reproduce or re-characterize the hanging-tab behavior in the current app.

## Specification

Do not create child issues directly from the snapshot's filenames.

First perform the mandatory re-baseline in
`03-implementation-and-verification.md`:

1. Outline and inspect the live Rust PTY lifecycle and every frontend consumer.
2. Trace natural exit, explicit close, command completion, assistant
   continuity, session counting, and shutdown end to end.
3. Run and record the current build/test baseline.
4. Compare live ownership, event contracts, files, and behavior with the plan.
5. Record dated variance notes for every mismatch.
6. Have the refreshed decomposition reviewed against the plan review checklist.
7. Only then create concrete child issues from candidate packages 0-5.
8. Give each child specific live paths, steps, acceptance criteria, verification
   commands, cleanup, and no-ownership boundaries.
9. Create all children before wiring their blocking dependencies; verify the
   resulting graph and that no unintended work is ready.

The first child must own re-baselining and characterization. It blocks every
implementation child. If analysis shows that work packages should be merged,
split, reordered, or renamed, update the decomposition rather than preserving
the snapshot mechanically.

## Guardrails

- Never parse typed `exit`; react to the authoritative PTY completion event.
- Never call the destructive `kill_pty` path merely because a PTY completed.
- Keep natural completion cleanup host-owned even if the frontend disappears.
- Do not add a second global event bus for high-volume PTY data.
- Auto-close only the explicitly identified blank-shell role.
- Use neutral non-zero shell wording; bare `exit` can inherit prior status.
- Preserve saved-command output, assistant restore/capture behavior, and the
  shutdown registry freeze.
- Flush final buffered output before terminal disposal or status rendering.
- Model child status and PTY EOF separately; use a tested bounded drain policy.
- Treat close/exit/shutdown races as required idempotency cases.
- Keep platform-neutral lifecycle facts above the existing macOS/Unix process
  termination adapter; do not claim untested Windows support.
- Preserve unrelated user changes and the panel-host refactor boundaries.

## Success Criteria

- [ ] Fresh analysis and variance notes precede child creation.
- [ ] Child issues reflect the live refactored codebase, not stale line numbers.
- [ ] Every candidate policy row has implementation and regression coverage.
- [ ] Natural completion is signal-free and host-reaped.
- [ ] Successful blank shells close; non-zero blank shells remain read-only.
- [ ] Commands and assistants have no blanket auto-close regression.
- [ ] Final output and xterm/activity cleanup ordering are deterministic.
- [ ] Manual-close and shutdown process-tree behavior remains bounded.
- [ ] Rust tests, frontend tests, production build, relevant refactor gates, and
      the macOS manual matrix pass.
- [ ] Reviewer confirms the plan checklist before implementation begins.

## Verification

- [ ] `pnpm build`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] Run current frontend policy/lifecycle tests discovered in re-baseline.
- [ ] Run current panel-host/persistence gates discovered in re-baseline.
- [ ] Run the macOS matrix in the plan and attach results.
- [ ] `markdownlint docs/plans/20260806-222112-pty-exit-tab-lifecycle/*.md`
- [ ] `git diff --check`
- [ ] Verify the epic dependency graph and child status with the installed
      `bd` commands.

## Cleanup

- [ ] Remove any short-lived frontend auto-close feature switch after rollout
      confidence is established.
- [ ] Remove transitional lifecycle shims only after all callers migrate.
- [ ] Update durable architecture documentation if PTY ownership or contracts
      changed.
- [ ] Close the epic only after all refreshed child issues and manual evidence
      are complete.
