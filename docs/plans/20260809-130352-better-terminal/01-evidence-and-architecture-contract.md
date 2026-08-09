# Evidence and architecture contract

## Objective

Before implementation begins, turn the verified defects and the useful Fut and
cmux mechanisms into executable architecture constraints. This document is
self-contained: a team can use it to establish the target vocabulary, write
characterization tests, run the VT proof, and reject attractive but incorrect
scope expansions.

## Verified Shipctl state

The current backend is in `core/backend/src/terminal/`:

- `manager.rs` stores `PtySession` values in one
  `Mutex<HashMap<u32, PtySession>>`.
- `kill` removes a session and invokes process termination before the map guard
  is dropped. `kill_all` drains and terminates under the same global guard.
  Because termination includes a grace period, unrelated terminal operations
  can be blocked for that period.
- `session.rs` gives a spawned PTY exactly one Tauri `Channel<PtyOutput>`.
  This is the dead-channel defect. Delivery failure stops the coalescer. A
  reader-side send failure can return
  before the child wait/reap path. The frontend disappearing can therefore
  strand backend state or a child rather than simply removing an observer.
- `PtySession::spawn` wraps every launch in `$SHELL -l -i -c`. The blank-shell
  call site passes `${shell} -l`, producing a second login-shell wrapper.
- Natural completion removes the session from the manager, so the renderer
  cannot rediscover a terminal's exit state.
- IDs are host-minted `u32` values, but the frontend also creates renderer-only
  tab and module-session counters. None is an application-wide terminal
  identity that can be listed and reattached.

The current renderer coupling is in:

- `core/frontend/platform/tauri.ts`, where `spawnPty` constructs the only
  output channel.
- `core/frontend/terminal/usePty.ts`, which owns activity timers, stop
  correlation, host/module session maps, output listeners, and renderer-local
  session IDs.
- `core/frontend/terminal/terminalOutputQueue.ts`, which couples xterm writes
  to the backend's ACK-based flow control.
- `core/frontend/terminal/TerminalView.tsx`, where mount/unmount controls the
  xterm queue but cannot detach/recreate the backend output source.

The module coupling is in:

- `modules/api/backend/src/lib.rs` and
  `src-tauri/src/modules/assistants.rs`, where `TerminalAuthority::spawn`
  requires a `Channel<TerminalOutput>` and returns `u32`.
- `modules/assistants/backend/src/lib.rs` and its frontend client, which carry
  that channel through plugin commands.
- `modules/api/frontend/src/services.ts`, where managed-terminal results expose
  `terminalId: number` and launch accepts an output callback.

The control socket in `core/backend/src/instance/` is authenticated and
versioned, but it has no terminal operation. Its accept loop handles a
connection synchronously, so a long-lived attachment would block later
connections unless the server is changed.

## Corrections to the research suggestions

Carry these corrections into code review:

- Do not replace Shipctl's descendant termination with process-group kill
  alone. The existing recursive descendant capture handles children that
  escape via `setsid`; that behavior is required.
- Do not claim that parsing a bounded raw-byte ring on demand restores the
  current screen. It cannot recover state established before the ring.
- Do not make module session IDs, view IDs, and terminal IDs one identifier.
  They represent different ownership and lifecycle.
- Do not move project/tab/focus topology into the terminal registry. The host
  owns terminal content; the frontend project capability owns placement.
- Do not treat explicit agent reports as process lifecycle. Reports can become
  stale; the host's child/PTY state remains authoritative.
- Do not copy Fut's complete resource tree or two-phase topology mutations.
  Shipctl does not need a second session/workspace/tab/pane model.

## Mechanisms adopted from Fut

The relevant Fut source is under `src/terminal/runtime.rs`, `src/daemon/mod.rs`,
`src/protocol.rs`, and `src/domain.rs`.

Adopt these mechanisms conceptually:

1. **Typed UUID identities.** `TerminalId` is a domain type, not a transport or
   renderer handle.
2. **One ordered runtime owner.** Fut initializes its VT parser before spawning
   the child, sends PTY bytes and commands through bounded queues, owns child
   wait/close in the runtime, and publishes lifecycle independently of clients.
3. **Continuous latest state.** A watch-style state publisher lets a new client
   receive a complete current screen before later updates.
