# Phase 07 — Ordered resize and local reflow

## Objective

Move the exactness guarantee from geometry changes to attach boundaries. A
resize stops producing a replay; xterm reflows its own buffer.

## Context

`core/backend/src/terminal/runtime.rs:636-680` — every resize publishes a full
replay:

```rust
self.master…resize(PtySize { rows, cols: columns, … })?;
self.vt.resize(columns, rows)?;
let descriptor = self.record.record_resize(columns, rows);
self.publish_descriptor(descriptor);
let replay = self.replay()?;
let sequence = self.next_sequence();
self.publish(TerminalEvent::Replay { sequence, replay });
```

The renderer's `installReplay` then calls `term.reset()`. Combined with
`fitAndResize` (`TerminalView.tsx:199-234`), which applies **row** changes
immediately on every observation and only debounces columns when
`buffer.active.length > 200`, a window drag produces a reset per tick.

## This is a migration another project already completed

cmux runs two renderer paths, and shipctl currently matches the one cmux moved
away from:

- Legacy daemon mirror (`crates/cmux-tui-core/src/surface.rs:2804-2873`):
  receives a replay-bearing `Resized` and rebuilds its terminal from it —
  shipctl's design today.
- v3 smart renderer (`crates/cmux-terminal-client/src/lib.rs:377-399`): on
  `Resized`, calls `terminal.resize(cols, rows, …)` on its own local parser.
  No reset. History preserved by local reflow.

openmux does the same thing in a single process: `resize` calls
`emulator.resize(cols, rows)` and defers one re-read; the comment is "Defer
prepareUpdate to next tick to ensure native reflow completes". `reset()`
exists in openmux but is not on the resize path.

## Removing the replay is not sufficient — the ordering barrier

Stopping the backend from publishing a replay leaves a race that the replay was
accidentally papering over. `applyTerminalSize` (`TerminalView.tsx:174-183`)
resizes xterm **immediately** and then invokes the host. Output the host read
before its `TIOCSWINSZ` and output it read after both arrive on the same
stream with no marker between them, so the two parsers can apply the same
bytes at different geometries. cmux avoids this by ordering a `Resized` frame
beside output and letting the client change geometry only when it consumes
that frame.

The backend performs one serial operation per changed geometry:

```text
validate authority -> PTY resize -> Ghostty resize -> descriptor update
  -> sequence += 1 -> publish Resized(sequence, revision, columns, rows)
```

The renderer must not resize optimistically ahead of that frame.

**The renderer side has a second, subtler requirement.** Receiving the channel
event is not enough: `terminalOutputQueue` writes chunks asynchronously and
xterm may still be parsing earlier bytes. `Resized` must act as a **queue
barrier** — every prior `term.write` callback completes, then `term.resize`,
then later output is released. Generalize `terminalOutputQueue` into an
ordered renderer-operation queue accepting byte writes and barriers; phase 07
reuses the same barrier for palette changes.

Drag behaviour becomes explicit rather than emergent: one resize invoke in
flight per attachment, remember only the newest desired geometry, and reissue
after acknowledgement only if it still differs from canonical. A no-op resize
publishes nothing.

**herdr already implements this, host-side, and its shape is worth copying.**
Its PTY actor keeps resize in a *coalescing latest-wins slot* rather than a
queue — `SharedPtyControls { resize: Option<PtyResizeRequest>, … }`
(`src/pty/actor/unix.rs:60-64`); `resize()` overwrites the slot and pokes a
wake pipe (`:176-200`). A drag burst therefore collapses to one `ioctl`
regardless of how many frames arrive, without a debounce interval anyone had to
invent. Two further details matter:

- **The slot is on a control path separate from the data path.** User input
  goes through a bounded async channel (`PtyIoDataCommand`, with backpressure
  via `reserve()`); resize goes through the shared slot plus a `std` control
  channel. Resize can never queue behind pending input, and input can never be
  starved by resize.
- **The resize carries the VT's response to it.** `PtyResizeRequest` holds
  `terminal_responses: Vec<Bytes>` (`:54-57`), so whatever the VT emits because
  of the resize is delivered with the resize and cannot be reordered against
  the `ioctl`. The general case has the same guard:
  `write_terminal_response` takes a *closure*, and generates and enqueues the
  bytes under one `response_order` mutex (`:159-172`), so two responders cannot
  interleave generation with enqueue.

Coalescing at the host does not remove the renderer barrier — the two solve
different halves — but it does mean the drag path is bounded on both sides.

## Hypotheses to verify

**H7.0 — output can currently straddle a resize at two different geometries.**
Method: block the host resize, inject output before, during and after it,
assert the sequence order and the geometry each frame parses at.
Falsifier: the actor already gives output and geometry one unambiguous order,
in which case the marker still helps the renderer but the race is not real.

**H7.1 — xterm's local reflow and libghostty's reflow agree closely enough.**
This is the load-bearing risk of the whole plan. The two emulators reflow
independently after this change and are only reconciled at the next attach.
Method: fixture-based differential test. Feed a recorded byte stream to both,
resize both, compare rendered rows. Reuse the harness pattern from the VT
proof referenced at `replay.rs:1-5`
(`research/20260809-124553-fut-tty/vt-proof`).
Falsifier: they diverge on cases users hit — wrapped lines, wide glyphs,
trailing-blank continuations. Divergence does not necessarily sink the phase;
it sizes the resync trigger (H7.3).

**H7.2 — `preserveTerminalViewport` at `TerminalView.tsx:174-183` becomes
live.** It currently wraps a local resize whose result is immediately
discarded by the replay. After this phase it does real work.
Method: assert viewport position is preserved across a width change with
history present.
Falsifier: it does not preserve position under local reflow, in which case it
needs fixing here rather than being assumed correct.

