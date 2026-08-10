# Each terminal state has one writer

## Outcome

Assign one mutation authority to every frontend terminal state and route all
observations through it. Close, reconcile, attachment, module projection, and
input races then produce one deterministic result instead of competing writes.

The Rust runtime remains the authority for process lifecycle. Frontend state is
a revision-aware projection, never an independent process owner.

## Context and purpose

`TerminalClientRuntime` receives registry events and reconciles host lists, but
`close()` also deletes the descriptor, mutates Zustand, and publishes module
closure itself. Unlike the registry-event path, that manual path does not write
a removal observation. A `listTerminals()` already in flight can therefore
restore the closed descriptor before the host `Removed` event is reduced.

The backend has the same defect one layer down, and fixing only the frontend
would move the race behind the IPC boundary rather than remove it.
`TerminalService::close()` removes the record from the map at
`core/backend/src/terminal/service.rs:263`, then blocks on
`request_close(...)?.wait()?` at `:272-281`, and publishes
`TerminalRegistryEvent::Removed` only at `:283`. Two windows follow. While the
close is parked, the terminal is already absent from `list_terminals()` although
no removal has been published. And if either `?` returns an error, the function
returns with the record gone and **no `Removed` event ever emitted** — an
absence no observer can learn about.

Input has a similar split: `TerminalView` mutates and checks
`inputEnabledRef`, while `TerminalClientRuntime.write()` separately checks its
lifecycle descriptor and the backend makes the final decision. A keystroke
racing exit can be silently dropped or surfaced as an error depending on which
check wins.

The goal is not one global state manager. It is one writer for each distinct
fact, with adapters and stores receiving projections only.

## Authority map

- The backend terminal runtime actor writes PTY process and lifecycle state and
  makes the final write-acceptance decision.
- One reducer inside `TerminalClientRuntime` writes the frontend descriptor
  registry and removal observations.
- `TerminalAttachmentController` writes attachment generation, order, recovery,
  and view readiness.
- Zustand terminal descriptors are a projection written only by the registry
  reducer.
- Module lifecycle notifications are emitted only by the registry reducer.
- One runtime/controller submission path returns the frontend input-admission
  result from current attachment readiness and projected lifecycle.

Attachment readiness and host lifecycle are different facts. Keeping their
writers distinct is not duplicated authority; independently mutating either
fact in `TerminalView` is.

## Affected areas

- `core/frontend/terminal/terminalClientRuntime.ts`
- `core/frontend/terminal/TerminalView.tsx`
- `core/frontend/terminal/terminalAttachmentController.ts`
- `core/frontend/terminal/terminalSessions.ts`
- `core/frontend/terminal/useTerminalActions.ts`
- `core/frontend/terminal/useTerminalStore.ts`
- `core/frontend/platform/tauri.ts`
- terminal runtime, session, store, action, and controller tests
- commands and assistants module characterization tests
- `ops/test/justfile`
- `core/backend/src/terminal/types.rs`
- `core/backend/src/terminal/commands.rs`
- `core/backend/src/terminal/service.rs`
- `core/backend/src/terminal/runtime.rs`

## Work to be done

1. Define a revision-aware registry reducer for upsert, remove, reconcile
   snapshot, command response, and attachment event observations. All descriptor
   map, removal tombstone, Zustand, and module-projection mutations go through
   that reducer.
2. Preserve observations received while `listTerminals()` is in flight. A
   removal after the request boundary defeats a stale listed row; a newer
   descriptor revision defeats an older row; a duplicate or older observation
   has no effect.
3. Remove direct descriptor deletion, Zustand mutation, and module publication
   from `TerminalClientRuntime.close()`. The host `Removed` event is the normal
   close observation and is reduced exactly once.
4. Make backend close failure-consistent before relying on the frontend event.
   A terminal record remains discoverable while close is parked; marking it
   closing publishes the corresponding descriptor transition. Remove the
   record and publish `Removed` as one ordered commit only after successful
   close. A failed close leaves a discoverable, truthfully described record and
   an explicit retry or terminal-recovery path; it cannot leave an unpublished
   absence. Concurrent closes converge on the same close transaction and one
   removal event.
