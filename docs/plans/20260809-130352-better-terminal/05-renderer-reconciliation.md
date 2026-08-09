# Renderer reconciliation and exact reattachment

## Objective

Turn the React renderer into a projection of host-owned terminals. When the
renderer starts or reloads, it lists host records, idempotently reconstructs
terminal views and module-facing session projections, and attaches mounted
xterm.js instances from authoritative host replay. Renderer teardown detaches
views without affecting processes.

This slice assumes the backend provides opaque `TerminalId` strings, redacted
descriptors, exact replay, detachable subscribers, lifecycle revisions, and
list/get/attach/write/resize/close commands.

## Current state to replace

`core/frontend/terminal/usePty.ts` currently combines too many ownership roles:

- renderer-local terminal and module session ID allocation;
- maps from PTY IDs to sessions and output listeners;
- output-channel routing;
- activity timers;
- stop/kill correlation;
- terminal creation and module cleanup;
- blank-shell spawning.

`TerminalView.tsx` and `terminalOutputQueue.ts` are keyed by numeric PTY IDs,
and `useTerminalStore.ts` generates numeric tab IDs. A renderer reload loses
those mappings even though backend children may still exist.

The replacement removes `usePty` as a lifecycle owner. Keep a small React hook
only as a façade over an imperative capability runtime if that improves call
sites.

## Frontend ownership model

Create a capability-owned imperative `TerminalClientRuntime` under
`core/frontend/terminal/`. It owns only renderer-side resources:

- the latest `TerminalDescriptor` by `TerminalId`;
- active attachment handles/generations;
- xterm instance registration and write ordering;
- lightweight registry/lifecycle listener cleanup;
- reconciliation status and typed errors.

It does not own:

- child or PTY lifecycle;
- terminal exit truth;
- a host session counter;
- module business records;
- project/tab selection state;
- a spawn-time channel;
- process cleanup on renderer unload.

Zustand remains the UI projection. Do not mirror imperative attachment objects
inside Zustand; store serializable descriptors and placement state only.

## Typed identities

Replace numeric `ptyId` with a branded string `TerminalId` across platform,
terminal, shell, and module call sites.

Introduce a distinct branded `TerminalViewId`. For the default one-view-per-
terminal projection, derive it deterministically:

```text
TerminalViewId = "terminal:" + TerminalId
```

The deterministic mapping makes reconciliation idempotent; the branded types
prevent code from treating view placement as process identity.

Migrate `TerminalTabData` to contain:

- `id: TerminalViewId`;
- `terminalId: TerminalId`;
- host-derived label/cwd/project path/lifecycle;
- module session/presentation projection where applicable.

Migrate project-tree, selection, activity, and xterm-cache types that assume
numeric terminal tab IDs. Do not hash UUIDs into numbers or keep a renderer
counter as a compatibility identity. Update cross-capability exports in the
owning `index.ts` files rather than importing internal paths.

## Startup reconciliation

Run one explicit app-initialization operation from the existing `AppShell`
composition point. A one-time effect is appropriate because it establishes and
tears down external Tauri listeners; do not use effects to synchronize derived
Zustand state.

Algorithm:

1. Subscribe to lightweight terminal registry/lifecycle notifications. Capture
   a registry revision or generation if the backend provides one.
2. Call `listTerminals()` and obtain complete descriptors.
3. Merge the list with notifications that raced the request. Compare record
   revisions; never let an older list row overwrite a newer event.
4. For every descriptor, compute its deterministic `TerminalViewId` and desired
   project placement.
5. Upsert the view if absent. Update metadata/lifecycle if present. Do not add a
   duplicate tab when reconciliation runs again.
6. Remove or mark stale local terminal projections whose host record is absent.
   Never ask the host to close a terminal merely because a stale renderer tab
   existed.
7. Rebuild module-facing projections from the descriptor's owner data using the
   module adoption contract in the next slice.
8. Mark reconciliation ready so active project selection can mount a terminal
   view.

If a host record's project path no longer exists in current project state,
place it through one documented fallback (for example, a recoverable terminal
group) and show the original path. Do not silently close it. Reuse existing
project primitives; do not create a second workspace tree.

