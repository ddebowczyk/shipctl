# Terminal end state

## Read this first

This document states where the terminal capability is going and why. The five
change documents beside it are the work. Read this one before them. If a change
document and this document disagree, this document is the authority.

The readiness set in `docs/plans/terminal-top-5-changes-sol/` makes the terminal
capability safe to change. It does not change it. This plan is the change.

## The end state

One ordered event stream for each terminal.

The host is the single authority for terminal state. Every fact that changes
that state — output bytes, geometry, palette — travels in one stream and carries
a sequence number. The view applies those facts in order and holds no state the
host does not know about. The view is a projection, not a second owner.

`reset` plus full `replay` survives only as a recovery move, and only at a real
recovery boundary:

- first attach to a terminal;
- a detected sequence gap;
- an output queue overflow;
- recreation of the renderer.

Resize, theme change, tab switch, and window hide are none of those. After this
plan they run on the normal path and never discard state.

## The root cause

The protocol can express bytes. It cannot express a state change.

There is no way for the host to say "at sequence N the geometry became 80 by
24". So when the geometry or the palette changes, the only available tool is to
discard everything and send it again. `resize()` publishes
`TerminalEvent::Replay` at `core/backend/src/terminal/runtime.rs:679`, and
`set_theme()` publishes it again at `:715`. A user who drags a window edge runs
the crash-recovery path.

That gap exists for a reason. Two VT parsers own the same screen: libghostty-vt
in the host and xterm.js in the view. They provably disagree on cursor placement
at a reflow wrap boundary; the `research/20260809-124553-fut-tty/vt-proof`
harness measures the divergence. Reset and replay is the workaround for that
disagreement.

So there are two layers:

- **the cause** — two parsers own one screen, and no protocol expresses a state
  change, so agreement can only be restored by starting again;
- **the symptom the user feels** — recovery-grade work on the routine path,
  seen as flicker, lost scroll position, and input encoded against stale modes.

Change 1 addresses the cause. Change 2 removes the symptom. Changes 3 and 4
remove the remaining routine-path recovery. Change 5 keeps the result from
decaying.

## Reference architectures

Neither comparison system runs two parsers.

- **fut** runs a daemon that holds the only VT state and ships a
  `ScreenSnapshot { cells }` to its views over MessagePack.
- **cmux** runs a separate terminal-host process with a binary framed protocol
  and ships rendered frames.

Shipctl keeps xterm.js deliberately, for its addons, links, search, and GPU
renderer. That is a defensible trade. It is not defensible to keep the trade and
never decide which parser is the authority. Change 1 is that decision.

## The five changes

1. [Resolve the VT authority](01-vt-authority-resolved.md) — decide what the
   host owns and what xterm owns, and make one of them wrong-proof rather than
   both approximately right.
2. [Ordered geometry and palette events](02-ordered-state-events.md) — add
   sequenced `Resized` and `PaletteChanged` with a renderer barrier, then delete
   the replay publication from `resize()` and `set_theme()`.
3. [Bounded, cheap recovery](03-bounded-recovery.md) — replace unbounded replay
   with a newest-suffix snapshot carrying a declared bound.
4. [Attachment follows the terminal](04-attachment-follows-terminal.md) — bind
   attachment lifetime to terminal existence, not to surface visibility.
5. [Continuous divergence gate](05-divergence-gate.md) — prove host and view
   agreement on every change instead of assuming it.

## Sequencing

```text
readiness set (docs/plans/terminal-top-5-changes-sol/)
        |
        v
1 VT authority decided ──┬──> 2 ordered state events
                         └──> 5 divergence gate

3 bounded recovery ─── independent
4 attachment lifetime ─ independent
```

- Change 1 gates changes 2 and 5. Both depend on the answer.
- Changes 3 and 4 depend only on the readiness set and may run in parallel with
  change 1.
- Change 5 is required only if change 1 keeps two parsers. If change 1 removes a
  parser, record that in the register below and close change 5 as not
  applicable.

## Decision register

This plan has one question that engineering cannot settle alone, and it gates
most of the work. Record the decision, the date, and the approver here.

| Decision | Owner | Evidence | State |
| --- | --- | --- | --- |
| VT authority split | engineering + product | change 1 | open |

The readiness register in `docs/plans/terminal-top-5-changes-sol/README.md`
holds two further open rows — the persisted scrollback domain and the
libghostty-vt dependency branch. Both must be closed before this plan starts.

## Done means

The plan is complete when all of these hold at once:

- No routine user action publishes a full replay. `resize()` and `set_theme()`
  contain no replay publication.
- Geometry and palette changes carry sequence numbers and apply in stream order
  against the surrounding output.
- A hidden or backgrounded terminal keeps its attachment and its sequence
  continuity.
- Recovery delivers a bounded snapshot with a stated bound, and the bound is
  measured rather than assumed.
- The parser authority is recorded, and either one parser owns the screen or a
  merge gate proves the two agree.
- The resize-latency and reflow-divergence baselines captured during readiness
  show the intended movement, measured by the same method.

## Out of scope

- Replacing xterm.js with a host-cell renderer, unless change 1 selects it.
- Moving the terminal host into a separate process, as cmux does.
- Changing the instance control socket's public JSON schema beyond adding the
  new semantic events through its existing adapter.
