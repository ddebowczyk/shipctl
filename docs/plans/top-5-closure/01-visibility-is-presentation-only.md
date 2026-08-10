# Visibility is presentation only

## Outcome

After a terminal renderer has initialized, tab changes and overlays can hide
its surface without detaching the attachment, resetting xterm, installing a
snapshot, or losing the user's viewport.

## Context and purpose

`TerminalView` currently treats `visible` as an attachment-lifecycle input. The
effect returns early when the surface is hidden
(`core/frontend/terminal/TerminalView.tsx:238`), `visible` sits in the effect
dependency list (`:512`), and the cleanup detaches (`:502`). The container
itself never leaves the DOM; it only changes `display` (`:537`). So the cached
xterm object survives while its content continuity does not, and a later reveal
creates a new attachment whose replay installer resets xterm.

This distorts a presentation fact into a terminal-domain event. Switching tabs
runs recovery, caused by an ordinary click.

It also produces a second class of defect. The theme and settings catch-up at
`:292-306` exists only because settings changed while the terminal was detached
and had to be re-applied by hand; `applyTerminalSettings` skips hidden
terminals to avoid corrupting xterm state. Every catch-up path is a chance to
diverge from the host, and each one disappears once the stream is continuous.

The backend already models this correctly. Attachments carry their own identity
(`TerminalAttachmentId`), the runtime handles several at once, and it elects a
resize authority among them. The frontend is the side that conflates attachment
with surface.

The target rule is:

```text
component/terminal identity -> attachment lifetime
visibility                  -> surface work only
```

Both Ghostty and the attached xterm continue consuming the non-replaceable
stream while hidden. Only DOM measurement, focus, and presentation work proven
unnecessary may pause.

This change must land before ordered resize and palette work. Until visibility
stops controlling the attachment, the implementation cannot tell a hidden live
mirror from a new renderer, and hidden geometry and palette behavior cannot be
made correct.

## Dependencies

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
- `ops/test/justfile`

The module boundary is **not** in scope, despite the surface similarity.
Attachment lifetime is invisible to modules. `TerminalClientRuntime.detach()`
delegates only to `detachTerminal()` (`terminalClientRuntime.ts:200-202`) and
publishes nothing. `publishTerminalClosed` is called from registry removal
(`:93`), reconciliation (`:135`), and manual close (`:228`) — all terminal
registry lifecycle, none of them on the attach or detach path. Modules
therefore observe terminal lifecycle, not attachment visibility, and this
change cannot re-time what they see.

## Work to be done

1. Separate three lifetimes that are currently two. State the start and end
   condition of each: the terminal, the attachment, and the rendering surface.
   Today only the surface has a clear one.
2. Key attachment setup and teardown by terminal identity, renderer creation,
   replacement, and component lifetime — never by `visible`.
3. Keep the controller, attachment, xterm buffer, sequence position, output
   queue, selection, scroll anchor, and pinned-to-bottom policy across normal
   hide and show transitions.
4. On hide, cancel pending fit and layout work and suppress focus and DOM
   measurement. Do not pause host parsing, attachment sequence processing, or
   xterm writes.
5. On reveal, refresh font and renderer metrics, propose the desired geometry
   through the existing resize seam, and restore focus only when the terminal
   is the active surface. Preserve the pre-hide viewport policy. That seam
   still publishes replay at this point in the sequence; change 02 replaces it
   with the ordered marker. Do not build a second geometry path here to work
   around the ordering that change 02 introduces.
6. Distinguish a hidden initialized renderer from a terminal created in a
   background tab. A never-attached renderer uses exactly one initial snapshot
   when first revealed; it is not attached early merely to satisfy this plan.
7. Define hidden overflow in the controller:
   - mark one recovery pending;
   - invalidate and stop accepting the stale attachment generation;
   - do not reattach repeatedly while hidden; and
   - perform one recovery when the surface is revealed.
