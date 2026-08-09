# Better terminal architecture: refactoring plan

## Purpose

This plan replaces Shipctl's renderer-coupled PTY implementation with a
host-owned terminal service. The final system keeps terminal processes,
terminal state, lifecycle, and attachment continuity in the Rust host while
the React renderer owns only view placement and xterm.js presentation.

It fixes the current kill-lock, dead-channel, and double-shell-wrapper defects
as the first migration slice rather than preserving them behind adapters.

This is a clean replacement, not a second implementation that remains beside
`PtyManager`. Temporary adapters are permitted only while a migration slice is
in progress; the final acceptance gate deletes the numeric PTY API, the
spawn-time output channel, renderer-owned session registries, and all call-site
compatibility shims.

## Evidence base

The plan is based on the live Shipctl code and the feedback under
`research/20260809-124553-fut-tty/`. It also uses implementation patterns from
the live source in:

- `/Users/ddebowczyk/projects/_agents/fut/`
- `/Users/ddebowczyk/projects/_ext/cmux/cmux-tui/`

No older Shipctl plan was used.

The external projects are references, not target architectures. Shipctl should
adopt their terminal-runtime mechanisms without importing Fut's resource tree,
Fut's per-user daemon lifetime, cmux's durable terminal sidecar, cmux's full
multiplexer topology, or cmux's multi-renderer geometry policy.

## Decision

Implement this as a core capability replacement.

It is not merely an alternative terminal module. Terminal process ownership,
renderer recovery, control-socket access, shutdown blocking, module launch
contracts, and agent lifecycle all cross the host/module boundary. Those are
core platform responsibilities. xterm.js remains the renderer, and modules
remain owners of module-specific records and cleanup policy.

The target uses these invariants:

1. One opaque `TerminalId` identifies one process-bearing terminal for the
   lifetime of the Shipctl host process.
2. A `TerminalViewId`, module session ID, and `TerminalId` are different typed
   identities even when a deterministic projection relates them.
3. The Rust host owns the child, PTY, continuous VT state, metadata, lifecycle,
   exit record, and subscribers.
4. A per-terminal ordered runtime is the only component allowed to mutate the
   PTY or VT parser.
5. The registry lock is used only to find, insert, list, or remove terminal
   records. It is never held during spawn, IPC delivery, PTY I/O, child wait,
   or process termination.
6. Subscriber failure detaches that subscriber. It never terminates the
   terminal.
7. Every attachment begins with an authoritative replay and a live-stream
   sequence boundary captured atomically. There is no replay/live gap.
8. Closing a view detaches it. Closing a terminal is an explicit, idempotent
   lifecycle operation.
9. Natural exit is durable host state. Exited records remain discoverable
   until explicitly closed or the app exits.
10. Metadata crossing the module boundary is explicitly JSON-serializable and
    contains no environment values, command arguments, control tokens, or
    other secrets.
11. Explicit agent reports supplement terminal truth. They do not own process
    lifecycle and do not infer that a process is alive.

## Why continuous VT state is in the final design

A raw output tail cannot reconstruct an exact terminal screen. Terminal state
depends on every prior byte, including mode changes, alternate-screen state,
cursor state, erase operations, and control sequences. Building a registry and
subscriber API first and adding a parser later would force the attachment
ordering and output pipeline to be redesigned twice.

The plan therefore places a VT-library proof before the replacement runtime
and makes continuous parsing part of the final architecture. That proof has
selected pinned `libghostty-vt`: split replay plus later bytes produces exactly
the same xterm.js-visible state as a fresh replay of final host state across all
fixtures. Ten fixtures also match an independently uninterrupted xterm. Resize
does not, because Ghostty and xterm place the cursor differently at an exact
reflow wrap boundary. Therefore the production contract is host-canonical:
every geometry change resets, resizes, and replays the renderer from host state.
The runnable evidence and dependency/build constraints live in
`research/20260809-124553-fut-tty/vt-proof/README.md`.

## Target component model

```text
modules / core UI / shipctl CLI
          |
          | typed commands and descriptors
          v
  TerminalService (Rust host registry)
          |
          +-- TerminalRecord <TerminalId>
          |      +-- immutable/redacted launch metadata
          |      +-- lifecycle + exit + agent state
          |      +-- subscriber directory
          |      `-- TerminalRuntime handle
          |
          `-- lightweight registry event subscription

  TerminalRuntime (one ordered owner per terminal)
          +-- PTY master/writer and child owner
          +-- process-tree terminator
          +-- continuous VT parser
          +-- canonical geometry
          `-- replay + ordered live event publication

  React renderer
          +-- project/tab placement projection
          +-- xterm.js instances keyed by TerminalId
          `-- detachable attachment clients
```

