# Phase 02 — Extract the attachment protocol from React

## Outcome

Move attachment generations, sequence validation, replay installation, gap
recovery, and reattach coalescing into a DOM-free TypeScript controller while
preserving all current behavior.

## Context

`TerminalView.tsx` currently combines xterm rendering and attachment protocol
inside one large effect. Ten mutable refs jointly encode protocol state, and
generation/gap behavior can only be exercised through a mounted React view.
Visibility and resize fixes would be fragile while this state machine remains
implicit.

This phase is deliberately mechanical. It does not yet remove replay on
resize/theme, change hide/show lifetime, change IPC encoding, fix `close()`, or
change input policy.

## Target boundary

Create a plain TypeScript `TerminalAttachmentController` with these states:

```text
detached -> attaching -> installing -> live
    ^           |            |          |
    +-----------+------------+----------+-> reattaching
                                         -> exited
any state --------------------------------> disposed
```

The controller owns:

- attachment ID and generation;
- last accepted sequence and duplicate/gap classification;
- one in-flight reattach and one `needsReattach` bit;
- input transport readiness, distinct from terminal lifecycle;
- attach/detach/dispose ordering; and
- callbacks for replay, output, resize-ready extension, exit, and descriptor
  changes.

The view continues to own xterm construction, fit, theme, fonts, focus,
viewport pinning, and output-queue rendering.

## Hypotheses to verify

### H2.1 — DOM-free transitions

The states above represent existing behavior without DOM/xterm internals. Drive
the controller with a fake runtime and callback recorder. Falsifier: a protocol
transition requires DOM layout or xterm state.

### H2.2 — Generation safety

A generation check at every async boundary prevents stale attach/replay work
from mutating the current view. Resolve attach, replay drain, and detach out of
order. Falsifier: a stale generation reaches a renderer callback.

### H2.3 — Reattach coalescing

Repeated gap/resync signals coalesce to one active reattach and at most one
follow-up. Burst signals while attach is delayed. Falsifier: parallel
attachments or an unbounded reattach loop appears.

## Tasks

1. Characterize current behavior with fake runtime tests before moving code:
   successful attach, snapshot install, live output, duplicate sequence, gap,
   `resync_required`, exit, delayed attach, delayed replay drain, and unmount.
2. Add `terminalAttachmentController.ts` with injected operations rather than
   imports from React or xterm:
   - `attach()` and `detach(attachmentId)`;
   - `installReplay(event)` returning a promise when renderer installation is
     complete;
   - `acceptOutput(event)`;
   - `onDescriptor`, `onExit`, and `onProtocolError`; and
   - `dispose()`.
3. Make one reducer/transition function the only writer of controller state.
   Reject impossible transitions in tests and ignore all callbacks after
   disposal.
4. Move generation, sequence-gap detection, reattach serialization,
   `needsReattach`, and readiness into the controller.
5. Keep replay ordering explicit: buffer live frames received during
   `installing`; release them only after replay installation completes and only
   if their sequence is newer than the installed boundary.
6. Replace the attachment section of `TerminalView` with callback adapters that
   feed the existing output queue and replay installer. Do not move renderer
   policy into the controller.
7. Add the new unit-test file to `ops/test/justfile` so `just test fast` cannot
   omit the extracted state machine.
8. Confirm the code move produces no protocol event, attachment-count, reset,
   viewport, or input behavior delta against Phase 01 characterization tests.

## Acceptance criteria

- `TerminalAttachmentController` imports neither React nor xterm.
- No attachment generation, sequence, reattach, or readiness ref remains in
  `TerminalView`.
- Exactly one attachment is live per controller generation.
- A stale async completion cannot call renderer callbacks or overwrite the
  current attachment ID.
- A burst of gaps/resyncs creates no parallel attach and no more than one
  queued follow-up attach.
- Frames arriving during snapshot installation are applied once, in sequence,
  after the snapshot.
- Existing resize, theme, visibility, close, and input behavior remains
  intentionally unchanged at this phase boundary.

## Validation

```sh
pnpm exec node --test \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts
just test fast
just check all
just modularity boundaries
git diff --check
```

## Exit condition

Do not start Phase 03 until every Phase 01 attachment characterization passes
through the controller and the React effect has no protocol state beyond one
controller reference.
