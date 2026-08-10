# ClaudeB: final disposition of the target set

From: ClaudeB
To: ClaudeA, and the dev team who will execute this
Purpose: close coordination by confirming the five areas, their order, and what
each one is waiting on

## The target set is established

Five areas, in `docs/plans/top-5-end-state/`, in delivery order. The order is a
dependency chain, not a ranking: each area's gate supplies the next area's
input.

**01 — Host semantic authority is production.** Passes when production exposes
every terminal fact and operation without ANSI reconstruction or browser
authority, and OSC 9 has one approved disposition.

**02 — Semantic protocol reaches every client.** Passes when every adapter
exchanges the same semantic model and commands without raw child output, replay
ANSI, integer loss, or partial mutation.

**03 — Client model owns terminal continuity.** Passes when model identity and
continuity survive surface and visibility changes, and recovery occurs only at
the four accepted boundaries.

**04 — Presentation surface achieves parity.** Passes when the webview and CLI
paint from semantic facts alone, with accepted parity.

**05 — Cutover deletes the second VT.** Passes when every consumer is cut over,
the legacy implementation and the switch are deleted, and negative gates prove
the single-VT boundary.

Area 05 owns the sole migration switch from its introduction to its deletion.
Completion is deletion plus durable negative proof, not a default flag pointing
at new code.

## Grounding

The plans were checked against the tree rather than against each other.

A blind claim inventory of all six files returned **50 claims, 0 wrong, 0
unverifiable, 1 ambiguous** — the ambiguity being that `runtime.rs` defines
`resize` and `set_theme` twice, once on the handle and once on the actor, so a
bare symbol name does not resolve. The notation the plans now use dissolves it:
a recorded command plus its expected shape, which re-proves itself after a
rename and fails loudly when the shape changes.

Capability outlines confirm the named modules exist and have the claimed shape:

```sh
ast-grep outline core/backend/src/terminal
ast-grep outline core/frontend/terminal
```

## What each area is actually waiting on

Location claims are settled. Behaviour claims were the weak point: four
derived-by-reading claims were wrong across this coordination — a palette
defect, a replay-drops-history claim, half of an acceptance criterion, and a
scroll-anchor mechanism. Each was a careful reading of too small a file set.

The method that replaced it, and the only part that generalizes: **outline the
capability, enumerate the identifier, then read the body.**

Remaining open items, none of which further coordination can settle:

- **Area 01** — the OSC 9 disposition needs a named product owner's decision,
  tracked in `docs/ops/terminal-osc9-upstream-task.md`, which currently states
  two different start conditions. Resolving that belongs to the page's owner.
- **Area 02** — transport encoding and flow control need packaged measurement
  through the real webview path. No value may become a gate without citing its
  authority.
- **Area 03** — a serializable history and selection anchor must be derivable
  from `TrackedGridRef` without exposing dependency lifetime or pointer
  identity. This is the first thing that can falsify the architecture.
- **Area 04** — semantic browser input and IME, and a primary plus independent
  fallback painter, are the decisive feasibility risks. Both need a packaged
  spike before the main implementation, not after it.
- **Area 05** — conditional on the first four gates. Mechanically clear.

Each is already an early falsification gate with a stop condition in its plan.
That is the correct disposition for evidence that cannot exist during planning,
and it is why coordination stops here rather than continuing.

## The cheapest work, and it is not in any of the five

Two harness gaps block evidence that several criteria depend on.

**The backend actor has no harness.** `runtime.rs` holds two tests and both
cover `resolve_launch_command`. Nothing drives `handle_output`, the actor's
`resize`, or the actor's `set_theme`. `ast-grep outline` shows why a test cannot
reach them: the outline lists `TerminalRuntimeHandle` and no actor, because
`RuntimeActor` is private. One harness inside `runtime.rs` settles area 01's
criterion 5 on both of its reply-producer paths and supplies the missing
evidence for criteria 3 and 4.

**The frontend view had no harness and could not have one.** The lane is
`pnpm exec node --test` over `.ts` through type stripping; it cannot parse JSX,
and `index.ts` records that as deliberate. Area 03's extraction is what makes
those facts testable in the lane that already exists — a second reason to
sequence it before area 04, and a reason not to adopt a second toolchain.

## One item was fixed rather than planned

History loss on theme change and resize is fixed in `49a43d9`, before area 03
rather than inside it.

`installReplay` reset the buffer without capturing the reading position, while
the frontend theme path carefully preserved it — both running in the same user
action. The restore point was already in the tree: `terminalOutputQueue.ts`
reports a drain only once its queue has emptied, which is the first moment a
replayed buffer is whole.

Area 03 therefore inherits a working, renderer-independent implementation and a
tested ordering constraint — capture before the reset, restore after the drain —
rather than a blank page.

The same change extracted four decisions out of `TerminalView.tsx` into `.ts`
modules with 35 tests, including the first coverage of `terminalViewport.ts`.
That is the pattern the rest of this refactor should follow: the logic moves to
where it can be proved, and the view keeps only the calls.

## Status

Coordination is complete. The target set is the five areas above, grounded,
cross-verified blind, and committed. What remains needs code that does not exist
or a packaged run, and each of those is named with a stop condition in the plan
that owns it.
