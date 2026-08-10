# The attachment model is renderer-independent

## Outcome

Attachment, sequence continuity, recovery, visibility, viewport intent, and the
client cell model live in one DOM-free, renderer-free module with deterministic
tests. It runs under `node --test` with no browser, no xterm, and no canvas. The
rendering surface becomes a consumer of that model rather than the place the
model lives.

## Context and purpose

`TerminalView` is currently the attachment protocol. The effect returns early
when the surface is hidden (`core/frontend/terminal/TerminalView.tsx:238`),
`visible` sits in the effect dependency list (`:512`), the cleanup detaches
(`:502`), and the container never leaves the DOM — it only changes `display`
(`:537`). So the cached renderer survives while its content continuity does
not, and a later reveal creates a new attachment whose installer resets the
renderer.

That distorts a presentation fact into a terminal-domain event: switching tabs
runs recovery, caused by an ordinary click. It also produces a second class of
defect. The theme and settings catch-up at `:292-306` exists only because
settings changed while the terminal was detached and had to be re-applied by
hand. Every catch-up path is a chance to diverge from the host, and each one
disappears once the stream is continuous.

The backend already models this correctly. Attachments carry their own identity
(`TerminalAttachmentId`), the runtime handles several at once, and it elects a
resize authority among them. The frontend is the side that conflates attachment
with surface.

This change is where the old `visibility is presentation only` contract lands,
and it is now larger than that contract. Under one VT authority the client also
holds a cell model — the current grid, its revision, its palette revision, and
cached history windows — and that model must exist before any pixel is drawn.
Building it inside a React component would bind the hardest logic in the
capability to the DOM at the exact moment we are trying to replace the renderer.

The target rule is:

```text
component/terminal identity -> attachment lifetime
visibility                  -> surface work only
frames + sequence           -> client cell model
cell model                  -> presentation surface
```

## Dependencies

- [Change 01](01-ghostty-semantic-contract-and-retention-are-proven.md) has
  proven the semantic and retention contracts and its stop gates have passed.
- [Change 02](02-semantic-frame-transport-is-versioned-and-measured.md) has
  defined snapshot, delta, palette, side-effect, and history-window messages
  with version, terminal ID, sequence, and base revision.
- The preparatory `TerminalAttachmentController` extraction is complete.
- Registry membership and input-readiness ownership are complete.
- Existing controller traces cover attach, detach, generation, overflow, and
  unmount before behavior changes.

## Affected areas

- `core/frontend/terminal/TerminalView.tsx`
- the preparatory attachment controller and its tests
- `core/frontend/terminal/terminalCache.ts`
- `core/frontend/terminal/terminalOutputQueue.ts`
- `core/frontend/terminal/terminalViewport.ts`
- `core/frontend/terminal/terminalScrollPin.ts`
- `core/frontend/terminal/terminalSessions.ts`
- `core/backend/src/terminal/runtime.rs`
- `ops/test/justfile`

The module boundary is **not** in scope, despite the surface similarity.
Attachment lifetime is invisible to modules. `TerminalClientRuntime.detach()`
delegates only to `detachTerminal()` (`terminalClientRuntime.ts:200-202`) and
publishes nothing. `publishTerminalClosed` is called from registry removal
(`:93`), reconciliation (`:135`), and manual close (`:228`) — all terminal
registry lifecycle, none of them on the attach or detach path. Modules observe
terminal lifecycle, not attachment visibility, and this change cannot re-time
what they see.

## The four recovery boundaries

A recovery boundary is the only place an **unbased** snapshot may be installed.
Exactly four exist, and all four are properties of the attachment and the client
model, not of the renderer:

1. initial attachment, including the first attach of a terminal created in a
   background tab;
2. deliberate client-cell-model recreation or loss;
3. a sequence gap or a base-revision mismatch;
4. subscriber or attachment queue overflow.

Two things that look like boundaries are not. Surface recreation — a lost
drawing context, a failed accelerated path, a recreated canvas or DOM tree — is
a local repaint from a model that is still valid, and is owned by
[change 04](04-cell-surface-replaces-xterm-capabilities.md). And a complete
grid that arrives with a valid base revision, such as the frame a resize
produces when it invalidates every row, is an ordinary ordered state
transition. Requiring every complete-grid installation to be recovery would
restore reconstruction-on-resize under a new name.

