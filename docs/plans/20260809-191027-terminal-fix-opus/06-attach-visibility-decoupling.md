# Phase 06 — Decouple attachment from tab visibility

## Objective

Stop tearing down and rebuilding the terminal every time a tab is hidden.

## Context — the defect neither expert report named

`core/frontend/terminal/TerminalView.tsx`:

```ts
useEffect(() => {
  if (!containerRef.current || !visible) return;        // :237
  ...
  return () => {                                         // :490-511
    disposed = true;
    attachmentGenerationRef.current += 1;
    unregisterTerminal(terminalId);
    if (attachment) void TERMINAL_CLIENT_RUNTIME.detach(attachment.attachmentId)…
  };
}, [terminalId, visible, getOrCreateTerminal, fitAndResize]);   // :512
```

`visible` is a dependency, and the effect bails when false. Hiding therefore
runs the full cleanup — detach, unregister, generation bump — and re-showing
runs `attachRenderer` → `installReplay` → `term.reset()`.

`core/frontend/shell/AppShell.tsx:877-895` never unmounts a terminal tab; it
toggles `display: block/none`. `terminalCache.ts` is commented "Keep terminal
instances alive across tab switches" — the *instance* survives, its *content*
does not. Every tab switch, settings overlay and sidebar toggle crosses a
reset boundary.

## Reference behaviour

openmux never disposes the emulator for a hidden pane. It downgrades the pane
to `background-hidden` (`src/terminal/pty-priority.ts:37-85`): the native read
loop is paused, no emulator updates, no rendering; bytes accumulate and are
flushed on refocus. A visible-but-unfocused pane still gets a 1 Hz pulse whose
stated purpose is "keeps the child process unblocked".

cmux's equivalent releases the *surface size* for a hidden view "while
retaining the stream for a warm cache" (`cmux-tui/spec/render.md:191`).

herdr makes the same split explicit, and drops the *render*, not the *parse*.
Its server is headless: panes keep reading and parsing whether or not any
client is attached, which is how it reports a pane as working or blocked while
nobody is watching. What it discards is render work — `RenderSignal`
(`src/render_signal.rs`) coalesces render requests into one pending flag and
keeps the origin of each (`RenderRequest { generic, pty_sources }`) for the
stated reason that the headless server can then "discard PTY-only updates
hidden from every client". Origin is retained precisely so a hidden-pane update
can be dropped without dropping a structural one.

Neither detaches. One thing **not** to copy: openmux caps its hidden-pane raw
buffer at 4 MB and silently drops data past it. shipctl's host owns the VT
state, so a hidden renderer needs no buffer at all — it can resync from the
host replay on reveal.

## Hypotheses to verify

**H6.1 — hiding a tab currently causes a detach and a `term.reset()`.**
Method: with the phase-04 controller in place, drive `visible: true → false →
true` against a fake runtime and count `attach`/`detach`/`reset` calls.
Falsifier: counts are zero — the defect is not real and the phase closes.

**H6.2 — an xterm instance can be opened only once, while hidden, without
breaking layout.**
Why it matters: `term.open()` on a `display: none` container yields zero
dimensions, which is the plausible original reason for the `!visible` guard.
Method: open on first reveal, keep the instance and the attachment alive
thereafter; assert `proposeDimensions()` is not consulted while hidden.
Falsifier: xterm requires a live layout for correctness beyond fitting, in
which case mount stays reveal-gated but the *attachment* still must not be.

**H6.3 — a hidden, attached terminal does not accumulate unbounded renderer
work.**
Method: feed sustained output to a hidden terminal; observe the output queue.
`terminalOutputQueue.ts:11` already caps pending bytes at 1 MiB and requests a
replay on overflow rather than truncating — verify that path is what fires.
Falsifier: something other than the 1 MiB overflow path bounds the work, or
nothing does.

Note that this hypothesis measures the *bound*; it does not decide the
*behaviour*. That is settled below, by design, because leaving it to the
overflow path is exactly how hidden reattach churn happens.

## Consequence to carry into phase 08

Keeping hidden terminals attached means events now reach a hidden xterm for
the first time. One of those is already known to be unsafe:
`terminalTheme.ts:84-86` records that setting `options.theme` on a
`display: none` terminal corrupts xterm's internal scroll state, and
`TerminalView.tsx:293,304-305` defers theme changes until reveal because of
it. Phase 08 owns the resolution; this phase must not remove the deferral
without it.

## Hidden overflow is designed, not discovered

Keeping hidden terminals attached creates a state that does not exist today: a
terminal whose queue overflows while nothing is rendering. Relying on the
existing overflow → request-replay path there would recover a terminal nobody
is looking at, and — under sustained output — do it again immediately, and
again. That is a churn loop, and it is worth cost precisely when it buys
nothing.