4. **Detachable watchers.** Attachment tasks subscribe to snapshots, events,
   and lifecycle; dropping an attachment aborts watchers, not the terminal.
5. **Separate transport writer.** Connection reads do not block on a slow
   connection writer; pending state snapshots can coalesce.
6. **Revisioned agent activity.** Explicit idle/working/blocked/completed
   reports update supplemental activity and attention state.

Do not copy Fut's per-user daemon exit policy, attachment lease shutdown, full
resource tree, snapshot-per-client UI protocol, arbitrary constants, or
Ghostty dependency without running Shipctl's proof gate.

## Mechanisms adopted from cmux-tui

The relevant cmux-tui source is in
`crates/cmux-tui-core/src/surface.rs`, `server.rs`, and `mux.rs`.

Adopt these mechanisms conceptually:

1. **Content runtime versus placement.** `PtyTerminalRuntime` owns the process,
   parser, geometry, and stream, while a surface is a view placement. Shipctl's
   equivalents are `TerminalRecord`/`TerminalRuntime` and `TerminalViewId`.
2. **Atomic attach boundary.** cmux builds VT replay and registers the live tap
   under the same terminal lock. No byte can be parsed between those actions.
   Shipctl should make this one ordered runtime command and return a sequence
   boundary.
3. **Bounded independent taps.** Each attach stream has its own bounded queue.
   Overflow cancels that tap, and a frontend reattaches from fresh state.
4. **Explicit resynchronization.** A reset or resize can send a complete replay
   rather than assuming the mirror stayed in sync.
5. **First frame contract.** `vt-state` is delivered before live output. The
   frontend resets, resizes, applies replay, and only then enables input.
6. **Stable content catalog.** Closing a placement need not close its terminal
   runtime; explicit content close removes the catalog owner and projections.

Do not copy cmux's durable terminal-host handoff, host-record files, renderer
credentials, Kitty graphics state, multiple view geometry arbitration,
browser/surface multiplexing, or general resource topology.

## Domain vocabulary to lock before code changes

Create these domain concepts in Rust and mirror them in TypeScript:

- `TerminalId`: opaque UUID string minted once before child spawn.
- `TerminalViewId`: frontend placement identity. Use a branded type. A helper
  may deterministically derive `terminal:<TerminalId>` for the default view,
  but the types must remain distinct.
- `TerminalLifecycle`: `starting`, `running`, `closing`, or `exited`. Starting
  and closing may be internal; list/get must at least distinguish running and
  exited.
- `TerminalExit`: exit code when known, reason/source, and observed timestamp.
- `TerminalDescriptor`: public, redacted, serializable current state.
- `TerminalOwner`: core terminal or module owner descriptor.
- `TerminalMetadata`: label, cwd, project placement path, display command name,
  created timestamp/order, and owner data required to rebuild projections.
- `TerminalLaunchTarget`: either `Shell` or `Program { program, argv }`.
- `TerminalEvent`: sequenced output, resize/replay, lifecycle, metadata, agent
  activity, resync-required, and detached events.
- `TerminalAttachmentId`: identifies one disposable subscriber, never the
  process.
- `TerminalRevision`: monotonically increasing record revision used to merge
  list, attach, and lifecycle races.

Define a shared JSON value type for opaque module metadata. Do not leave
`ownerMetadata` as `unknown`; values must be recursively limited to JSON null,
boolean, number, string, arrays, and string-keyed objects. Reject functions,
class instances, `undefined`, non-finite numbers, and cyclic values before
crossing IPC.

## Descriptor contract

`TerminalDescriptor` must contain enough state to rebuild UI and module
ownership without exposing launch secrets:

```text
id
revision
lifecycle
exit (only when exited)
label
cwd
project_path / placement hint
display command name (not argv)
created_at
owner descriptor
canonical cols/rows
output revision or last-output timestamp
agent activity (when available)
```

It must not contain:

- the environment map;
- command arguments;
- shell source strings;
- control-socket credentials;
- module secrets or provider tokens;
- a raw PTY object, Tauri `Channel`, or renderer object.

Add serialization tests that scan representative descriptors and prove secret
sentinels in argv/environment never appear.

## VT library proof gate

