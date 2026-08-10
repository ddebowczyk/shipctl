# Visibility is presentation only

## Outcome

After a terminal renderer has initialized, tab changes and overlays can hide
its surface without detaching the attachment, resetting xterm, installing a
snapshot, or losing the user's viewport.

## Context and purpose

`TerminalView` currently treats `visible` as an attachment-lifecycle input.
Its cleanup detaches, and a later reveal creates a new attachment whose replay
installer resets xterm. The cached xterm object survives while its content
continuity does not.

This distorts a presentation fact into a terminal-domain event. It also makes
every later resize and palette change harder because the implementation cannot
distinguish a hidden live mirror from a new renderer.

The target rule is:

```text
component/terminal identity -> attachment lifetime
visibility                  -> surface work only
```

Both Ghostty and the attached xterm continue consuming the non-replaceable
stream while hidden. Only DOM measurement, focus, and presentation work proven
unnecessary may pause.

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

## Work to be done

1. Separate attachment lifetime from surface lifetime. Key attachment setup and
   teardown by terminal identity, renderer creation, replacement, and component
   lifetime—not by `visible`.
2. Keep the controller, attachment, xterm buffer, sequence position, output
   queue, selection, scroll anchor, and pinned-to-bottom policy across normal
   hide/show transitions.
3. On hide, cancel pending fit and layout work and suppress focus and DOM
   measurement. Do not pause host parsing, attachment sequence processing, or
   xterm writes.
4. On reveal, refresh font and renderer metrics, propose the desired geometry
   through the resize seam, and restore focus only when the terminal is the
   active surface. Preserve the pre-hide viewport policy.
5. Distinguish a hidden initialized renderer from a terminal created in a
   background tab. A never-attached renderer uses exactly one initial snapshot
   when first revealed; it is not attached early merely to satisfy this plan.
6. Define hidden overflow in the controller:
   - mark one recovery pending;
   - invalidate and stop accepting the stale attachment generation;
   - do not reattach repeatedly while hidden; and
   - perform one recovery when the surface is revealed.
7. Preserve exact teardown for terminal replacement, terminal exit, renderer
   disposal, and true component unmount. Late callbacks from an old generation
   must not mutate the replacement.
8. Add a visibility suite covering tab A -> tab B -> tab A, settings
   open/close, output while hidden, hidden resize, hidden overflow, terminal-ID
   replacement, renderer replacement, and true unmount.
9. Instrument host parse, attachment sequence, xterm write, DOM measurement,
   fit, focus, and avoidable renderer work. Prove that state work continues
   while hidden and presentation work does not scale with hidden-pane count.

## Acceptance criteria

- Changing only visibility after initialization causes zero attach, detach,
  snapshot installation, replay installation, and `term.reset()` calls.
- Output emitted while hidden appears exactly once and in order on reveal.
- Scrollback, selection, scroll anchor, and pinned-to-bottom state survive
  hide/show. A user browsing history is not forced to the bottom.
- A hidden window resize converges through the host-confirmed resize path on
  reveal without reconstructing terminal contents.
- One hidden overflow produces one recovery on reveal. Repeated overflow
  signals do not create concurrent attachments or recovery loops.
- A never-revealed background terminal remains unattached until first reveal
  and then installs exactly one initial snapshot.
- Terminal replacement and actual unmount detach the current attachment once
  and reject late work from prior generations.
- Host parse and attachment sequence counts continue while hidden; avoidable
  measurement, focus, and presentation work do not multiply with hidden panes.

## How to validate

Add and register a serial frontend suite, including a delayed-callback harness:

```sh
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalVisibility.test.ts
just test fast
just check all
git diff --check
```

The test must assert attachment, reset, snapshot, fit, focus, and recovery
counts rather than relying only on rendered text.

## Exit and rollback

Exit when normal hide/show is content-neutral and all true-disposal paths
remain exact. Do not respond to a hidden-rendering problem by restoring
visibility-driven detach or replay; fix the presentation seam or let the
bounded overflow contract perform one recovery.