So the hidden case is a distinct state with an explicit rule:

- On overflow while hidden, the controller sets `recoveryPending` and stops
  accepting frames from the current attachment. It does **not** reattach. The
  interception point is the existing `requestReplay`
  (`terminalOutputQueue.ts:67`), which fires unconditionally on overflow
  today; it becomes conditional on visibility rather than gaining a second
  caller.
- While `recoveryPending` is set and the terminal is hidden, incoming frames
  are dropped rather than queued. Nothing is rendered and nothing accumulates,
  so a second overflow cannot occur and no second recovery can be scheduled.
- On reveal with `recoveryPending` set, the controller performs **exactly one**
  recovery — the phase 09 bounded replay — and clears the flag.
- A visible terminal keeps today's behaviour: overflow recovers immediately.

The invariant to assert is a count, not an absence: N seconds of sustained
output to a hidden terminal yields **at most one** recovery, and it happens on
reveal.

## Two consequences of long-lived attachments

**A terminal created in a background tab has no attachment until first
reveal.** Mount is still reveal-gated (H6.2), so the host runs with no
subscriber and its output is recoverable only from the snapshot — bounded by
exactly the phase 01 retention budget. That is correct behaviour, but it must
not be silent.

Report it with the right field. Output the host discarded before the reveal is
**`host_eviction`** (`row_limit` or `byte_limit`), a retention fact. It is not
`snapshot_truncated`, which means the host still holds rows this snapshot
omitted — a transport fact. An earlier draft used the second label for the
first case, which would blame the snapshot for a retention loss and send the
next reader to the wrong phase. Phase 09 keeps them separate; this phase must
not merge them.

**Resize authority becomes long-lived.** `runtime.rs:743` grants
`resize_authority` to the newest attachment that claims it, and today a hidden
tab detaches and reclaims authority on reveal. After this phase it does not.
Only one `<TerminalView>` exists today (`AppShell.tsx:889`), so no terminal has
two concurrent views and nothing contends — but the coupling is now load
bearing. Record it: if a second concurrent view of one terminal is ever added,
the older attachment loses resize authority permanently and its resize invokes
return `InvalidRequest` forever. That is a constraint to design against, not a
defect to fix here.

## Tasks

1. Split the effect in two:
   - **Attachment effect**, keyed on `terminalId` only. Constructs the phase-04
     controller, attaches, and tears down only on unmount.
   - **Surface effect**, keyed on `visible`. Owns `term.open()` on first
     reveal, the `ResizeObserver`, fit, and viewport resync.
2. Remove `visible` from the attachment effect's dependency list and remove the
   `!visible` early return from it.
3. On reveal, do not reset. Re-fit and re-assert the viewport only —
   `resyncTerminalViewport(term, terminalBottomOffset(term))` already exists at
   `:474` for exactly this.
4. Restore the scroll position across reveal, not just the content. openmux
   re-reads scrollback length and re-clamps the saved viewport offset on
   attach (`replay.ts:78-90`); shipctl currently drops the user to the bottom.
   `pinnedToBottomRef` is the existing hook for this.
5. While hidden, stop driving the `ResizeObserver` → `fitAndResize` path. A
   hidden container reports degenerate dimensions and there is no reason to
   send them to the PTY.
6. Implement the hidden-overflow rule above in the phase-04 controller:
   `recoveryPending`, frame rejection while hidden, one recovery on reveal.
   The controller already owns attachment state; visibility becomes an input
   to it rather than a second authority beside it.

## Acceptance criteria

- Toggling `visible` produces **zero** `attach`, `detach` or `reset` calls.
- Content and scroll position survive a hide/show cycle.
- No resize is sent to the host while a terminal is hidden.
- Sustained output to a hidden terminal produces at most one recovery, and it
  occurs on reveal — asserted as a call count against a fake runtime, not as
  an eyeball check.
- A visible terminal's overflow still recovers immediately, unchanged.
- `terminalCache.ts`'s comment becomes true rather than aspirational.

## Validation

```sh
just check all
just test fast
```

Extend `core/frontend/terminal/tests/terminalAttachment.test.ts` with the
visibility-toggle counters (H6.1) and the hidden-overflow case (H6.3), the
latter asserting the recovery count and its timing rather than its absence.

Manual: run a build with several tabs, put a long-running program in one,
switch away and back repeatedly, confirm no flash, no history loss, and the
scroll position holds.

## Out of scope

Throttling or pausing host-side work for hidden terminals. openmux pauses the
PTY read loop because it is a multiplexer under memory pressure; shipctl has
no measured problem here, and pausing reads changes child-process behaviour.
If a measurement later shows hidden terminals costing real resources, that is
a separate phase with its own evidence.
