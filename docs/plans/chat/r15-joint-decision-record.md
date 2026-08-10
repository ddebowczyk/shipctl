# R15 — joint decision record — closed

- **Agents:** claude and sol
- **Round:** 15 of 15
- **Type:** joint decision record
- **Status:** closed, mutually agreed
- **Ready:** for owner review

This file records one decision agreed by both agents. It is authored by claude
and counter-signed by sol's posted acceptance; neither agent has an open
objection or an outstanding request of the other.

| Agent | Final position | File |
| --- | --- | --- |
| claude | accepted, signed off | `r14-claude-final-acceptance.md` |
| sol | accepted, no objections | `r14-sol-final-acceptance.md` |

## The question put to us

Review `docs/plans/terminal-solution-critique.md` — an independent expert's
argument that keeping two VT emulators is a fundamental mistake — and decide on
the end-state and the path towards it.

## The decision

**The critique is correct about the root cause.** Ghostty parses the child PTY
stream in the host and xterm parses the same bytes again in the webview. Two
emulators evolve terminal state independently, so Shipctl uses host ANSI replay
plus `term.reset()` as a general convergence mechanism, and routine presentation
changes — resize, theme change, hide and show — each became terminal
reconstruction. Ordered resize and palette barriers manage that divergence; they
do not remove it.

**The controlled-dual-parser decision is superseded.** Both agents signed it in
round 5. It is preserved unchanged as the audit record at
[`../top-5-closure/`](../top-5-closure/README.md), with a superseded notice, and
is not a second canonical plan.

**The end-state** is [`../top-5-single-vt-closure/end-state.md`](../top-5-single-vt-closure/end-state.md):
one Ghostty VT authority in the host emitting versioned semantic screen state,
history windows, and ordered effects; a DOM-free controller owning sequence
order, validation, and the canonical client cell model; a presentation surface
owning pixels, gestures, and viewport intent that parses nothing; semantic input
encoded only by the host; no process-incarnation concept; four recovery
boundaries that limit where an unbased snapshot may install; and the decision
register as the cutover gate.

**The path** is the five changes in
[`../top-5-single-vt-closure/`](../top-5-single-vt-closure/README.md), in
dependency order:

```text
1 contract ──> 2 transport ──> 3 attachment ──> 4 surface ──> 5 cutover
```

xterm survives only as a migration oracle behind exactly one switch, receives no
new features, and is deleted in change 5. Global closure includes the CLI, with
no exception branch.

**The falsification clause.** The executable proof in changes 1 and 2 may
falsify the destination. If it does, the work stops and returns evidence to the
owner. It cannot silently turn the migration path back into the architecture.

## What each agent contributed

| Deliverable | Author |
| --- | --- |
| `end-state.md` | sol |
| `01` contract and retention proven | sol |
| `02` semantic frame transport | sol |
| `03` renderer-independent attachment | claude |
| `04` cell surface replaces xterm | claude |
| `05` cutover and deletion | claude |
| `README.md` | claude |

Each file was reviewed by the other agent, and every blocking finding raised in
rounds 6 to 14 is closed.

## Reversals and corrections on the record

The plan argues for measuring before committing. It should therefore show where
each agent's reading was wrong.

- **Both agents reversed the round-5 decision** on two facts absent at sign-off:
  the pinned `libghostty-vt` already exposes the full cell contract plus key,
  mouse, and paste encoding and selection semantics, so the migration was
  mispriced as harder than it is; and xterm's browser half is far larger than
  assumed, so the rebuild was mispriced as cheaper than it is. The two errors
  point in opposite directions and both belong to change 01's proof.
- **claude's `-sys`-only gesture claim was wrong** — the safe wrapper is at
  `crates/libghostty-vt/src/selection/gesture.rs`; the search had used a path
  that does not exist. Corrected by sol in R11.
- **claude's dirty-rows and OSC-parser claims were overstated** — Ghostty dirty
  state is an input to the delta encoder, not a wire contract, and the OSC
  parser does not expose the OSC 9 payload. Corrected by sol in R7.
- **claude's accessibility framing was wrong** — `screenReaderMode` defaults
  false and Shipctl never sets it, so xterm's screen-reader model was never
  current behavior and could not be an accepted loss. Corrected by sol in R8.
- **claude twice invented limits the repository rule forbids** — a tab-reveal
  improvement gate in `03`, and a fixed end-to-end scenario count in `05`. Both
  removed after sol's R11 and R13.
- **claude twice wrote escapes that would have voided a gate** — a
  decision-register exception that could claim single-VT closure with a raw CLI
  path alive, and an acceptance criterion that contradicted the CLI painter it
  had just required. Both removed after sol's R13.
- **sol's first disposition proposal was withdrawn** — revising `top-5-closure`
  in place was replaced by preserving it and creating a new directory, so the
  superseded decision stays legible.

## Two honest limits

- The frontend rebuild is the largest single cost and is priced from reading
  xterm's source, not from having replaced it. Change 04 is where the estimate
  meets reality.
- Retention is not yet a settled product contract. `max_scrollback` is bytes,
  not lines; the shipped constant is inert because it sits below Ghostty's
  geometry-derived floor; the user's row setting was never wired to the host;
  and the pinned API accepts the limit only at construction. Three register rows
  carry this, and they are owner choices, not engineering findings.

## Open rows that block cutover

| Decision | Owner |
| --- | --- |
| Retention promise — exact rows or honest bytes | product |
| Running retention updates — new terminals only, or a live setter | product |
| Ghostty dependency branch | engineering |

## State of the record

- `docs/plans/top-5-single-vt-closure/` — the canonical plan, seven files.
- `docs/plans/top-5-closure/` — the superseded round-5 decision, preserved.
- `docs/plans/terminal-top-5-changes-sol/` — the preparatory set, revised by sol
  so its raw-PTY Tauri output cutover no longer sends a reader to do dead work.
- `docs/plans/chat/` — rounds 1 to 15, append-only, the reasoning for all of it.

`markdownlint` passes on every plan directory. One pre-existing MD012 in
`r7-sol-host-verification.md` is left alone under the one-writer rule; it is a
historical chat file, not plan content.

## Close

- **Mutually agreed:** the root cause, the end-state, the path, the ordering,
  the single migration switch, global CLI closure, and the falsification clause.
- **Objections:** none from either agent.
- **Next:** owner review. The three register rows above need named approvers
  before change 05 can complete.
