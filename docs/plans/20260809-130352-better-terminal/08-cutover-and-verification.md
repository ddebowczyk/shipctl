# Cutover, deletion, and full verification

## Objective

Complete the clean terminal replacement, migrate every caller, delete the old
architecture and temporary shims, and prove the result across Rust, Tauri,
React/xterm, modules, the authenticated control socket, CLI, shutdown, and
renderer reload.

This document is self-contained and is the final execution checklist. The
refactor is not done because the new service exists; it is done only when one
authoritative terminal architecture remains and all behavioral contracts pass.

## Final architecture being cut over

The target has:

- opaque UUID-backed `TerminalId` strings end-to-end;
- `TerminalService` as app-process registry;
- one ordered `TerminalRuntime` per process-bearing terminal;
- direct shell/program launch semantics;
- continuous host VT parsing and exact replay;
- detachable, bounded, isolated attachments;
- retained exit descriptors until explicit close;
- idempotent list/get/write/resize/close/report operations;
- a concurrent authenticated control server supporting live attach;
- renderer startup reconciliation and xterm replay;
- module adoption through safe owner descriptors;
- explicit agent activity supplemental to host process lifecycle.

It does not keep terminals alive after the Shipctl app process exits and does
not introduce a general resource tree or multiplexer.

## Execution order

Use the following dependency order. Work may be committed in smaller coherent
changes, but do not expose two production authorities for the same operation.

### 1. Characterize and stabilize current defects

Add behavior tests for:

- global kill/kill-all lock release;
- renderer channel loss and child reap;
- natural exit after output-delivery failure;
- one login shell versus direct program argv;
- escaped descendant termination;
- current query/theme/resize/flow-control behavior.

Apply the minimal safety fixes if the old implementation remains runnable while
the replacement is developed. These tests become replacement-runtime tests.

### 2. Preserve the selected VT strategy

Rerun the checked-in proof, build/platform check, query-response check,
license/update review, and memory/transport derivation. The selected strategy
is pinned `libghostty-vt` with host-canonical reset/resize/replay. Do not begin
the final runtime if split replay plus later bytes diverges from fresh final
host replay; resolve the adapter or choose an explicit versioned snapshot
protocol first.

### 3. Introduce terminal domain and runtime

Add typed IDs, launch target, descriptor, lifecycle, exit, owner metadata,
ordered runtime, parser, process termination, and unit tests. Do not add a Tauri
channel to the runtime.

### 4. Replace the backend registry

Install `TerminalService` as managed app state, migrate commands and shutdown
activity, retain exited records, and prove registry lock boundaries. Route any
temporary old command adapter into this service.

### 5. Add exact detachable attachments

Implement atomic replay-plus-live registration, subscriber workers, overflow
resync, attachment generation, canonical renderer resize authority, and Tauri
attachment commands. Remove backend ACK ownership once frontend recovery works.

### 6. Migrate the renderer projection

Introduce the renderer client runtime, string/branded IDs, startup reconciliation,
registry notifications, xterm replay queue, input gating, and explicit close.
Delete `usePty` ownership maps/counters/timers as their replacements land.

### 7. Migrate module contracts and call sites

Remove module output channels and numeric IDs; migrate assistants, commands,
Tauri module adapters, stable owner metadata, adoption, exit, and close cleanup.
Run modularity checks before proceeding.

### 8. Add control-socket terminal operations

Version the protocol, make connections concurrent, add finite operations and
attach streams, then add CLI commands and structured/raw output behavior. Prove
an open attach does not block other control operations.

### 9. Add explicit agent reports

Add environment-injected ID reporting, host revisions, descriptor/renderer
activity, and provider-owned integrations. Keep process lifecycle independent.

### 10. Delete compatibility code and prove the whole system

Run the deletion audit and every required test lane below. Fix only claims that
break the stated acceptance contract. No migration alias, feature flag, or dead
type remains after this step.

## Safe temporary migration seams

Allowed only while a slice is incomplete:

- an old Tauri command name delegating to `TerminalService`;
- a conversion from old numeric frontend state loaded within the same renderer
  session, if an in-branch incremental compile requires it;
- a compile-time switch used to compare old/new runtime behavior;
- an adapter from a module's old launch call to the new descriptor.

Each seam must have:

- a named deletion point in the same refactor;
- no new business logic;
- tests focused on the new authority;
- no persistence/wire promise that would make it public compatibility debt.