5. Before invoking host close, register a reducer observation boundary for that
   terminal. Successful close completes only after the command succeeds and the
   reducer has committed the matching present-to-absent transition.
6. Once the backend has an atomic successful removal, preserve its invariant
   that `TerminalService::close()` publishes `Removed` before returning. If the
   invoke resolves before the channel event is delivered, reconcile immediately
   and submit that result through the same reducer. If registry delivery and
   reconciliation both fail, return a typed, visible, non-mutating projection
   failure with a retry/reconcile action. Do not synthesize removal or wait
   indefinitely.
7. Route spawn, update, runtime event, registry event, and reconcile results
   through the same reducer. Command responses may improve freshness, but they
   do not get a separate mutation path.
8. Emit module `launched`, `adopted`, `updated`, `exited`, and `closed`
   projections from committed reducer transitions only. Preserve owner-action
   ordering before mutations and prevent duplicate exit/close notification.
9. Remove `inputEnabledRef` as a writable authority in `TerminalView`. UI input
   and custom keybindings use one submission method owned by the
   runtime/controller seam.
10. Have that method evaluate current attachment readiness and the latest
    lifecycle projection at submission time, then return a typed outcome. A
    normal unavailable state such as exit or recovery has one non-error UI
    behavior; transport or host failures have one user-facing error path.
11. Keep the backend runtime as final write authority. Preserve structured
    backend unavailability and failure codes through the Tauri adapter. If
    lifecycle changes after the frontend check, map the backend result into the
    same typed outcome rather than throwing through an unrelated path.
12. Do not queue arbitrary or mode-sensitive raw input across detach, recovery,
    or exit. The final architecture sends semantic input for host encoding;
    this enabler must not make transitional browser-encoded bytes durable.
13. Move attachment-readiness mutations into the controller after change 02.
    Registry-reducer work that does not touch attachment state can ship before
    the extraction.
14. Register the runtime/controller authority suites in the serial terminal lane
    in `ops/test/justfile` so the repository test gate executes them.

## Acceptance criteria

- Every descriptor, removal tombstone, Zustand, and module lifecycle mutation
  is a consequence of one revision-aware registry reducer transition.
- `close()` performs no parallel registry bookkeeping and cannot allow an
  in-flight list response to resurrect a removed terminal.
- While backend close is parked, list and registry projections still contain a
  closing descriptor. Successful removal and `Removed` publication are one
  ordered commit; failed close never creates an unpublished absence.
- Host removal before close response, close response before host removal,
  already-absent close, duplicate removal, stale list, and subscription failure
  each have deterministic tested results.
- Concurrent close, parked close plus reconcile, and backend close failure are
  covered and produce one discoverable lifecycle/removal history.
- Successful close resolves only after the reducer commits absence. An
  unconfirmed post-command removal returns a typed recovery result without a
  second state writer.
- Module lifecycle events are emitted once and only after the corresponding
  committed projection transition.
- `TerminalView` neither owns an input-enabled flag nor chooses between silent
  drop and user-facing error.
- User input and custom keybindings use the same typed admission path; the
  backend remains the final lifecycle authority.
- Expected backend lifecycle unavailability remains distinguishable from real
  protocol, validation, transport, authority, and I/O failures across Tauri.
- No raw input is retained across a state in which terminal modes may have
  changed.
- The change preserves current public Tauri, control-socket, CLI, and module
  lifecycle meaning and does not implement the future semantic protocol.
- The new frontend authority suites are included in the repository terminal
  test lane.

## How to validate

Use controlled promises to force every reconcile/close/event ordering,
including a parked backend close and a failed close, and fake controller ports
to force every input/exit ordering. Keep module characterization suites in the
proof because duplicate or reordered notifications are externally visible
there.

```sh
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalClientRuntime.test.ts \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalSessions.test.ts
pnpm exec node --test --test-concurrency=1 \
  modules/commands/frontend/tests/commandsCharacterization.test.ts \
  modules/assistants/frontend/tests/assistantsCharacterization.test.ts
cargo test --manifest-path core/backend/Cargo.toml terminal::service
just test fast
just test rust
just check all
just modularity boundaries
git diff --check
```