A host process restart is not a fifth boundary. `TerminalId` is the stable UUID
identity of one host-owned runtime (`core/backend/src/terminal/types.rs:9-12`),
records live only in an in-memory map (`service.rs:38-43`), `shutdown_all()`
drains it (`service.rs:319-341`), and UUIDs are asserted never to be reused
(`service.rs:91-101`). A client holding an old ID observes absence, not a reset
sequence. That is lifecycle, not recovery, and no incarnation concept is
introduced.

## Work to be done

1. Separate three lifetimes that are currently two. State the start and end
   condition of each: the terminal, the attachment, and the rendering surface.
   Today only the surface has a clear one.
2. Key attachment setup and teardown by terminal identity and component
   lifetime — never by `visible`, and never by renderer creation or
   replacement.
3. Define the client cell model as a plain data structure: grid, revision, base
   revision, geometry, palette revision, cursor, active screen, and cached
   history windows. It applies snapshots and deltas and answers queries. It
   holds no DOM node and imports no renderer.
4. Reject any frame whose declared base revision does not match the model, and
   turn that rejection into exactly one recovery boundary. A silently applied
   mismatched frame is the same defect class as two parsers. Geometry, screen,
   and palette transitions that arrive on a valid base are applied, not
   rejected — including a complete grid that replaces every row.
5. Keep the controller, attachment, cell model, sequence position, frame queue,
   selection range, scroll anchor, and pinned-to-bottom policy across normal
   hide and show transitions.
6. On hide, cancel pending fit and layout work and suppress focus and DOM
   measurement. Do not pause host parsing, attachment sequence processing, or
   cell-model updates. A hidden terminal stays current without paint.
7. On reveal, refresh font and renderer metrics, propose the desired geometry,
   and restore focus only when the terminal is the active surface. Preserve the
   pre-hide viewport policy. Geometry is applied from the frame that carries it,
   never asserted locally.
8. Distinguish a hidden initialized surface from a terminal created in a
   background tab. A never-attached terminal uses exactly one initial snapshot
   when it first attaches; it is not attached early merely to satisfy this plan.
9. Define hidden overflow in the controller:
   - mark one recovery pending;
   - invalidate and stop accepting the stale attachment generation;
   - do not reattach repeatedly while hidden; and
   - perform one recovery when the surface is revealed.
10. Settle the resize authority for hidden terminals. A hidden surface has no
    meaningful geometry. State what the host uses, and make sure a hidden
    terminal can neither take nor hold authority against a visible one.
    `resize_authority` (`core/backend/src/terminal/runtime.rs:294`) is elected
    at `:743` and cleared at `:852`, `:867`, and `:874`.
11. Own viewport intent in the model, not in the DOM. `terminalViewport.ts`
    already computes bottom offset and re-asserts it, and
    `TerminalView.tsx:255-286` already derives pin intent from wheel and key
    events. Move the intent, keep the gestures at the surface, and express
    history browsing as a revisioned history-window request rather than a read
    of a local buffer.
12. Prefetch and cache history windows against the viewport, with an explicit
    invalidation rule on resize, active-screen change, and recovery. State what
    the user sees while a window is in flight; a blank region is a decision, not
    an accident.
13. Remove the catch-up paths this makes unnecessary, starting with the theme
    and settings re-application at `TerminalView.tsx:292-306`. A catch-up path
    that survives must state why the stream cannot carry the fact.
14. Preserve exact teardown for terminal replacement, terminal exit, and true
    component unmount. Disposing the rendering surface alone is not teardown.
    Late callbacks from an old generation must not mutate the replacement.
15. Add a controller suite covering tab A to tab B to tab A, settings open and
    close, output while hidden, hidden resize, hidden overflow, terminal-ID
    replacement, renderer replacement, true unmount, stale-generation callbacks,
    delta base-revision mismatch, sequence gap, exit races, and registry
    reconciliation. Every test runs without a DOM.
