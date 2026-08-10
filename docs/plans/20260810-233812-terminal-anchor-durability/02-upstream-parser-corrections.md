# 02 — Upstream parser corrections

Recorded, not executed. The dependency is a pinned git checkout under
`~/.cargo/git/checkouts/`, which is not edited from this repository.

Pinned revision: `libghostty-vt` at `72ac98f292879bf9f788fcbb11238c562a1eebe6`.

## A. Bound `Point::History` at the end of history

**Observed.** `Terminal::grid_ref(Point::History { x, y })` and
`Terminal::track_grid_ref(..)` count `y` from the oldest retained row across
history *and* the active area. Row `scrollback_rows()` resolves to the first
active row instead of failing; only a point past the combined extent is refused
(`InvalidValue`).

**Documented meaning.** "Scrollback history only (before active area)."

**Proposed change.** In the Rust wrapper, refuse a `Point::History` whose row is
at or past the retained history row count, for both the read and the tracking
entry point. The rest of the coordinate spaces keep their current behaviour.

**Effect here.** None on correctness: `project_history` clamps and
`VtReplayEngine::anchor` refuses. The host guards stay after any upstream fix,
because the host must not depend on which revision is pinned. The host test
`a_history_window_reports_what_history_holds` asserts the overrun exists, so it
fails when the upstream fix lands — which is the intent: the fix is noticed, not
absorbed silently.

## B. Invalidate a pin whose row is destroyed without page eviction

**Observed.** A tracked reference loses its value when the page holding its row
is freed. When a terminal retains no history, a row that leaves the active area
is destroyed without any page being freed. The pin keeps a value, reports
`retained: true`, and resolves to the row that took the anchored row's place.

**Proposed change.** A pin whose row is destroyed loses its value, whatever the
reason the row went away — page eviction or destruction with no history to move
into.

**Effect here.** `01` states the limitation at the boundary rather than hiding
it. The host test
`with_no_history_a_scrolled_off_anchor_names_the_line_that_replaced_it` records
the current behaviour and fails when the upstream fix lands. At that point
`loss_reported` becomes `true` for every terminal, and the field can be retired
by the owner of the anchor protocol in area 02.

## How to report these

Both are reproducible with the host tests named above. Neither has been filed
upstream; filing is not part of this plan's contract, and the owner decides
whether the report goes to `libghostty-rs` (A, a wrapper-level bound) or to the
Zig core (B, pin lifetime).