8. Settle the resize authority for hidden terminals. A hidden surface has no
   meaningful geometry. State what the host uses, and make sure a hidden
   terminal can neither take nor hold authority against a visible one.
   `resize_authority` (`core/backend/src/terminal/runtime.rs:294`) is elected at
   `:743` and cleared at `:852`, `:867`, and `:874`.
9. Remove the catch-up paths this makes unnecessary, starting with the theme
   and settings re-application at `TerminalView.tsx:292-306`. A catch-up path
   that survives must state why the stream cannot carry the fact.
10. Preserve exact teardown for terminal replacement, terminal exit, renderer
    disposal, and true component unmount. Late callbacks from an old generation
    must not mutate the replacement.
11. Add a visibility suite covering tab A to tab B to tab A, settings open and
    close, output while hidden, hidden resize, hidden overflow, terminal-ID
    replacement, renderer replacement, and true unmount.
12. Instrument host parse, attachment sequence, xterm write, DOM measurement,
    fit, focus, and avoidable renderer work. Measure the cost of one idle
    attached hidden terminal in memory and host work, and record it. Any cap on
    concurrent hidden attachments must cite that measurement, not intuition.

## Acceptance criteria

- Changing only visibility after initialization causes zero attach, detach,
  snapshot installation, replay installation, and `term.reset()` calls. A
  controller test asserts the empty trace.
- Sequence continuity holds across a hide and show cycle. The view observes no
  gap.
- Output emitted while hidden appears exactly once and in order on reveal.
- Scrollback, selection, scroll anchor, and pinned-to-bottom state survive hide
  and show. A user browsing history is not forced to the bottom.
- A hidden window resize converges through the host-confirmed resize path on
  reveal, and the reveal itself performs no attachment teardown.
  *Staged criterion:* this change removes the teardown, but the resize path
  still publishes replay until
  [change 02](02-resize-is-an-ordered-boundary.md) removes it. A
  geometry-changing reveal therefore still reconstructs contents at the end of
  this change. Assert the teardown-free property here; assert
  reconstruction-free geometry convergence in change 02.
- A hidden terminal can neither become nor remain the resize authority for a
  visible one.
- One hidden overflow produces one recovery on reveal. Repeated overflow
  signals do not create concurrent attachments or recovery loops.
- A never-revealed background terminal remains unattached until first reveal
  and then installs exactly one initial snapshot.
- The theme and settings catch-up path in `TerminalView` is removed, or its
  survival is justified against the stream.
- Terminal replacement and actual unmount detach the current attachment once
  and reject late work from prior generations.
- Host parse and attachment sequence counts continue while hidden; avoidable
  measurement, focus, and presentation work do not multiply with hidden panes.
- The cost of an idle hidden attachment is measured and recorded.
- A visibility transition emits no module session lifecycle event. This is a
  property to assert, not a contract to renegotiate.
- Time from clicking a background tab to a correct screen improves against the
  pre-change path, or a named owner accepts the result.

## How to validate

Add and register a serial frontend suite, including a delayed-callback harness:

```sh
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalVisibility.test.ts
rg -n 'visible' core/frontend/terminal/TerminalView.tsx
rg -n 'publishTerminalClosed' core/frontend/terminal/terminalClientRuntime.ts
just test fast
just check all
git diff --check
```

The test must assert attachment, reset, snapshot, fit, focus, and recovery
counts rather than relying only on rendered text.

The first `rg` result is the structural proof. Every remaining `visible`
reference must control rendering only. A `visible` reference in an effect
dependency list that governs attachment is the defect this change removes. The
second confirms the boundary this change does not cross: the call sites of
`publishTerminalClosed` must remain registry removal, reconciliation, and
close. A new call site on an attach or detach path would make visibility
visible to modules, which this change must not do.

Manual smoke: start a long-running program, switch to another tab for a minute,
then return. The screen must be current, must not flash, the scroll position
must hold, and the program's output must be intact under the stated policy.

## Exit and rollback

Exit when normal hide and show is content-neutral and all true-disposal paths
remain exact. Do not respond to a hidden-rendering problem by restoring
visibility-driven detach or replay; fix the presentation seam, or let the
bounded overflow contract perform one recovery.