Not allowed:

- running old and new PTY runtimes for different terminal types in production;
- permanent `PtyManager` and `TerminalService` selection;
- accepting both numeric and string terminal IDs on public boundaries;
- keeping spawn-time channels for modules while core uses attachments;
- hiding incomplete replay behind a feature flag and declaring reattach done.

## Deletion audit

Run focused `rg` searches after all call sites migrate. Inspect every remaining
match; do not blindly replace unrelated channel or ID code.

Required terminal-path matches to eliminate or justify:

```text
PtyManager
PtySession
spawn_pty
kill_pty
write_pty
resize_pty
ack_pty_output
PtyOutput
ptyId
pty_id
Channel<TerminalOutput
Channel<PtyOutput
on_data
onOutput
hostTerminalSessions
hostTerminalSessionCounter
stoppingPtys
activityTimers
nextTabId (when used for terminal view identity)
terminalId: number
```

Expected deletions or rewrites include:

- `core/backend/src/terminal/manager.rs`;
- `core/backend/src/terminal/session.rs`;
- old manager/session exports and tests;
- `usePty.ts`'s ownership implementation;
- old Tauri numeric command DTOs;
- `ack_pty_output` and `OutputFlow` coupling;
- module terminal output pass-through types and channels;
- renderer-local stable session/owner counters.

It is acceptable for filenames to be replaced rather than deleted if they now
contain the new responsibility and no obsolete type. Prefer names that match
the final model.

## Cross-capability behavior proof

Build an integration harness that can control renderer connect/disconnect and
observe child identity without using private maps. Prove these scenarios:

### Core terminal lifecycle

1. Spawn a blank shell.
2. Verify one login-shell path and injected instance/terminal IDs.
3. List/get it by stable ID.
4. Write and resize it.
5. Detach every view; verify child still runs.
6. Reattach; verify exact screen and later interaction.
7. Exit naturally; verify final replay/exit descriptor remains.
8. Close twice; verify first removes and second is a successful no-op.

### Concurrency and lock isolation

1. Spawn terminals A and B.
2. Put A into the proven termination grace/descendant path.
3. While A closes, list/get/write/resize B.
4. Assert B remains responsive and registry inspection completes.
5. Repeat through application shutdown/kill-all behavior.

Use deterministic barriers or hooks around termination rather than relying on
sleep timing.

### Attachment isolation and resync

1. Attach fast and intentionally stalled subscribers to one terminal.
2. Produce enough output to trigger the derived mailbox bound on the stalled
   subscriber.
3. Verify the stalled subscriber gets overflow/resync or closes with that typed
   reason.
4. Verify the fast subscriber and parser remain current.
5. Reattach the stalled client and compare exact state.
6. Fail a Tauri channel and a control socket independently; neither kills the
   process.

### Renderer restart

1. Produce terminal state using cursor movement, color, scrollback, resize, and
   alternate screen.
2. Destroy/reload the renderer while the child continues producing output.
3. Verify reconciliation creates exactly one view with the same terminal ID.
4. Verify replay plus live bytes match fresh final host replay exactly. For
   non-resize streams, also verify the uninterrupted xterm diagnostic; for
   resize, verify the documented authoritative host replay boundary.
5. Verify input and resize work after the new attachment becomes live.
6. Verify stale old-generation events are ignored.

### Modules

For assistants and commands:

1. Launch through the module using direct argv.
2. Verify descriptor owner metadata is serializable/redacted.
3. Reload renderer/module runtime.
4. Verify adoption reconstructs one logical session and one terminal view.
5. Fail/detach the renderer and verify module cleanup does not run.
6. Exit naturally and verify retained module/session state.
7. Explicitly close and verify cleanup runs exactly once.

Exercise every bundled assistant/provider launch and resume path whose argv/env
shape differs.

### Control socket and CLI

1. Open a terminal attach stream on connection A.
2. Run inspect/list/get/write on connection B.
3. Close through B and verify final events on A.
4. Repeat with shutdown while A is idle.
5. Verify finite TOON/JSON output, NDJSON event mode, raw mode, byte-safe stdin/
   base64 write, typed errors, and exact protocol version mismatch.

### Agent activity

