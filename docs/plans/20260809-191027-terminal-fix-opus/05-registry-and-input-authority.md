# Phase 05 — Registry removal authority and input authority (D3, S2)

## Objective

Two behaviour changes that phase 04 deliberately excluded: make registry
events the only removal authority, and stop `TerminalView` from keeping its
own copy of the terminal lifecycle.

They share a phase because both are frontend authority questions settled by
the same test file and neither touches the VT or the wire. They keep separate
tasks, hypotheses and acceptance criteria because their failure modes are
unrelated — one is a reconciliation race, the other an input-gating race.

## Defect D3 — registry bookkeeping race

`core/frontend/terminal/terminalClientRuntime.ts`:

```ts
observeRegistryEvent(event) {                       // :88
  ...
  this.#removals.set(event.terminalId, ++this.#observation);   // records it
  this.#descriptors.delete(event.terminalId);
}

async close(terminalId) {                           // :223
  await closeTerminal(terminalId);
  const descriptor = this.#descriptors.get(terminalId)?.descriptor;
  this.#descriptors.delete(terminalId);             // no #removals entry
  ...
}
```

`reconcile()` (`:100`) preserves rows observed after `requestBoundary` and
consults `#removals` to reject stale rows. `close()` skips that bookkeeping,
so a `listTerminals()` in flight across the close can reinstate the closed
descriptor.

## Defect S2 — dual input-enablement authority

`inputEnabledRef` is written in six places
(`TerminalView.tsx:342,351,362,368,381,409,499`) and read as an input gate at
`:109` and `:146`. Independently, `TerminalClientRuntime.write` (`:205`)
rejects on `descriptor.lifecycle !== "running"`.

**These are two different facts, and collapsing them would be wrong.**

- *Transport readiness* — may input enter this attachment right now? False
  while a snapshot is installing or the stream is recovering. Owned by the
  phase-04 controller.

  **State the real reason for this gate.** It is not transport safety. The
  host PTY does not depend on renderer parse state, so a write during install
  reaches the child correctly and its echo arrives in-stream. The reason is
  **encoding**: xterm owns application-cursor-key, mouse and bracketed-paste
  mode state. That state is unreliable while a snapshot installs, so an arrow
  key can encode `\x1b[A` where the child expects `\x1bOA`.

  **Buffering the bytes does not fix this.** An earlier draft of this phase
  said to hold input and encode it after install. That is not possible through
  the seam shipctl uses: `onData` delivers bytes xterm has *already* encoded
  against the mode state of the moment. Holding them holds the stale encoding.
  Deferred encoding needs the pre-encoding intent — the raw `KeyboardEvent`
  — which is a different seam (`attachCustomKeyEventHandler`, or `onKey`'s
  `domEvent`) and an unproven one. So the seam is a hypothesis (H5.6), not an
  assumption. If no supported seam exists, input is **visibly suppressed**
  during recovery rather than silently dropped: the user must see that the
  terminal is not accepting input, because a keystroke that vanishes without a
  trace is the worst of the three outcomes.
- *Semantic write eligibility* — does this terminal's lifecycle accept input
  at all? Owned by `TerminalClientRuntime` from the registry descriptor, and
  re-confirmed by the host at the PTY boundary.

The defect is that `TerminalView` derives the *lifecycle* fact into a ref of
its own, giving one fact two owners. The fix is to delete the view's copy and
name the two facts separately — not to merge them into one.

**One authority is necessary but not sufficient — it must be re-read after
every suspension point.** herdr keeps a single input gate,
`UserWriteGate { accepting: bool }`, and `write_user_input`
(`src/pty/actor/unix.rs:102-131`) checks it **twice**: once before awaiting a
channel permit, and again after the await completes, immediately before
sending. The gate can close while the write is parked. shipctl's write path has
the same structure — an `await` on the Tauri invoke sits between the eligibility
check and the byte reaching the PTY — so a single owner that is consulted once
still admits the race it was created to close.

## Hypotheses to verify

**H5.1 — `close()` can resurrect a closed descriptor.**
Method: start `reconcile()` against a stubbed `listTerminals` that resolves
after `close()` completes, then assert the descriptor is absent. Permute the
orderings of list start, list result, close result, and `Removed` delivery.
Falsifier: the descriptor is already absent under every ordering, meaning
another guard covers it; D3 is then a documentation fix.

