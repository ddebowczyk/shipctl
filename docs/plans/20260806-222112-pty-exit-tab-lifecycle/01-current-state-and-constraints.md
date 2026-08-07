# Current state and constraints

## Evidence baseline

This analysis was refreshed on 2026-08-06 after the panel-host refactor advanced
to commit `d4b3b7f`.

Environment:

- macOS 26.2, build 25C56, Apple Silicon (`aarch64-apple-darwin`)
- Rust 1.97.1 and Cargo 1.97.1
- Node 24.15.0 and pnpm 10.28.0
- Tauri 2.10.3
- `portable-pty` 0.8.1
- `bd` 1.1.2 using the repository's embedded Dolt database

Baseline verification:

- `pnpm build`: passed
- `cargo test --manifest-path src-tauri/Cargo.toml`: 59 passed, 0 failed
- zsh status probes: `exit 0` -> 0, `exit 7` -> 7,
  `false; exit` -> 1, and `true; exit` -> 0

The worktree contained unrelated Rust and configuration changes. This plan adds
documentation only and does not claim ownership of those edits.

During final verification, the branch advanced concurrently from `d4b3b7f` to
`a1ff8e3` (`refactor: establish frontend module API`). That commit changed none
of the inspected PTY manager/session, PTY hook, terminal view, tab store,
Tauri bridge, or shared PTY type files. Uncommitted module-composition work did
touch `AppShell`, but its terminal/assistant close route still delegated to
`closeTab`. The mandatory future re-baseline remains the authority if refactor
work advances again.

## Current lifecycle

The authoritative path is already mostly present:

1. `src-tauri/src/pty/session.rs` opens the PTY, owns the child, reads output,
   waits for completion, and sends `PtyOutput::Exit { code }` on the per-session
   Tauri channel.
2. `src-tauri/src/pty/manager.rs` stores each `PtySession` in a map and exposes
   write, resize, kill, count, and shutdown operations.
3. `src/lib/tauri.ts` creates `Channel<PtyOutput>` and forwards messages to the
   caller.
4. `src/hooks/usePty.ts` handles data and exit events for blank shells, saved
   commands, and assistants.
5. `src/stores/useTerminalStore.ts` records `alive: false` and the integer exit
   code.
6. `src/components/terminal/TerminalView.tsx` owns and caches xterm instances.

The event transport is therefore not missing. The missing pieces are host-side
natural-exit cleanup and role-specific frontend completion policy.

## Root cause of the hanging tab

On reader end-of-file, `PtySession` marks its shared alive flag false, waits for
the child, and emits the exit event. It cannot currently remove itself from the
manager map.

Process completion and PTY-stream end-of-file are distinct. The current reader
waits for stream EOF before it waits on the shell child. A descendant retaining
the PTY slave can therefore delay the exit event even after the shell has
finished. Waiting on the child first without coordinating output drain has the
opposite risk: final output can be lost. A universal lifecycle handler must
model and test both facts rather than treating reader EOF as the exit status.

On the frontend, `handlePtyMessage` records the exit and updates command or
assistant continuity state, but it does not remove a successful blank-shell
tab. `TerminalView` continues to route xterm input to `write_pty`; failures are
only logged in development. The result is a visible terminal with no live
shell and no app-owned completion state.

There is also a backend leak in lifecycle accounting: naturally exited
sessions remain in `PtyManager.sessions` until manual tab closure or shutdown.
Consequences include stale `get_pty_session_count` results and retained PTY
resources.

## Why the existing close path is unsafe for auto-close

`closeTab` calls `killPty`, and `PtyManager::kill` removes the session before
running bounded process-tree termination. On Unix, that termination path uses
process-group and descendant discovery plus SIGHUP, SIGTERM, and eventual
SIGKILL.

Calling that path after a natural shell exit creates several risks:

- it can signal background descendants that the user expected to outlive the
  shell;
- it conflates process completion with a user cancellation request;
- it races the reader thread's child wait and final exit event;
- it makes frontend delivery responsible for backend resource ownership.

Natural completion must use a signal-free reap/forget path. Manual close of a
live terminal should keep the existing termination semantics.

## Exit-status constraints

`portable-pty` 0.8.1 has an internal `ExitStatus` containing `code` and an
optional signal description. Its public API exposes `success()` and
`exit_code()`, but no signal accessor. Shep currently discards the success
classification and serializes only the code.

Implications:

- code 0 is a supported cross-platform success signal;
- code 1 is ambiguous and must not be described as a specific signal;
- parsing `Display` output or assuming `128 + signal` would be brittle;
- a richer signal contract requires an upstream/library change or a separate
  platform-aware status capture, plus tests.

The initial feature does not need signal names.

## macOS and portability constraints

PTY allocation is abstracted by `portable-pty`, but Shep's current process-tree
termination is Unix-specific. It invokes `pgrep`, `killpg`, and libc signal
operations. The tested platform for this plan is macOS on Apple Silicon.

The lifecycle model can be platform-neutral, but claiming a universal process
handler across Windows and Unix would be premature. Future Windows support
must supply and test a platform-specific termination adapter; it must not be
silently inferred from the current macOS implementation.

The host-side completion/reaping contract should avoid macOS-only details so
that platform differences remain below it.

## Refactor constraints

The current architecture study classifies terminal/PTY as a core runtime
service while Commands and Assistant modules depend on it. The Phase 1 panel
host work explicitly did not change PTY ownership or implementation.

This change should therefore strengthen `src-tauri/src/pty/` and its narrow
frontend lifecycle port. It should not:

- turn terminal or assistant tabs into generic panel contributions;
- add PTY process policy to `PanelHost` or module-registry code;
- create a second application-wide event bus for per-PTY data;
- extract the PTY foundation while its consumers are still being refactored;
- encode current `AppShell` line-level structure in task descriptions.

## Risk register

- Reusing `kill_pty` after natural exit can terminate background descendants.
  Separate signal-free reaping from requested termination.
- Auto-closing every status-0 PTY can erase command output and assistant state.
  Apply policy through an explicit tab role.
- Frontend-only cleanup leaves stale manager entries and session counts. Make
  the host own natural-exit eviction.
- Exit, manual close, and shutdown can race. Require idempotent lifecycle
  transitions and race tests.
- Child completion and PTY EOF can arrive independently. Coordinate process
  wait with output drain and define a bounded descendant-held-stream policy.
- Removing xterm before queued data flush can lose final output. Flush before
  disposal or status rendering.
- Writing app status into xterm breaks output provenance. Render an app-owned
  overlay or banner.
- Treating every non-zero status as a crash misleads users. Use neutral shell
  wording.
- Leaving input enabled after exit causes repeated dead-PTY writes. Gate input
  on lifecycle state.
- Refactor progress can make tasks obsolete. Require fresh analysis before
  creating child issues.
- Calling the Unix implementation universal creates unsupported Windows
  assumptions. Keep the lifecycle contract portable and test adapters
  separately.

## Opportunities

- Make `get_pty_session_count` describe live host sessions accurately.
- Replace frontend side-table inference such as `stoppingPtys` with a typed,
  testable lifecycle disposition if the fresh design supports it.
- Centralize final-output ordering and idempotent cleanup.
- Give blank shells, saved commands, and assistants an explicit completion
  policy without merging their product semantics.
- Add characterization tests around a foundational runtime before later module
  extraction changes its consumers.