1. Report working/blocked/completed/idle using injected environment IDs.
2. Verify host revisions and renderer/module projection.
3. Reload renderer; verify activity/attention survives.
4. Verify completed does not exit/close the process.
5. Race report and exit and accept only one valid order.

## Unit and focused test lanes

Run focused tests while implementing each slice, including:

- backend terminal service/runtime/process/replay tests;
- frontend terminal reconciliation/output queue/renderer tests;
- assistants backend/frontend/runtime tests;
- commands runtime ownership/adoption tests;
- instance protocol/server/CLI tests;
- VT/xterm equivalence fixtures.

Use the repository's existing direct Node test invocations for terminal tests,
including the tests under `core/frontend/terminal/tests/`, and extend them with
the new reconciliation and replay cases.

## Repository verification commands

From the repository root, run the applicable focused commands first, then the
full gates:

```sh
just test rust
just check types
just test fast
just modularity boundaries
just instance-control contract
just check all
```

Use `cargo test --workspace` directly if a failure needs Rust-only diagnosis.
Use the explicit Node test commands from `ops/test/justfile` when isolating
terminal queue/session/renderer tests. Do not create a second ad hoc test
runner.

Also run:

```sh
git diff --check
markdownlint docs/plans/20260809-130352-better-terminal/*.md
```

If the repository config requires a wrapper for Markdown linting, use the
existing `just`/ops command rather than bypassing it.

## Modularity and placement audit

Confirm:

- Rust terminal behavior lives under `core/backend/src/terminal/`;
- Tauri shell code only registers state and adapts modules/commands;
- renderer terminal behavior lives under `core/frontend/terminal/`;
- cross-capability frontend imports use exported `@shipctl/core/<capability>`
  entrypoints;
- module feature behavior remains under its module;
- `modules/api` contains only shared contracts;
- `src/` remains Vite entry code;
- `ops/` is not imported by application code.

## Performance and memory evidence

Do not set arbitrary performance gates. Measure before and after using existing
assistant workloads and terminal fixture streams:

- input-to-echo latency under heavy output;
- PTY drain and parser throughput;
- replay construction/application time;
- retained memory per running terminal with zero and multiple subscribers;
- process-wide subscriber queue memory at derived bounds;
- renderer pending xterm writes;
- control attach serialization/base64 overhead.

Investigate regressions that break current behavior or the derived transport/
memory contract. Record measurements as evidence; do not turn an unowned target
number into a release gate.

## Failure observability

Use structured internal diagnostics for:

- terminal ID and lifecycle transition;
- attachment ID/generation and detach reason;
- subscriber overflow/resync reason;
- child termination/reap result;
- control protocol error code;
- renderer reconciliation/resync failure.

Never log raw terminal bytes, argv, environment values, owner metadata blobs,
or tokens. Frontend production logging remains off; user-facing errors use the
notice system.

## Rollback strategy

Rollback at coherent commit/slice boundaries. Do not ship a runtime switch that
keeps two long-term architectures.

Before the final cutover, a branch can revert the entire replacement to the
stabilized old implementation. After numeric IDs and module/control protocols
change, rollback must revert the matching backend, frontend, modules, CLI, and
protocol version together. Never roll back only the renderer or only the
control schema across an exact-version boundary.

## Acceptance criteria

- [ ] Kill/kill-all never hold the registry lock during process work.
- [ ] Channel/socket/renderer failure detaches observers and always reaps a
      genuinely exiting child.
- [ ] Shell/program launch semantics are explicit and tested.
- [ ] Stable string `TerminalId` is used on every boundary.
- [ ] Host registry owns metadata, lifecycle, exit, and current VT state.
- [ ] Replay plus live attach has no gap/duplication.
- [ ] Slow subscribers are isolated and recover through reattach.
- [ ] Natural exit remains discoverable until explicit close.
- [ ] Renderer reconciliation is idempotent and exact across reload.
- [ ] Assistants and commands adopt terminals without output channels.
- [ ] Control list/get/attach/write/close are concurrent and authenticated.
- [ ] Explicit agent reports are revisioned and supplemental.
- [ ] Old manager/session/ACK/channel/counter code and temporary shims are gone.
- [ ] Focused tests and every repository gate above pass.
- [ ] `rg` deletion audit and `git diff --check` are clean.

Only mark the refactor complete when every checked item has executable or
inspection evidence. An open known item that breaks one of these criteria keeps
the refactor open; speculative enhancements outside the stated architecture do
not.
