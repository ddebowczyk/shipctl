# 01 — The anchor states whether its loss would be reported

## The gap

`TerminalAnchor::retained` answers "the parser still has a value for this pin".
On a terminal that retains history, that answer is trustworthy: pages are freed,
the pin loses its value, and every coordinate answers `None`. On a terminal that
retains no history, the answer is wrong in a way no client can detect, because
the pin keeps naming a live row after the anchored line is destroyed.

A client cannot compute the difference. The host can, and must, because the host
owns the retention policy.

## The fix: declare it, do not detect it

Add one fact to `TerminalAnchor`:

```
loss_reported: bool   // serialized as lossReported
```

`true` means "if this anchor's line goes away, this anchor will say so".
`false` means "the parser cannot prove this anchor's line still exists".

It is computed from what the engine already holds:

- the terminal retains history *now* — `scrollback_rows() > 0`, or history has
  been non-empty at any earlier point in this terminal's life.

One flag, `history_ever_retained`, is set inside `feed()` while it is still
false. Nothing else changes. The "ever" part matters because history can return
to zero after eviction on a small budget; that terminal still evicts by page and
still reports loss.

Reading the budget alone is not enough. Retention is page-granular, so a nonzero
budget below the page floor at a given geometry retains no rows. Observing
history is the only statement that holds for every budget and geometry.

## Rejected alternatives

- **Content fingerprinting** — hash the anchored line and compare on resolve.
  It cannot separate "the pin was clamped onto another line" from "the child
  rewrote this line in place". It turns a fact into a guess.
- **A witness pin** — anchor a neighbouring row and infer loss from divergence.
  Same class of error, with more state: a heuristic dressed as a fact.

Both trade a known-conservative answer for an unknown-wrong one.

## The conservative window

A terminal with a good budget that has not yet scrolled a row into history
reports `loss_reported: false`, because no row has ever been retained. That is
correct at the time it is said: nothing yet proves this terminal will retain
anything. It self-corrects the moment the first row scrolls off, and the value
is read fresh on every `anchor` and `resolve_anchor` call. A zero-retention
terminal reports `false` forever, which is the case the fact exists for.

## Acceptance

1. `TerminalAnchor` carries `loss_reported`, serialized `lossReported`, and
   round-trips as JSON with no dependency type at the boundary.
2. On a zero-retention terminal, `loss_reported` is `false` before and after a
   line scrolls off, and stays `false`. The anchor that names a replacement line
   is the same anchor that says its loss is not reported.
3. On a terminal with the default budget, an anchor minted after a row has
   scrolled into history reports `loss_reported: true`, and eviction of that
   anchor still reports `retained: false` with every coordinate `None`.
4. On a fresh terminal with the default budget, an anchor minted before any
   scroll reports `false`, and the same anchor resolved after the first row
   scrolls into history reports `true`.
5. The fact is available through the actor and the service, not only on the
   engine.
6. `cargo test -p shipctl-core --lib terminal::` passes; `cargo fmt --all
   --check` and `cargo clippy -p shipctl-core --all-targets` are clean.

## Consequence for area 03

An anchor is either durable or volatile. Selection and marks built over a
volatile anchor are live-screen only, and area 03 must not persist them across a
scroll. This is a design input for
`docs/plans/top-5-end-state/03-client-model.md`, not extra work here.
