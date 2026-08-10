# Phase 02 — Resize clear suppression (evidence-gated)

## Status: conditional, and split across the plan

**The evidence trace runs now. Any implementation waits until after phase 07.**

Two reasons. First, if H2.1 is falsified the phase is deleted and the finding
is reported in one line — so the trace is the only part guaranteed to be
useful, and it is cheap. Second, H2.3 wants suppression keyed on the resize
generation rather than a wall-clock window, and **that generation does not
exist until phase 07 introduces the sequenced `Resized` marker**. Implementing
before then forces the copied-timer design this phase explicitly rejects.

A third reason emerged from the parallel review and is worth stating: ordered
resize may itself change whether the clear is a problem. A clear that today
lands after the renderer has already resized may, under the ordered barrier,
land in a well-defined position. Measure first, implement after phase 07,
against the behaviour that will actually ship.

**If H2.1 is falsified, the phase is deleted.** It is written down
because openmux treats it as a real, load-bearing defence, and because it sits
*upstream* of every other fix here: a perfect attachment protocol still loses
history if the shell itself clears the scrollback.

## Context

openmux strips clear-screen and clear-scrollback sequences out of the PTY
stream for a window after every resize
(`src/effect/services/pty/data-handler.ts:75,124-128,457-462,501-508`):

```ts
// Suppress ALL clear sequences during resize suppression window
// (both CSI 2 J and CSI 3 J). Shells send these during SIGWINCH
// handling - dropping them preserves reflowed content
batch = batch
  .replace(SCROLLBACK_CLEAR_REGEX, '')
  .replace(SCROLLBACK_CLEAR_C1_REGEX, '');
batch = suppressClearScreenSequences(batch);
```

Both the C0 form (`\x1b[…J`) and the C1 form (`\x9b…J`) are handled. Outside
the window a real `CSI 3 J` is honoured and history is dropped.

In shipctl the equivalent injection point is
`TerminalRuntime::handle_output` in `core/backend/src/terminal/runtime.rs`,
where `ReaderEvent::Data` is fed to `self.vt.feed(&data)`. The host owns the VT
state, so suppression is a host-side concern; the renderer never sees the
issue independently.

## Hypotheses to verify

**H2.1 — a shell under shipctl emits `CSI 2 J` or `CSI 3 J` while handling
SIGWINCH, and history is lost as a result.**
Method: temporary instrumentation in `handle_output` logging any `…J` sequence
together with the time since the last `resize()` call; drive a real terminal
through a window drag with several thousand lines of history; record
`scrollback_rows()` before and after.
Falsifier: no `J` sequences correlate with resize, or `scrollback_rows()` is
unchanged across the gesture. **Then stop — this phase is rejected.**

**H2.2 — the clears are attributable to the resize, not to user or program
intent.**
Method: with H2.1 confirmed, check whether the same shell emits the sequence
absent a resize. Only clears that appear exclusively in the resize window
qualify.
Falsifier: the shell clears at other times too, meaning a blanket window would
suppress legitimate clears; the suppression must then key on something
narrower than a timer.

**H2.3 — suppression can be keyed on the resize generation rather than a
wall-clock window.**
Rationale: openmux's `CLEAR_SUPPRESSION_WINDOW_MS = 50` carries no stated
derivation. shipctl already sequences every event and knows exactly when it
issued `TIOCSWINSZ`. A generation- or byte-offset-scoped rule needs no
invented duration.
Falsifier: the shell's clear arrives after output that must not be suppressed,
so the boundary genuinely requires a time component — in which case the
duration becomes an `OPEN DECISION` with a measured distribution behind it,
not a copied constant.

## Tasks — trace (now)

1. Instrument `handle_output` as described in H2.1 and record the result.
   Report it either way; a negative result deletes the rest of this phase and
   is worth the same one line as a positive one.
2. If positive, capture the exact sequence signatures and their position
   relative to the resize so phase 07 can key on them precisely.

## Tasks — implementation (after phase 07, if H2.1 and H2.2 confirm)

1. Add a suppression filter between `ReaderEvent::Data` and `self.vt.feed()`
   in `runtime.rs`, scoped by whatever H2.3 establishes.
2. Handle both `\x1b[…J` and `\x9b…J`. Suppress only the erase-display forms
   the measurement implicated; do not filter erase-line.
3. Never suppress bytes on the path to subscribers without suppressing them on
   the path to the VT engine — the host replay and the renderer stream must
   not diverge.
4. Land a unit test over the filter function: a fixed byte string in, the
   expected string out, for both C0 and C1 forms, and a case proving an
   unscoped clear passes through untouched.

## Acceptance criteria

- The suppression rule's scope has a stated derivation; no unexplained
  millisecond constant.
- A test proves a clear inside the scope is dropped and an identical clear
  outside it is not.
- A test or recorded measurement proves history survives a resize gesture that
  previously destroyed it.
- Host VT state and the subscriber byte stream remain identical.

## Validation

```sh
just test rust
```

Manual: the H2.1 harness, re-run, showing `scrollback_rows()` preserved across
the same gesture.

## Known limitation to carry forward

openmux's archived history is never reflowed — archived chunks keep the width
they were written at. shipctl has no archive tier, so this limitation does not
apply here; do not import it by adding one.

## Out of scope

Any disk-backed scrollback archive. That is openmux's answer to a different
problem (a multiplexer serving many clients), and nothing in the reported
defects calls for it.
