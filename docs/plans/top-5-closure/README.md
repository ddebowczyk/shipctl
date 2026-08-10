# Terminal closure

> **Superseded.** This plan selected a *controlled dual parser*: both VT parsers
> retained, with ordered `Resized` and `PaletteChanged` markers making them
> agree. It is preserved unchanged as the audit record of that decision.
>
> The canonical plan is
> [`../top-5-single-vt-closure/README.md`](../top-5-single-vt-closure/README.md),
> which removes the second parser instead of ordering it.
>
> Two pieces of evidence caused the reversal, both absent when this plan was
> signed off: an independent review argued that ordered xterm barriers are a
> mitigation and not a destination
> ([terminal-solution-critique.md](../terminal-solution-critique.md)); and
> neither agent had read the API of the dependency already shipped. The pinned
> `libghostty-vt` exposes cells, styles, graphemes, wide cells, hyperlinks, wrap
> state, cursor, modes, palette, screens, selection, and — the part expected to
> block the migration — key, mouse, and paste encoding. The host-cell escalation
> named below had been priced without that fact, and the price was wrong.
>
> The reasoning is in `docs/plans/chat/`: rounds 1 to 5 produced this plan,
> rounds 6 onward reversed it.

Start with [end-state.md](end-state.md). It carries the architecture decision,
the root cause, the exact recovery boundaries, the live convergence contract,
and the completion contract. This file is the index.

The preparatory set in [`terminal-top-5-changes-sol`](../terminal-top-5-changes-sol/README.md)
makes the terminal capability safe to change. This set is the change.

## The five changes

| # | Change | Closes |
| --- | --- | --- |
| 1 | [Visibility is presentation only](01-visibility-is-presentation-only.md) | tab switching runs recovery |
| 2 | [Resize is an ordered boundary](02-resize-is-an-ordered-boundary.md) | resize rebuilds the terminal |
| 3 | [Theme is an ordered palette change](03-theme-is-an-ordered-palette-change.md) | theme rebuilds the terminal |
| 4 | [Recovery is bounded and history-complete](04-recovery-is-bounded-and-history-complete.md) | recovery is costly and lossy |
| 5 | [Prove convergence, cut over, keep it closed](05-convergence-cutover-and-legacy-removal.md) | the old path survives, and drift returns |

## In one paragraph

Two VT parsers evolve terminal state independently with no single contract for
authority, order, visibility, and recovery, so Shipctl uses host replay plus
`term.reset()` as a general convergence mechanism. That couples routine
presentation changes to terminal reconstruction: resize, theme change, and
hide and show each become reset and replay. These five changes make the two
parsers behave as one ordered system — visibility stops controlling the
attachment, geometry and palette become ordered markers in the stream, recovery
becomes bounded and reserved for the four real boundaries, and the old paths
are removed and gated against return.

## Implementation order

The order is intentional and not a preference.

```text
1 visibility ──> 2 resize ──> 3 theme ──> 4 recovery ──> 5 cutover
```

- Visibility must stop controlling the attachment before hidden resize and
  palette behavior can be made correct.
- Resize introduces the ordered renderer-operation queue.
- Theme reuses that queue with different domain semantics.
- Recovery is finalized only after the routine replay boundaries are gone.
- Cutover removes every superseded path and makes the convergence corpus a
  standing gate.

## Before starting

- The preparatory exit gate in
  [`terminal-top-5-changes-sol/README.md`](../terminal-top-5-changes-sol/README.md)
  must be green, and its two register rows — the persisted scrollback domain
  and the libghostty-vt dependency branch — must be closed with named
  approvers.
- The decision register in [end-state.md](end-state.md) governs this plan. An
  open row blocks cutover.

## Common validation

Each change lists focused validation. The shared repository gates are:

```sh
just check all
just test fast
just test rust
just test full
just modularity boundaries
markdownlint docs/plans/top-5-closure/*.md
git diff --check
```

New frontend terminal suites are registered in `ops/test/justfile` in the same
commit, in the single serial terminal entry the preparatory work consolidates.
Tests that mutate shared terminal caches or runtime singletons run with
`--test-concurrency=1`.
