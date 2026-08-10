# Client model owns terminal continuity

## Outcome

The browser holds one renderer-independent cell model per terminal. It applies
semantic frames, survives hiding, resize, theme change and surface recreation,
and reconstructs only at the four recovery boundaries. Continuity stops being a
property of a rendering widget's internal buffer and becomes owned client state
that any surface can paint.

This area owns client state and its lifecycle. It does not own pixels, which is
area 04's, and it does not own the wire, which is area 02's.

## Context and purpose

The seam is already cut. The controller is DOM-free and every effect crosses one
port boundary: `TerminalAttachmentPorts`
(`core/frontend/terminal/terminalAttachmentController.ts:48`). That is the
enabler this area builds on, and it is why this work is a substitution rather
than a rewrite.

What crosses that boundary today is the problem. Two of its methods are the
legacy authority in interface form:

- `installReplay(replay: TerminalReplay)` at `:56`, called from `:226` and
  `:248`; and
- `releaseOutput(bytes: readonly number[])` at `:60`, called from `:231` and
  `:245`.

Continuity currently lives in xterm's buffer, not in Shipctl. The proof is
`TerminalView.tsx:254`: attaching calls `term.reset()` and then installs a
replay. The client has no model to preserve, so it discards everything and asks
the host to print the terminal again. That is why area 01's two defective
`replay()` callers are visible here as user-facing reconstruction — but note
that fixing the client alone cannot fix them, because the reconstruction is
manufactured in the backend two functions above the transport.

Visibility compounds it. `TerminalView.tsx:227` returns early when
`!visible`, `:454` sets `display: visible ? "block" : "none"`, and `visible` is
in the effect dependency list at `:430`. A hidden tab is therefore not a
terminal whose paint is suspended; it is a terminal whose client state is torn
down and rebuilt. `terminalOutputQueue.ts` and `terminalCache.ts` exist to
soften that, and both import xterm — they are compensations for a missing model,
not a model.

## Dependencies

- **Blocked by.** Area 02 for the decoded frame types. Trace fixtures over
  draft domain types can start earlier; adoption cannot.
- **Blocks.** Area 04, which paints this model, and area 05.
- **Preserves.** `terminalClientRuntime.ts` and its single-writer registry
  contract, including `publishTerminalClosed` inside the reducer. This area adds
  no second writer of descriptor membership.

## Affected areas

- `core/frontend/terminal/terminalAttachmentController.ts` — the ports at `:48`
  and the install paths at `:208`, `:223-231`, `:245-248`.
- `core/frontend/terminal/terminalOutputQueue.ts` — replaced by the model's own
  application order; it imports xterm today.
- `core/frontend/terminal/terminalCache.ts` — replaced by model retention; it
  imports xterm today.
- `core/frontend/terminal/terminalScrollPin.ts`,
  `terminalViewport.ts` — viewport intent becomes a model concern expressed in
  model coordinates.
- `core/frontend/terminal/terminalProjection.ts` — unchanged in role. It maps
  descriptors by project path and is not a cell model; do not overload it.
- `core/frontend/terminal/TerminalView.tsx` — the visibility teardown at `:227`,
  `:430` and `:454`, and the `term.reset()` at `:254`.

## Work to be done

1. **Define the model as owned client state, keyed by terminal ID, outside the
   React tree.** It is created when the terminal is attached and destroyed when
   the terminal is closed. Mounting, unmounting, hiding and showing a view are
   not events in its lifecycle. This is the single change that makes every other
   item in this area possible.
2. **Replace the two legacy ports.** `installReplay` and `releaseOutput` give
   way to `applySnapshot`, `applyDelta`, `applyHistoryWindow` and `applyEffect`.
   The port interface stays the seam it already is; only its vocabulary changes.
   The controller keeps its DOM-free property, which is what lets these paths be
   tested without a browser.
3. **Enforce the base revision in the client too.** A delta whose base does not
   match the model's current revision is not applied. Area 01 states the rule in
   the producer; the client enforces it independently, because a client that
   trusts the producer cannot detect the producer's failure.