Run this gate before building the replacement runtime. Evaluate at least the
candidate already proven in Fut/cmux (`libghostty-vt`/`ghostty-vt`) and any
Shipctl-native alternative the team considers maintainable. Do not choose by
API aesthetics alone.

The spike must provide a small Rust adapter with:

- initialize at validated terminal dimensions;
- feed arbitrary PTY byte chunks continuously;
- update dimensions;
- obtain xterm.js-compatible replay bytes or a complete snapshot that Shipctl
  can render exactly;
- expose any terminal-generated query responses that must be written back to
  the PTY;
- return bounded errors rather than allocate from untrusted dimensions;
- build on every platform Shipctl currently supports;
- document license, pinning/update strategy, and binary/build impact.

Build fixture streams covering ordinary text, wrapping, cursor movement,
erase, colors, hyperlinks if supported today, alternate screen, synchronized
output, Unicode/graphemes, resize, and shell query/response sequences. For each
fixture compare:

1. xterm.js fed the uninterrupted original bytes as a compatibility
   diagnostic;
2. xterm.js reset and fed a host replay captured at a split point, followed by
   the remaining original bytes; and
3. xterm.js reset and fed a fresh replay of final host state.

Compare visible cells, cursor, active screen, dimensions, and terminal modes
that affect later input/rendering. Derive any replay/queue bound from the
control transport, current renderer queue behavior, and measured fixture size;
do not invent a new constant.

The production gate passes only when split replay plus remaining bytes equals
fresh final host replay exactly and build viability is proven. For streams
without a geometry change, the uninterrupted diagnostic must also match. A
resize may differ from independently reflowed xterm only when resize itself is
defined as an authoritative host reset/resize/replay boundary. If replay bytes
cannot preserve that host-canonical state, document the mismatch and choose an
explicit host snapshot renderer protocol. Do not proceed with a raw-tail
substitute labeled as exact restoration.

### Proof outcome

The checked-in proof at
`research/20260809-124553-fut-tty/vt-proof/README.md` selects
`libghostty-vt` at revision
`72ac98f292879bf9f788fcbb11238c562a1eebe6`. All eleven host-canonical
fixtures pass. Ten also match uninterrupted xterm; resize/reflow exposes the
documented wrap-boundary cursor difference. Production must set xterm's
`reflowCursorLine: true`, serialize both screens and replay compatibility
metadata, and publish complete replay after every host resize. Zig 0.16.x is a
new application build prerequisite when the dependency moves into core.

## Characterization tests to add before replacement

Write tests against current public behavior so the replacement has executable
requirements:

- Killing terminal A while its termination grace path is active does not block
  write/resize/list for terminal B.
- `kill_all` drains the registry under lock and terminates after releasing it.
- Dropping/failing the renderer channel reaches an explicit cleanup path and
  the child is reaped.
- Natural exit always reaches child wait/reap even when output delivery fails.
- A blank shell process tree has one login-shell wrapper.
- `Program` launch preserves argv boundaries and does not invoke `sh -c`.
- A descendant that creates a new session is still terminated on explicit
  close.
- Existing query responder, theme, resize, coalescing, and flow-control
  behavior remains covered.

Prefer deterministic barriers and injected fakes over timing sleeps. The tests
may initially fail to demonstrate the defects, but the branch must not merge
until the safety patch or replacement makes them pass.

## Acceptance criteria

This contract slice is complete when:

- The domain vocabulary and descriptor schema are written as Rust and
  TypeScript types or approved interface fixtures.
- Current defect characterization tests exist and fail for the intended reason
  before the fix, then pass after it.
- The VT proof has a checked-in report and runnable fixtures.
- One VT/snapshot strategy is selected with exact-state evidence.
- The team records which current flow-control and process-termination behavior
  must be preserved.
- No resource-tree, daemon-persistence, or multiplexer work has entered scope.

## Files expected to change

- `core/backend/src/terminal/` tests and new domain types
- `core/backend/Cargo.toml` only if the VT proof selects a dependency
- `core/frontend/terminal/tests/` fixture harness
- `core/frontend/platform/types.ts` type fixtures
- a new dated research artifact for the VT proof results

The proof artifact belongs under `research/`; the selected public architecture
and final contracts belong under `docs/` or code-level API documentation.
