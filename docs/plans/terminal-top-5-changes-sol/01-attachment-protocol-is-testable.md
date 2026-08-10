# Attachment protocol is testable

## Outcome

Move attachment generation, sequence validation, replay installation, gap and
overflow recovery, and reattach coalescing from `TerminalView` into a DOM-free
TypeScript controller with no observable trace change.

## Context and purpose

`core/frontend/terminal/TerminalView.tsx` currently combines xterm presentation
with the complete attachment protocol inside one effect. Mutable refs and async
closures jointly own generation, sequence, installation, recovery, and input
readiness. The behavior cannot be driven directly without mounting React and
xterm.

Both full terminal plans require changes to these transitions. A behavior-
preserving extraction creates the unit-test seam first and prevents later
resize, visibility, and recovery work from being debugged through DOM effects.

This change is deliberately pure. The close/reconcile and input-authority
defects belong to change 5. Resize, theme, visibility, and encoding behavior
remain unchanged.

The contract is trace equivalence, not diff minimality. The protocol is
carried today by mutable refs; the controller replaces them with explicit
states. That normalization is a redesign, so "no behavior change" cannot be
established by inspection. The checked-in baseline traces are the operative
definition of preserved behavior, which is why step 2 records them before
step 3 writes any controller code. A scenario absent from the trace set is
unprotected, so the scenario list is part of the contract rather than an
illustration of it.

## Affected areas

- `core/frontend/terminal/TerminalView.tsx`
- new `core/frontend/terminal/terminalAttachmentController.ts`
- `core/frontend/terminal/terminalOutputQueue.ts`
- `core/frontend/terminal/terminalCache.ts`
- `core/frontend/terminal/index.ts`
- new `core/frontend/terminal/tests/terminalAttachmentController.test.ts`
- `ops/test/justfile`

## Current protocol locations

The logic to move, as it stands before this change:

- `attachRenderer` and its generation counter — `TerminalView.tsx:374`;
- the channel handler and the gap check
  `event.sequence !== sequenceRef.current + 1` — `:392-412`;
- `installReplay` — `:350-372`;
- `requestReattach`, the overflow callback wired into
  `terminalOutputQueue.ts` — `:341-349`;
- the enclosing effect that owns all of it — `:237-512`.

These anchors describe the starting state. They are not a required
decomposition of the controller.

## Work to be done

1. Define a protocol trace containing observable attach/detach calls, accepted
   sequences, replay install/reset/write callbacks, readiness transitions,
   reattach requests, and ignored stale callbacks.
2. Capture baseline traces from the current implementation for successful
   attach, live output, duplicate sequence, gap, resync request, overflow,
   delayed attach, delayed replay drain, exit, terminal replacement, and
   unmount. Keep the fixtures so preservation is checked against evidence, not
   memory.
3. Add `TerminalAttachmentController` with explicit states for detached,
   attaching, installing, live, recovering, exited, and disposed.
4. Inject narrow runtime and renderer ports. The controller may request
   attach/detach, reset/resize, queue registration, byte writes, replay
   installation, and callbacks, but it imports no React, xterm, Zustand, or DOM
   APIs.
5. Make one transition function the only writer of attachment ID, generation,
   sequence boundary, readiness, active recovery, and one pending follow-up
   recovery.
6. Preserve the current generation guards at every async completion. Ignore all
   callbacks after disposal or from an attachment superseded by replacement or
   recovery.
7. Preserve replay ordering: buffer live frames received while installation is
   pending, then apply only frames newer than the installed sequence boundary.
8. Replace the protocol body in `TerminalView` with callback adapters. The view
   continues to own xterm construction, fit, fonts, theme, viewport pinning,
   focus, and container lifetime.
9. Add controller tests that replay the checked-in baseline traces using fake
   ports and deferred promises.
10. Register the suite in `ops/test/justfile` with serial execution.
11. Consolidate terminal test registration while adding to it. The terminal
    suites are currently spread across four entries with inconsistent
    concurrency: `ops/test/justfile:15` parallel and mixed with host panel
    tests, `:18` serial, `:19` parallel, `:20` serial. Changes 2, 3, and 5 each
    add suites to that list. Merge the terminal entries into one serial
    invocation before the pile grows.
12. Capture the baselines the selected full plan will gate on, while nothing
    has moved yet:
    - end-to-end resize latency, from the renderer's fit decision to the
      terminal reaching the new geometry;
    - the reflow divergence trace between Ghostty and xterm at the known
      wrap boundary, using the existing
      `research/20260809-124553-fut-tty/vt-proof` harness.

    Both plans decide their largest question against these numbers, and both
    numbers move once changes 2 and 3 land. Record them as checked-in
    artifacts with the method used, not as prose. This step measures; it
    changes no production code.

Do not use `ast-grep outline` alone as proof that logic left the component: it
shows top-level symbols, not function bodies nested inside a React component.
Use source searches and the controller tests to enforce the boundary.

## Acceptance criteria

- `TerminalAttachmentController` imports neither React nor xterm.
- `TerminalView` no longer imports protocol event/replay types or directly owns
  attach, detach, generation, sequence-gap, replay-install, or reattach logic.
- The controller reproduces every baseline observable trace without modifying
  the trace expectations during extraction.
- One gap, resync, or overflow creates no parallel attachment and no more than
  one pending follow-up recovery.
- A stale generation cannot invoke renderer callbacks, replace the current
  attachment ID, enable input, or write output.
- Frames received during replay installation are applied once, in sequence,
  after the installed boundary.
- Terminal replacement and disposal detach the exact current attachment once.
- Existing resize, theme, visibility, close, input, replay, and transport
  behavior remains unchanged.
- The extraction commit contains none of change 5's authority fixes.
- The terminal suites are registered in one serial `ops/test/justfile` entry.
- Resize latency and reflow divergence baselines are checked in, each with the
  method that produced it, before change 2 or change 3 begins.

## How to validate

Run the baseline scenario against the parent implementation to produce the
checked-in trace fixtures, then run the controller against the same fixtures.
Use a temporary worktree or recorded fixture generation; do not rely on
`git stash` preserving an untracked test while removing the production symbol
it imports.

Run:

```sh
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts
rg -n 'TerminalEvent|TerminalReplay|attach\(|detach\(|sequenceRef|reattach' \
  core/frontend/terminal/TerminalView.tsx
just check all
just test fast
just modularity boundaries
git diff --check
```

Any remaining match must be justified as a presentation adapter rather than a
protocol decision. A defect discovered during extraction is recorded for
change 5 or the full plan instead of being silently fixed here.