4. **Implement exactly four recovery boundaries.** Initial attach, deliberate
   model loss, sequence or base-revision mismatch, and queue overflow. Each
   requests one recovery snapshot, suppresses duplicate recovery work while it
   is in flight, installs it atomically, discards frames covered by its
   boundary, holds later frames, and resumes from the declared next sequence.
   Resize, theme change, focus, hide, show, and surface recreation are not on
   this list and may not produce a reconstruction.
5. **Make hiding a presentation state.** The model keeps applying frames while
   its view is hidden. Showing a tab paints current state; it does not refetch
   it. This deletes the reason `terminalOutputQueue.ts` and `terminalCache.ts`
   exist, and it is proven by hidden-output tests rather than by inspection.
6. **Own history in model coordinates.** The model requests history windows
   through the area 02 protocol using host-defined stable anchors, holds what it
   has, and knows what it does not have. Stale and evicted anchors are explicit
   outcomes that trigger a refetch or a visible loss state — never a guessed row
   offset. Define the state exposed while a window is in flight; area 04 paints
   it. Blank, stale or shifting rows may not appear as an accidental side
   effect of scrolling.
7. **Own selection and viewport as model state.** Selection is expressed against
   model coordinates that survive reflow and history eviction, and selection
   gestures are submitted as semantic commands. Viewport intent — the existing
   pin behaviour at `TerminalView.tsx:288-320` — moves into the model, so that a
   resize or a history fetch cannot silently move the user's anchor.
8. **Keep effects ordered against cell state and do not coalesce them.** Screen
   state may be coalesced when the resulting frame bridges a valid baseline.
   Bell, notification, clipboard and exit are occurrences. Two bells are two
   bells. The bell handler at `TerminalView.tsx:128-130` is the current
   integration point and its replacement is a register row in area 04.
9. **Do not use `useEffect` to derive or synchronise model state.** The model is
   external state; React subscribes to it. Applying frames, resetting on
   attachment change, and reacting to visibility are handled where they happen —
   in the port, in the handler, in the subscription — not in a reactive effect
   that watches state. Effects remain legitimate for listener setup and teardown
   and for imperative library integration.
10. **Leave xterm mounted and authoritative for pixels until area 04.** This
    area moves continuity, not rendering. Two stores of screen state exist
    briefly, and only the model is authoritative.

## Acceptance criteria

1. Hiding a tab, producing output, and showing it again leaves the model with
   no gap and no duplicate, and produces zero recovery snapshots. Asserted on
   numbered output, not on a screenshot.
2. Row resize, column resize, drag, a visible theme change and a hidden theme
   change each produce zero reconstructions. Combined with area 01's criterion
   that `resize` and `set_theme` no longer call `replay()`, this proves the
   defect closed on both sides of the wire.
3. Destroying and recreating the surface leaves the model intact and produces
   zero recovery snapshots. The model outlives its view, proven by doing it.
4. Each of the four boundaries, injected deliberately, produces exactly one
   unbased snapshot and one resumption at the declared next sequence.
   Injecting two at once produces one, not two.
5. A delta with a mismatched base is rejected by the client with the model
   unchanged, proven independently of area 01's producer-side test.
6. A viewport anchored away from the bottom survives a row resize, a column
   resize, a history window fetch, and a theme change without moving.
7. An evicted history anchor produces the defined explicit outcome. A test
   asserts that no blank or stale row is ever published to the surface.
8. Two bells in one write are two effects at the model boundary, and neither is
   lost to screen-state coalescing.
9. Closing a terminal during a stale reconciliation removes it once, with no
   descriptor resurrection. The registry characterisation suites run unmodified,
   or a deliberate contract change is recorded with the module owner.

## How to validate

```sh
node --test --test-concurrency=1 core/frontend/terminal/tests
just test fast
just check all
just modularity boundaries
```

The controller's tests stay DOM-free. A test that needs a browser to prove a
model property is testing the wrong layer, and this area is specifically the one
that makes those properties testable without one.

## Exit and rollback

The model is additive. xterm still renders and still holds its own buffer until
area 04 replaces the surface and area 05 deletes the packages. If the model
proves wrong, the legacy ports are still present and reverting removes new code.

The stop condition is item 6. If host-served history windows cannot preserve the
user's scroll position and selection across eviction and reflow, the evidence
returns to the owner before area 04 builds a surface on top of it.