16. Instrument host parse, attachment sequence, frame application, DOM
    measurement, fit, focus, and avoidable renderer work. Measure the cost of
    one idle attached hidden terminal in memory and host work, and record it.
    Any cap on concurrent hidden attachments must cite that measurement, not
    intuition.

## Acceptance criteria

- The controller, cell model, and every test for them import no DOM API, no
  xterm, and no rendering surface. This is proved by the import graph, not by a
  comment.
- Changing only visibility after initialization causes zero attach, detach,
  snapshot installation, and model reset calls. A controller test asserts the
  empty trace.
- Sequence continuity holds across a hide and show cycle. The view observes no
  gap.
- Output emitted while hidden appears exactly once and in order on reveal.
- Scrollback position, selection, scroll anchor, and pinned-to-bottom state
  survive hide and show. A user browsing history is not forced to the bottom.
- A hidden window resize converges on reveal with no attachment teardown and no
  reconstruction of terminal contents. The frame that carries the new geometry
  is the only thing that changes it.
- A hidden terminal can neither become nor remain the resize authority for a
  visible one.
- Exactly four recovery boundaries exist. Every unbased snapshot installation in
  a trace maps to one of them and to a focused test naming why it is legitimate.
- A frame whose declared base revision mismatches produces exactly one recovery
  and never a partially applied grid.
- A resize, screen change, or palette change that arrives on a valid base is
  applied as an ordinary transition and produces no recovery, even when it
  replaces every row.
- Recreating or replacing the rendering surface while the client model is valid
  produces no attach, no detach, and no snapshot request.
- One hidden overflow produces one recovery on reveal. Repeated overflow signals
  do not create concurrent attachments or recovery loops.
- A never-revealed background terminal remains unattached until it first
  attaches, and then installs exactly one initial snapshot.
- History-window requests are revisioned, cached, invalidated on resize, screen
  change, and recovery, and never produce a mixed-revision screen.
- The theme and settings catch-up path in `TerminalView` is removed, or its
  survival is justified against the stream.
- Terminal replacement and actual unmount detach the current attachment once and
  reject late work from prior generations.
- Host parse and attachment sequence counts continue while hidden; avoidable
  measurement, focus, and presentation work do not multiply with hidden panes.
- The cost of an idle hidden attachment is measured and recorded.
- A visibility transition emits no module session lifecycle event. This is a
  property to assert, not a contract to renegotiate.
- Time from clicking a background tab to a correct screen is measured before and
  after the change, with the method recorded. The measurement is reported as
  evidence. It becomes a gate only against a product constraint an owner
  approves; a direction-of-change target invented here would be an
  unauthoritative limit.

## How to validate

Add and register a serial frontend suite, including a delayed-callback harness:

```sh
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalCellModel.test.ts \
  core/frontend/terminal/tests/terminalVisibility.test.ts
rg -n 'visible' core/frontend/terminal/TerminalView.tsx
rg -n 'publishTerminalClosed' core/frontend/terminal/terminalClientRuntime.ts
rg -n 'document\.|window\.|@xterm' \
  core/frontend/terminal/terminalAttachmentController.ts \
  core/frontend/terminal/terminalCellModel.ts
just test fast
just check all
git diff --check
```

The tests must assert attachment, reset, snapshot, fit, focus, and recovery
counts rather than relying only on rendered content.

The first `rg` is the structural proof for visibility: every remaining `visible`
reference must control rendering only. A `visible` reference in an effect
dependency list that governs attachment is the defect this change removes. The
second confirms the boundary this change does not cross: the call sites of
`publishTerminalClosed` must remain registry removal, reconciliation, and close.
The third must return nothing; a hit is the renderer independence claim failing.

Manual smoke: start a long-running program, switch to another tab for a minute,
then return. The screen must be current, must not flash, the scroll position
must hold, and the program's output must be intact under the stated policy.

## Exit and rollback

Exit when the model is complete and testable without a browser, normal hide and
show is content-neutral, and every true-disposal path remains exact. Do not
respond to a hidden-rendering problem by restoring visibility-driven detach or
reconstruction; fix the presentation seam, or let the bounded overflow contract
perform one recovery.
