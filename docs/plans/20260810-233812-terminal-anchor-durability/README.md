# Terminal anchor durability and history bounds

## Mission

Make the host's answers about retained history and anchored lines true in every
case the pinned parser can produce, and say so at the boundary where the answer
is wrong rather than leaving a client to discover it.

Two defects were found while building history windows and anchors for area 01
of `docs/plans/top-5-end-state/`. Both come from the pinned `libghostty-vt`
revision `72ac98f`. Neither is a reason to stop; both need the host to state
what it knows.

## The two defects

**A. A history coordinate does not stop at the end of history.** `Point::History`
is documented as "Scrollback history only (before active area)". Both
`Terminal::grid_ref` and `Terminal::track_grid_ref` count the row from the
oldest retained row across history *and* the active area, and refuse only a
point past the total. A history read or a history anchor therefore reaches live
rows and labels them history.

**B. A line lost with no history to hold it is not reported.** When a page is
freed, eviction is reported correctly: the tracked reference loses its value and
every coordinate answers `None`. When a terminal retains no history, a line that
scrolls off is destroyed without a page ever holding it. The tracked reference
stays on the active row, so it names the line that replaced the anchored one and
still calls itself retained.

Defect B's scope is exactly "a row left the active area and history could not
take it". An anchor already in history is safe, and so is an anchor on a
terminal whose history holds rows.

## Contract

1. No history read and no history anchor names a row in the active area.
2. An anchor whose loss the parser cannot report says so, in the value a client
   receives, for as long as that is true.
3. The two defects stay recorded as executable evidence, so a parser revision
   that fixes either one fails a test rather than passing silently.
4. Nothing in the host depends on which parser revision is pinned to be correct.

## What is already proven

Delivered while the defects were found, and kept:

- `project_history` clamps its window to `scrollback_rows()` and reports
  `history_rows`, so a window cannot contain a live row.
  Evidence: `a_history_window_reports_what_history_holds`, which reads one row
  past the end through the unclamped reader and shows it is the first active
  row.
- `VtReplayEngine::anchor` refuses a history row at or past `scrollback_rows()`.
  Evidence: `a_history_anchor_past_the_end_of_history_is_refused`.
- Real eviction is reported. Evidence:
  `an_evicted_anchor_says_so_instead_of_naming_another_line`.
- Defect B is recorded. Evidence:
  `with_no_history_a_scrolled_off_anchor_names_the_line_that_replaced_it`.
- Grid reads and render reads agree on the same rows, so history rows are the
  same kind of fact as viewport rows. Evidence:
  `render_and_grid_reads_agree_on_the_same_rows`.

Contract items 1 and 3 are met. Item 2 is the work in `01`.

## The work

- `01-host-loss-reporting.md` — the anchor states whether its loss would be
  reported. Executed in this repository; all six acceptance items met, 109
  terminal tests pass, workspace tests pass, `cargo fmt --all --check` clean,
  no new clippy warning.
- `02-upstream-parser-corrections.md` — the two changes that remove the defects
  at their source. Recorded, not executed: the dependency is pinned and is not
  edited from here.

## How to validate

```sh
cargo test -p shipctl-core --lib terminal::
cargo fmt --all --check
cargo clippy -p shipctl-core --all-targets
```

## What this plan does not do

It adds no control-protocol or CLI surface for history and anchors. Area 02 of
`docs/plans/top-5-end-state/` owns how these types cross a client boundary, and
a one-off shape built here would be replaced by it.
