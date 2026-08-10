# Phase 03 — Decouple attachment lifetime from visibility

## Outcome

Once a terminal view has been initialized, tab switches and settings-overlay
transitions hide its surface without detaching, replaying, resetting, or losing
its viewport.

## Context

`AppShell` keeps terminal tabs mounted with `display: none`, and
`terminalCache.ts` intends their xterm instances to survive. However,
`TerminalView`'s attachment effect depends on `visible`; cleanup detaches and a
later reveal attaches and calls `term.reset()`. The renderer object survives,
but its content continuity does not.

Herdr supplies the useful invariant: hidden panes still parse output, but must
not trigger presentation work merely to keep terminal state current. In this
phase both host Ghostty and attached xterm remain stream consumers because raw
PTY output is non-replaceable. Visibility may suppress only focus, layout,
paint/addon work proven unnecessary, and other DOM-facing work.

## Hypotheses to verify

### H3.1 — Hidden parsing

xterm can continue parsing queued output while its container is hidden. Stream
numbered output through repeated hide/show and compare with an always-visible
control. Falsifier: hidden parsing loses or reorders supported output.

### H3.2 — Reveal fit without attach

Fit should run on reveal, but attachment should not restart. Resize while
hidden, reveal, and inspect attachment ID, geometry marker, viewport, and
contents. Falsifier: correct reveal requires a new attachment.

### H3.3 — Hidden overflow coalescing

A hidden queue overflow can become one pending recovery instead of repeated
hidden reattach. Inject overflow while hidden, then reveal. Falsifier: multiple
recoveries occur or stale frames install.

### H3.4 — First reveal is a recovery boundary

A terminal created in a background tab produces output before any xterm or
attachment exists. Characterize this separately from hide/show: first reveal
must use the initial-snapshot path, not pretend that a live renderer was hidden.
The Phase 06B gate later requires reconstruction and loss metadata. Falsifier:
the background terminal attaches early or first reveal bypasses snapshot install.

### H3.5 — Hidden work is presentation-only

Host PTY reads/Ghostty parsing and frontend sequence/write counts remain equal
to an always-visible control, while DOM measurement, focus, and redundant paint
work stop. Falsifier: hiding pauses either parser, drops raw frames, or performs
the same presentation work as the visible control.

## Tasks

1. Split `TerminalView` into two effects:
   - an attachment effect keyed by terminal identity and component lifetime;
   - a surface effect keyed by `visible`, container, fonts, and fit needs.
2. Gate the first attachment on successful renderer initialization, not on
   every visible transition. Preserve the controller and attachment across
   subsequent hides.
3. On hide:
   - cancel pending fit/column timers;
   - retain attachment, controller, xterm buffer, output queue, selection, and
     scroll anchor; and
   - avoid focus or DOM measurement work.
4. On reveal:
   - refresh font metrics and renderer dimensions;
   - request the latest proposed size through the Phase 04-ready resize seam;
   - restore focus only if the tab is active; and
   - preserve the pre-hide pinned-to-bottom or anchored viewport policy.
5. Define hidden overflow behavior in the controller: mark recovery pending,
   stop accepting frames from the stale attachment, and perform exactly one
   reattach on reveal. Do not spin a recovery loop while hidden.
6. Add `core/frontend/terminal/tests/terminalVisibility.test.ts` for tab A ->
   tab B -> tab A, settings open/close, output while hidden, hidden resize,
   hidden overflow, terminal ID replacement, and actual component unmount.
   Register it in `ops/test/justfile`.
7. Keep detach on terminal ID replacement, exit cleanup, and component unmount.
   Prove each path disposes the exact current attachment once.
8. Add a background-create characterization fixture: create terminal B without
   revealing it, emit more than the row and byte budgets, then reveal it for the
   first time. In this phase assert zero pre-reveal attachment and exactly one
   initial snapshot install. Carry row reconstruction and the derived
   `history_truncated` assertions into Phase 06B rather than making Phase 03
   depend on the future codec.
9. Instrument hidden output at the host parse, attachment sequence, xterm write,
   DOM measurement, fit, focus, and addon-paint seams. Assert state work
   continues and avoidable presentation work does not scale with hidden-pane
   count. Do not coalesce or discard raw output as a render optimization.

## Acceptance criteria

- After first initialization, changing only `visible` produces zero attach,
  detach, replay-install, and `term.reset()` calls.
- Output emitted while hidden appears once and in order on reveal.
- Hide/show preserves scrollback, selection, and whether the viewport was
  pinned to bottom; a user scrolled into history is not forced to bottom.
- Revealing after a hidden window resize reaches the host-confirmed geometry
  without reconstructing terminal contents.
- One hidden overflow yields one recovery on reveal; repeated overflow signals
  do not create parallel or repeated recovery loops.
- Terminal replacement and true unmount still detach exactly once and ignore
  late callbacks.
- A never-revealed background terminal stays unattached before reveal and uses
  exactly one initial-snapshot boundary on reveal. Phase 03 does not claim that
  the pre-Phase-06B formatter already restores or reports all retained history.
- Under sustained output, hiding preserves host parse and attachment sequence
  counts while suppressing DOM measurement/focus and bounded avoidable paint
  work. Fifteen hidden panes do not multiply presentation work by pane count.

## Validation

```sh
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalVisibility.test.ts
just test fast
just check all
git diff --check
```

## Exit condition

Proceed only when normal hide/show is content-neutral and unmount cleanup is
still exact. Do not compensate for a hidden-rendering defect by restoring the
old visibility-driven replay boundary.
