# Phase 04 — Attachment controller extraction (S1, D3, S2)

## Objective

Move the attachment protocol out of a React effect closure into a testable
unit, and fix the two bookkeeping defects that live in the same area. **No
intended behaviour change.**

## Why this comes before the visibility and reflow work

Today the entire protocol — attach, detach, generation guard, sequence gap
detection, replay install, overflow-triggered reattach, input gating — lives
inside one `useEffect` body in
`core/frontend/terminal/TerminalView.tsx:237-512`. Nothing in it is reachable
from a test. Phases 05, 06 and 07 all change this protocol's behaviour, and
each needs an assertion that would fail before the change. This phase creates
that seam and nothing else.

## Context — what is being extracted

From `TerminalView.tsx`:

- `attachRenderer` (`:373`) — generation counter
  (`attachmentGenerationRef`), previous-attachment detach, re-entrancy guard
  (`reattachingRef`).
- The channel handler (`:392-412`) — the gap check
  `event.sequence !== sequenceRef.current + 1 → requestReattach()`, and the
  `output` / `replay` / `resync_required` / `detached` / `exited` dispatch.
- `installReplay` (`:350-372`) — `unregisterTerminal`, `term.reset()`,
  `term.resize(...)`, `registerTerminal(...)`, then `writeTerminalOutput`.
- `requestReattach` (`:344-349`) — the overflow callback wired into
  `terminalOutputQueue`.

The xterm instance stays where it is (`terminalCache.ts`). The controller
receives a narrow terminal-shaped interface (`reset`, `resize`, plus the
queue's `registerTerminal`/`unregisterTerminal`/`writeTerminalOutput`), so a
test can drive it with a fake.

## Evidence: there is nothing to test against

`ast-grep outline core/frontend/terminal/TerminalView.tsx --view signatures`
returns exactly two items — the `TerminalViewProps` interface and the default
exported component. The file has no named internal symbol, so every protocol
fact (attach/detach counts, generation guards, sequence-gap classification,
reset boundaries) is reachable only by mounting the component. That is the
premise of this phase stated as a measurement rather than an opinion, and it
is why phases 05-09 sequence after it.

## Hypotheses to verify

**H4.1 — extraction is behaviour-preserving.**
Method: characterization tests written against the *current* behaviour first,
run green before the move, and re-run green after. At minimum: a sequence gap
triggers exactly one reattach; a stale-generation event after detach is
ignored; a replay install resets before writing; overflow triggers reattach
once, not per chunk.
Falsifier: any characterization test that cannot be made to pass against the
current code — that is a latent defect, and it is recorded rather than
silently fixed inside a refactor commit.

**H4.2 — the controller needs a readiness fact that is not terminal
lifecycle.** Input must not enter an attachment whose snapshot is installing
or whose stream is recovering. That is transport state, and phase 05 depends
on it existing here.
Method: drive the controller through `installing` and `reattaching` and assert
the readiness predicate is false in both, using no descriptor input at all.
Falsifier: readiness is derivable from the descriptor alone, meaning there is
only one fact and phase 05's split is unnecessary.

## Tasks

1. Write the H4.1 characterization tests against current code. Green first.
2. Create `core/frontend/terminal/terminalAttachment.ts` exporting a
   controller with an explicit state machine — `detached → attaching →
   replaying → live`, plus `resyncing` — and no React dependency.
3. Move the protocol logic in, unchanged. `TerminalView.tsx` keeps only:
   create/own the DOM surface, construct the controller, dispose it.
4. Expose a read-only transport-readiness predicate derived only from
   controller state. Do **not** yet rewire input to it — `inputEnabledRef`
   stays exactly as it is until phase 05. Adding the predicate is additive;
   changing who reads it is a behaviour change and belongs in its own phase.
5. Make one reducer the only writer of controller state, so an impossible
   transition is rejected in a test rather than tolerated in a closure.
6. Buffer live frames received while `installing` and release them, in order,
   only after the replay install completes and only above the boundary
   sequence. This is current behaviour made explicit, not new behaviour.

## Acceptance criteria

- `TerminalView.tsx` contains no attach, detach, sequence, or replay logic.
- The controller is constructible in a test with no DOM and no Tauri.
- Exactly one attachment is live per generation, and a stale async completion
  can reach no renderer callback.
- The characterization tests from step 1 pass unchanged before and after the
  move. If any assertion had to be edited to make the refactor pass, the
  refactor changed behaviour and must be reworked — that is the whole test of
  this phase.
- `git diff` shows no change to `close()`, to `inputEnabledRef`'s readers, or
  to any resize, theme or visibility path.

## Validation

```sh
just check all
just test fast
```

New test file: `core/frontend/terminal/tests/terminalAttachment.test.ts`,
registered in `ops/test/justfile` in the same commit (the modularity gate in
`just test full` checks recipe drift).

## Out of scope

Everything that changes behaviour. D3 and S2 were originally folded into this
phase; they are now phase 05, because a refactor whose contract is "no
behaviour change" cannot also carry two behaviour changes — the
characterization suite could no longer distinguish an extraction bug from an
intended fix. Also out of scope: when the controller attaches or detaches
(phase 06), and what the host sends it (phases 07-09).
