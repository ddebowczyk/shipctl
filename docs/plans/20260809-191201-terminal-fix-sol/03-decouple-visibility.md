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

### H3.4 — First reveal is a first attach

A terminal created in a background tab produces output before any xterm or
attachment exists. On first reveal, the Phase 06B snapshot reconstructs the
newest retained suffix and reports any older unavailable history. Falsifier:
pre-reveal rows disappear without structured loss metadata.

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
8. Add a background-create fixture: create terminal B without revealing it,
   emit more than the row and byte budgets, then reveal it for the first time.
   Assert one initial attach and a derived `history_truncated` status whose
   cause is `host_eviction`, `snapshot_omission`, or both. Do not classify
   bytes already evicted by Ghostty as snapshot omission.

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
- A never-revealed background terminal either restores all retained pre-reveal
  rows or reports `history_truncated` with the exact physical-eviction and/or
  snapshot-omission cause on its first attach.

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