The host registry is not a UI tree. Shipctl's project capability continues to
own placement, selection, focus, and split/tab presentation. A terminal can
exist with zero mounted views and can later be projected into a view again.

## Migration slices

Execute the documents in this order. A slice is complete only when its stated
acceptance criteria pass and the codebase still has one authoritative behavior
for that concern.

1. [Evidence and architecture contract](./01-evidence-and-architecture-contract.md)
   locks the verified defects, adopted patterns, rejected patterns, domain
   vocabulary, and VT proof gate.
2. [Runtime and registry replacement](./02-runtime-and-registry-replacement.md)
   fixes current safety defects, introduces the ordered runtime and
   `TerminalService`, and removes global-lock lifecycle work.
3. [Attachments, replay, and flow control](./03-attachments-replay-and-flow-control.md)
   replaces the spawn-time `Channel` and ACK coupling with detachable,
   self-healing subscribers.
4. [Control socket and CLI](./04-control-socket-and-cli.md) adds
   list/get/attach/write/close to the existing authenticated instance socket
   and makes long-lived attachments concurrent with other control requests.
5. [Renderer reconciliation](./05-renderer-reconciliation.md) replaces
   `usePty`'s process/session ownership with an idempotent host projection and
   exact xterm replay.
6. [Module and call-site migration](./06-module-and-callsite-migration.md)
   removes output channels and numeric PTY IDs from module contracts and
   teaches module runtimes to adopt rediscovered terminals.
7. [Agent lifecycle and activity](./07-agent-lifecycle-and-activity.md) adds
   explicit, revisioned agent reports after the terminal identity and control
   surface are stable.
8. [Cutover and verification](./08-cutover-and-verification.md) deletes the old
   architecture, runs the full cross-capability proof, and defines the final
   completion gate.

## Whole-plan acceptance criteria

The refactor is done when all of the following are proven:

- Killing or shutting down one terminal never holds the registry lock while
  waiting, and another terminal remains writable/resizable during termination.
- Losing a Tauri channel, socket attachment, renderer, or xterm view never
  kills or leaks the child process.
- A blank shell is launched through exactly one login-shell path; an argv
  program is executed directly without a shell wrapper.
- Terminal IDs are opaque strings on every Rust, Tauri, TypeScript, module, and
  control-socket boundary. No `u32` PTY identity remains.
- Renderer restart causes the host inventory to be projected again without
  duplicate views or duplicate module sessions.
- Reattachment resets xterm.js from a host replay and receives every later byte
  exactly once, including output racing the attach operation. Host resize is an
  authoritative reset/resize/replay boundary; xterm never independently
  reflows and then claims exact equivalence.
- A slow or failed subscriber is detached or resynchronized without blocking
  PTY draining or other subscribers.
- Natural exit remains listable with its exit state until explicit close.
- `shipctl terminals list|get|attach|write|close` operate through the existing
  authenticated instance control socket, and a live attach does not block
  inspect, write, close, or shutdown connections.
- Assistants and commands modules launch and rediscover their terminals without
  creating their own output `Channel`.
- Explicit agent state can be reported using the injected terminal ID and is
  visible in terminal descriptors without replacing host lifecycle truth.
- The old `PtyManager`, `PtySession`, `ack_pty_output`, renderer session maps,
  and temporary migration adapters are deleted.

## Non-goals

- Keeping terminals alive after the Shipctl application process exits.
- Restoring terminals after an OS reboot or application restart.
- Replacing xterm.js with a Rust renderer.
- Importing a general session/workspace/tab/pane resource tree into core.
- Supporting multiple simultaneous geometry authorities. Socket attachments
  are observers; the mounted Shipctl terminal view remains geometry authority.
- Persisting argv or environment data in discoverable metadata.

These are exclusions from this refactor, not hidden limitations. If one later
becomes a product requirement, it needs its own acceptance contract.

## Team working rule

Do not preserve an obsolete abstraction merely to make a migration diff
smaller. Preserve behavior that is proven necessary: escaped-descendant
termination, flow-control safety, theme/query behavior, module cleanup
ownership, and shutdown blocking. Replace the abstractions that currently make
those behaviors unsafe.