**H5.2 — the backend publishes `Removed` before the close command returns.**
Routing removal through the registry reducer assumes this. `runtime.rs`
removes the record and publishes before returning, but that is an assumption
this phase depends on and must therefore assert.
Falsifier: a successful close can return without publishing removal — then
this is a backend fix and phase 05 stops until it lands, because otherwise
`close()` would leave a visibly stale descriptor.

**H5.3 — duplicate `Removed` delivery is harmless.**
Method: deliver the same event twice.
Falsifier: subscribers see two semantic closes, or state corrupts — the
reducer then needs explicit idempotence by ID and revision.

**H5.4 — the two input authorities can disagree today.**
Method: drive the controller into the window between attach and the first
`afterDrain` while the descriptor reports `running`; assert what the gate does.
Falsifier: they cannot disagree in any reachable state, in which case S2 is a
clarity fix — still worth doing, but do not claim a bug fix.

**H5.6 — a pre-encoding input seam exists that can defer encoding safely.**
Method: capture the raw `KeyboardEvent` before xterm encodes it
(`attachCustomKeyEventHandler` returning false, or `onKey`'s `domEvent`), hold
it across an install, then produce the encoding the post-install mode state
implies. Assert the bytes the child receives for one mode-sensitive key
(arrow or keypad) across a mode change spanning the install.
Falsifier: no supported seam reproduces xterm's own encoding, or re-injection
is unreliable. Then the answer is visible suppression during recovery, and
this phase says so plainly instead of promising deferred delivery.

**H5.5 — lifecycle rejection is distinguishable from transport failure.**
Method: race a backend exit against a write and inspect the adapter result.
Falsifier: Tauri collapses both into one indistinguishable string, in which
case the typed result must be established at the command boundary instead.

## Tasks

1. Land the H5.1 race test first; it must fail against current `close()`.
2. Make the registry-event observation the only writer of `#descriptors`,
   `#observation` and `#removals`, and the only publisher of `closed`.
3. Reduce `close()` to: request the host close, propagate a real failure,
   return. Removal reaches the projection through the host's `Removed` event.
4. Make duplicate and out-of-order registry events idempotent by terminal ID
   and revision; publish one semantic `closed` on the present→absent
   transition only.
5. Prove a *failed* close leaves the descriptor present and records no
   removal observation.
6. Delete `inputEnabledRef`. Input flows only when the phase-04 readiness
   predicate is true, and `TerminalClientRuntime` decides eligibility.
7. Give `TerminalClientRuntime.write` a discriminated result — `written` |
   `unavailable`. A keystroke racing a normal exit is expected unavailability
   and produces no error notice; malformed protocol, authority violations and
   real transport failures stay typed and visible.
8. Route keyboard, paste and mouse input through that one call site.
9. Settle H5.6 before choosing the recovery-window behaviour. If a seam
   exists, hold the intent — not the encoded bytes — and encode after install;
   the hold is bounded by the install itself, so no duration is invented, and
   a disposed attachment discards its held intent with the generation. If no
   seam exists, suppress input visibly for the window and say so in the UI.
10. Prove a disposed or superseded generation can never write again, and that
    its held input is discarded with it.

## Acceptance criteria

- After the observed `Removed`, no ordering of an older in-flight list result
  resurrects the terminal.
- `close()` performs no descriptor mutation and publishes no `closed`.
- A successful close yields exactly one present→absent transition even if
  `Removed` arrives twice; a failed close yields none.
- Reconciliation still admits terminals created after an older list began.
- `TerminalView` holds no lifecycle-derived input flag.
- The recovery-window behaviour follows H5.6 and is one of exactly two: input
  is held as intent and delivered once after install with post-install
  encoding, or it is suppressed visibly. Silent loss is not an outcome.
- If input is held, a test types during install and asserts the exact bytes
  the child receives, including one mode-sensitive key across a mode change.
- If input is suppressed, a test asserts the user-visible signal appears and
  clears with the window.
- An exit racing a keystroke produces `unavailable` and no user-facing error;
  a genuine transport failure still surfaces once.
- Eligibility is re-read after every suspension point on the write path, not
  only on entry. A test closes the terminal while a write is parked mid-`await`
  and asserts the byte does not reach the PTY.

## Validation

```sh
just check all
just test fast
just test rust     # H5.2's backend event-before-return assertion
```

New test file: `core/frontend/terminal/tests/terminalClientRuntime.test.ts`,
registered in `ops/test/justfile` in the same commit.

## Out of scope

Backpressure, flow control, and any change to what the host sends. This phase
changes who decides, not what is decided.