Reconciliation is a reducer/action invoked with one snapshot and a set of
events. It must be testable without React and safe to run multiple times.

## Registry changes after startup

The initial list is not sufficient for terminals created by a module or control
path after startup. Add a lightweight Tauri registry subscription or invalidate
event:

- created: fetch/merge the new descriptor and project it;
- metadata/lifecycle/agent revision: merge if newer;
- closed: remove the view and notify its module owner;
- exited: retain the view as read-only with exit state;
- resync: rerun list/reconcile.

This subscription carries descriptors/revisions, not PTY output. Byte streams
are attached only where a renderer view needs them.

## xterm mount and attachment lifecycle

`TerminalView.tsx` remains the integration point for xterm.js, ResizeObserver,
and DOM listeners. These are legitimate imperative effects.

On mount or reuse of a cached xterm instance:

1. Register xterm with `TerminalClientRuntime` under `TerminalId` and a new
   attachment generation.
2. Disable input until authoritative state is applied.
3. Call `attachTerminal`.
4. Reject/close the result if the component unmounted or a newer generation
   replaced it during the attach round trip.
5. Reset xterm, set canonical host rows/columns, apply theme/default state, and
   write the replay.
6. Wait for xterm's replay write completion callback.
7. Apply buffered live events in sequence order.
8. Report the mounted view's fitted size with its attachment generation.
9. Enable input only if the attached descriptor is running and no resync is in
   progress.

On unmount:

- unregister xterm and detach that attachment generation;
- dispose view-only observers/listeners according to existing cache policy;
- do not call terminal close;
- ignore late events from the detached generation.

If the xterm cache preserves instances across tab switches, distinguish
"unmounted but cached" from "renderer attachment active" deliberately. It is
acceptable to keep the attachment only while the cached instance is actively
draining and bounded. Otherwise detach and recover from replay when remounted.

## Replay and event application

Refactor `terminalOutputQueue.ts` into an ordered xterm application queue keyed
by `TerminalId` and attachment generation.

States:

```text
detached
attaching
applying_replay
live
resyncing
exited
```

Rules:

- Buffer live events arriving during replay application.
- The first live sequence must be exactly `sequence_boundary + 1`; later
  sequences must be contiguous.
- On a gap, duplicate-invalid transition, backend `resync_required`, or local
  pending-output overflow: disable input, dispose the attachment, clear pending
  live bytes, and attach again for fresh replay.
- A resize/replay event is an authoritative reset: stop accepting input, reset
  and resize xterm, apply replay, then continue later sequences.
- Configure xterm with `reflowCursorLine: true`. This preserves the cursor's
  wrapped row during coordinated resize, but host replay remains canonical;
  never independently resize xterm and treat its reflow as exact host state.
- Final output is applied before the exited lifecycle view becomes final.
- An exited descriptor permits final replay but rejects write/resize.
- Never append replay to the existing screen without reset.

Preserve useful current xterm chunking and write-callback behavior. Delete the
backend byte ACK calls and any assumption that queue completion owns PTY flow.

## Input, resize, and keyboard paths

Update every input path in `TerminalView.tsx` and related keybinding handlers:

- resolve the active `TerminalId`, not a numeric PTY ID;
- require attachment state `live` and descriptor lifecycle `running`;
- call `writeTerminal` with bytes;
- route user-facing failures through `pushNotice()` and `getErrorMessage()`;
- log details only behind `import.meta.env.DEV`.

ResizeObserver reports include the current attachment generation. The backend
rejects stale generations. Coalesce fit noise using existing xterm/fit behavior;
do not add an arbitrary timer. The host's resize result/replay is authoritative,
so optimistic local size must reconcile to the returned event.

## Spawn and close UI flows

Replace `spawnBlankShell` with a typed shell request. The frontend passes no
shell command string and no `-l`; the host resolves/spawns one login shell.

Program/module callers pass program and argv as separate values.

On spawn success:

- merge the returned descriptor through the same reconciliation reducer;
- select the projected `TerminalViewId` in the existing event handler;
- let `TerminalView` mount and attach from replay.

On user close:

- call `closeTerminal(TerminalId)` once;
- reconcile the returned close/registry event;
- remove frontend placement and invoke module cleanup through the owner
  contract;
- treat `existed: false` as successful idempotence;
- do not use a renderer `stoppingPtys` correlator.

Closing an ordinary React view due to project navigation is not user terminal
close.

## Activity projection

Do not infer process lifecycle from output. The descriptor lifecycle is
authoritative.

For interim visual activity before explicit agent reports are adopted:

- the host may expose `output_revision`/`last_output_at`;
- the frontend can preserve the current visible output-activity behavior as a
  presentation fallback, but isolate it in one reducer and mark it for removal
  or demotion in the lifecycle slice;
- do not recreate module-level timer maps keyed by PTY ID;
- do not invent a new stale interval. Preserve the existing behavior only while
  migration compatibility is required.

Agent working/blocked/completed state later arrives as explicit descriptor
state and remains separate from running/exited.

## Error and recovery UX

Represent these states explicitly:

- host unavailable during initial list;
- terminal vanished between list and attach;
- exited terminal with final replay;
- attachment overflow/resync in progress;
- replay application failure;
- module owner unavailable during adoption.

Use existing notice and terminal UI primitives. A recoverable attachment error
must not remove the tab or kill the process. Provide retry by reattachment. Only
an explicit close removes host state.

## Tests

### Reconciliation reducer

- Empty local state plus host list creates one view per descriptor.
- Running reconciliation twice creates no duplicates.
- Older list data cannot overwrite a newer lifecycle event.
- Host-absent stale views are removed/marked without issuing close.
- Exited records remain projected and read-only.
- Project fallback placement is deterministic.
- Core and module owner descriptors produce the expected projection actions.

### Attachment queue

- Replay completes before buffered live output is applied.
- Exact boundary and contiguous sequences enter live state.
- Gap, overflow, and stale generation cause reattach, not close.
- Resize replay resets before later output.
- Exit applies final output first and disables input.
- Unmount detaches and ignores late events.

### UI behavior

- Blank shell sends a typed shell launch, not `${shell} -l`.
- Input/resize are gated on live/running state.
- User close calls host close once and idempotently removes projection.
- Renderer initialization uses one external-listener effect and no derived-state
  synchronization effects.
- User-facing failures use notices and production console remains clean.

### Renderer restart integration

Run a terminal that establishes cursor/color/alternate-screen state, destroy
the renderer or invoke the supported reload path, and assert:

- the child PID remains alive;
- the terminal tab is reconstructed once;
- xterm visible state/cursor/dimensions match pre-reload state;
- later input/output works;
- a module-owned terminal is re-adopted by its module runtime;
- no old channel callback receives events.

## Acceptance criteria

This slice is complete when:

- numeric terminal/tab identity assumptions are removed from terminal call
  sites;
- startup reconciliation is idempotent and revision-aware;
- registry events keep the projection current after startup;
- xterm mounts from exact replay and ordered live events;
- unmount/reload only detaches and processes survive;
- input and resize reject stale/exited attachments;
- `usePty`'s manager/session maps, counters, timers, channel routing, and
  stopping correlator are deleted;
- renderer restart integration passes for core and module-owned terminals.

## Files expected to change

- `core/frontend/platform/types.ts`
- `core/frontend/platform/tauri.ts`
- `core/frontend/terminal/usePty.ts` (replace/delete)
- new `core/frontend/terminal/terminalClientRuntime.ts` or equivalent
- `core/frontend/terminal/terminalOutputQueue.ts`
- `core/frontend/terminal/TerminalView.tsx`
- `core/frontend/terminal/useTerminalStore.ts`
- `core/frontend/shell/AppShell.tsx` or its actual composition path
- project/shell types and call sites that assume numeric terminal tab IDs
- terminal frontend and renderer-reload tests

Keep all capability code under `core/frontend/terminal/`; `src/` remains Vite
entry code only.