**H7.3 — a resync trigger is still needed, and when.**
cmux keeps `ResizeAck` with `result_flags & 1` signalling that the canonical
size differs from the requested one, plus a `ResyncRequired` escape hatch.
shipctl has `resync_required` already (`TerminalView.tsx:405`).
Method: enumerate the states where host and renderer geometry can disagree —
rejected resize (`resize_authority` mismatch, `runtime.rs:654`), clamped
dimensions (`validate_dimensions`), alternate-screen switch during resize.
Falsifier: none exist, and the trigger can be dropped. Unlikely; assume it is
needed and define it precisely.

**H7.5 — ordering the resize does not make dragging feel worse.**
This is the cost side of the barrier and neither this plan nor the parallel one
originally priced it. Today `applyTerminalSize` resizes xterm immediately, so
the visual response is local and instant. After this phase every drag frame
waits for PTY ioctl → Ghostty resize → descriptor → IPC before xterm changes
grid, and in the interval xterm renders the old grid inside a
newly-sized container.
Method: measure the propose→marker→applied latency during a continuous drag at
each supported scrollback setting, and record what the gap looks like on
screen.
Falsifier: the latency or the visible artifact is unacceptable. **The
mitigation is presentational** — let the container letterbox against the
terminal background for the interval — **not optimistic local resize**, which
would reintroduce exactly the two-geometry race H7.0 exists to close. If
presentational mitigation is insufficient, that is an owner decision, escalated
with the measurement.

**H7.4 — the row-immediate / column-debounced split in `fitAndResize` is still
right.** Its thresholds (`> 200` rows, `100` ms) are attributed in-comment to
upstream commit `59e8fc7`, not chosen here, so they carry an authority. But
their *reason* — "reflowing a long scrollback buffer on every width
observation is costly" — was written when every observation also caused a
reset.
Method: measure fit cost with local reflow and no reset.
Falsifier: the debounce is no longer needed. Do not remove it on intuition;
either keep the upstream attribution or replace it with a measurement.

## Tasks

1. Land the H7.1 differential fixture test first. It is the gate.
2. Backend: `runtime.rs::resize` stops publishing `TerminalEvent::Replay`. It
   still resizes the PTY, resizes the VT engine, records the descriptor, and
   publishes the descriptor.
3. Add a sequenced `TerminalEvent::Resized` carrying canonical geometry and
   revision, extracted for sequence and gap purposes exactly like `Output`.
   The resize invoke returns a typed acknowledgement (canonical geometry plus
   `changed`) for coalescing only — it never drives the renderer resize.
4. Generalize `terminalOutputQueue` into an ordered operation queue with
   barriers, and apply `Resized` through it wrapped in
   `preserveTerminalViewport`. Never reset.
5. Implement drag coalescing: one in-flight request, newest desired geometry
   only, reissue after acknowledgement only when it still differs. Coalesce at
   the host too, in herdr's shape — a latest-wins slot on a path that cannot
   queue behind pending input — and deliver any VT response to the resize
   together with the resize rather than as a separate write.
6. Define the resync trigger from H7.3 and route it through the existing
   `resync_required` event. The controller from phase 04 owns the transition.
7. Re-evaluate the `fitAndResize` debounce per H7.4 and record the outcome
   either way.

## Acceptance criteria

- A resize produces no `TerminalEvent::Replay` and no `term.reset()`.
- Each changed geometry yields exactly one sequenced `Resized` after the host
  applied it; a same-size resize yields none.
- Output on each side of the marker parses at the same geometry in host and
  renderer **even when prior xterm writes are artificially delayed** — this is
  the assertion that proves the barrier, not just the event.
- A rapid drag converges to the latest geometry with at most one in-flight
  request and no stale-size queue.
- The drag latency from H7.5 is measured and recorded, and any visible gap
  between container and grid is filled presentationally. No acceptance path
  resizes xterm ahead of the marker.
- History and viewport survive a width change, proven by test.
- The differential fixture test documents the measured divergence between
  xterm and libghostty reflow, and every divergence class either round-trips
  or is covered by the resync trigger.
- The resync trigger's conditions are enumerated in the controller, not
  discovered at runtime.
- Attach remains exact: after any resync, renderer state equals host state.

## Validation

```sh
just test rust      # backend resize no longer publishes a replay
just test fast      # controller + differential fixtures
just check all
```

Manual: drag a window edge continuously with several thousand lines of history
present. Expected: no flash, no history loss, no visible reset.

## Rollback

**Not by restoring replay-on-resize.** That is the original defect: it resets
the renderer, discards viewport and selection, and — after phase 01 raised
retention — sends a *larger* payload on every drag tick than it does today.
Reverting to it would trade a divergence risk for a certainty.

If H7.1 shows unacceptable divergence, the ordering work still stands on its
own and stays. The failing part is only local reflow, so:

1. Keep the sequenced `Resized` marker, the queue barrier, and drag
   coalescing. They are independently correct and phase 08 depends on them.
2. Route the divergent cases into phase 09's bounded recovery through the
   existing `resync_required` path — a recovery replay at the resizes the
   differential test flagged, not at every resize. Coalescing already bounds
   how often that can fire during a drag.
3. If divergence is broad enough that "the flagged cases" is most resizes,
   stop and escalate with the differential measurements rather than widening
   the fallback until it becomes replay-on-resize again. Whether to accept
   visible divergence, vendor a reflow fix, or change the retention model is
   an owner decision, not an implementer's fallback.

Phase 08 remains independent in either direction.

## Out of scope

Theme changes (phase 08). They travel a different code path (`set_theme`,
`runtime.rs:706-716`) and have a different correct answer.
