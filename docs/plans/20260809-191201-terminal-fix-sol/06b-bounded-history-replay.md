# Phase 06B — Make recovery snapshots bounded and history-complete

## Outcome

Initial attach and recovery reconstruct the newest complete history suffix that
the host retained in Phase 06A, plus the exact active-screen state. Snapshot
selection and loss metadata are explicit; this phase does not own physical host
retention or depend on a misleading constant name.

## Context

Daily history continuity is fixed by Phases 03 and 04, because hide/show,
resize, and theme no longer reset xterm. Phase 06A independently fixes backend
retention. Recovery still needs a bounded host snapshot when xterm is new or
untrusted. Phase 01 determines two facts that this phase must branch on:

1. whether Shipctl's current `Formatter` already emits retained rows; and
2. the measured formatter expansion used to derive a safe snapshot budget.

Do not implement a cell-by-cell formatter if the pinned formatter already emits
history. Do not claim a row guarantee from Ghostty's byte-valued
`max_scrollback` option, and do not reopen Phase 06A's fork/no-fork decision.

The pinned Rust wrapper already exposes `Terminal::total_rows`,
`Terminal::scrollback_rows`, `Point::Screen`/`Point::History`,
`Selection::new`, and `FormatterOptions::with_selection`. Herdr demonstrates
the same C surface for bounded retained-row reads and VT formatting. Therefore
history extraction starts with the existing public API; a dependency patch is
allowed only for a capability the Phase 01 fixtures prove missing, such as
non-mutating access to inactive primary history while alternate screen is
active.

## Recovery contract

A `Snapshot` frame at sequence `N` contains:

- canonical columns and rows;
- descriptor revision and terminal incarnation;
- retained-row count, delivered-history-row count, physical `host_eviction`,
  and `snapshot_omission` cause;
- newest complete primary-screen history rows selected for this snapshot;
- the complete active primary or alternate screen;
- cursor position/shape/visibility, wrap state, modes, tabs, hyperlinks, and
  current semantic palette plus supported application overrides; and
- no theme-default palette values that would prevent a later theme repaint.

The controller resets the fresh/untrusted xterm, applies canonical geometry,
writes the snapshot, waits for the write callback, then releases live frames
strictly after `N`.

## Hypotheses to verify

### H6.1 — Complete history formatting

The Phase 01-selected retained history can be formatted on complete row
boundaries with exact active state. Compare a fresh parser/xterm with the host
over the VT corpus. Falsifier: extraction drops cells/styles or active state.

### H6.2 — Visible grid always fits

A bounded newest-row selection always includes the complete supported visible
grid. Generate maximum supported geometry and worst measured formatter
expansion. Falsifier: the derived bound cannot encode a valid visible terminal.

### H6.3 — Theme-portable snapshots

Omitting theme defaults while preserving app overrides makes snapshots portable
across themes. Set OSC overrides, change theme, recover, and compare semantic
colors. Falsifier: recovery loses overrides or freezes old defaults.

### H6.4 — Snapshot/live equivalence

Snapshot `N` plus live frames `N+1...M` equals a fresh host snapshot at `M`.
Inject output, resize, theme, and metadata around the boundary. Falsifier: any
supported final state differs.

### H6.5 — Background first reveal

A never-attached terminal that emits beyond a retention or snapshot bound
reports the missing pre-reveal history on its first snapshot. Falsifier: first
reveal silently shows a shorter suffix or attributes host byte eviction to
snapshot selection.

## Tasks

1. Consume Phase 06A's retained-row view and `TerminalRetentionStats`; do not
   add another byte/row limiter or mutate host retention in snapshot code.
2. Use the Phase 01 formatter result:
   - if retained rows are already emitted, add bounded selection around that
     implementation; or
   - if not, build the history prefix with explicit `Point::History` endpoint
     refs, `Selection::new`, and `FormatterOptions::with_selection`, then append
     the existing active-state formatter output.
   Patch the dependency only if a checked-in primary/alternate-screen fixture
   proves that this public surface cannot read required retained state. Keep any
   such patch read-only and separate from Phase 06A's optional trim fork.
   Define the install stream explicitly: write selected history so it scrolls
   into xterm history, clear only the active grid without erasing scrollback,
   install the complete active-state replay, restore cursor/wrap state, then
   release `N+1`. Prove the seam neither duplicates the bottom rows nor turns
   hard line endings into soft wraps.
3. Select the newest complete history rows that fit both the product row policy
   and snapshot byte budget. Never start in the middle of a wrapped logical row
   or UTF-8/control sequence, and always include the complete active grid and
   restoration state.
4. Derive the snapshot byte budget from Phase 01 formatter measurements,
   Phase 05 raw-channel throughput/allocation data, and the subscriber queue
   policy. Record the formula and supported-geometry proof; do not insert an
   unexplained constant.
5. Encode `retained_rows`, `delivered_history_rows`, `host_eviction` (`none`,
   `byte_limit`, or fork-only `row_limit`), and `snapshot_omission` (`none`,
   `row_limit`, or `byte_budget`) in `Snapshot`. Derive user-facing
   `history_truncated` when either cause is non-`none`. A snapshot containing
   only the active grid must report why; host eviction is never mislabeled as
   transport/snapshot truncation.
6. Separate theme-owned defaults from terminal-authored semantic colors. Extend
   the pinned binding only as narrowly as necessary to replay application
   overrides without serializing the old app theme as terminal content.
7. Add controller tests that hold live frames during snapshot installation,
   drop duplicates at/before `N`, accept `N+1`, and reattach on a gap.
8. Add backend/frontend equivalence fixtures for initial attach, renderer
   replacement, explicit gap, subscriber overflow, host output while detached,
   and recovery after multiple resize/theme changes.
9. Add the Phase 03 background fixture: create without attaching, emit beyond
   the byte, row, and snapshot budgets, then reveal once. Verify restored rows
   and each independent loss cause.
10. When even the supported visible grid cannot fit the derived bound, return a
   typed attachment error with measured diagnostics. Do not emit a partial or
   malformed replay.

## Acceptance criteria

- Snapshot code consumes Phase 06A retention policy without being responsible
  for Ghostty cap mutation or fork selection.
- A new renderer recovers all rows selected by the bounded host snapshot,
  including output produced while no renderer was attached.
- The selected history is a newest complete suffix. `host_eviction` identifies
  physical host loss; `snapshot_omission` identifies retained rows excluded by
  row or byte selection. `history_truncated` reports either cause without
  conflating them.
- A background terminal's first reveal reconstructs all selected pre-reveal
  output and surfaces `history_truncated` plus exact causes when older output is
  unavailable.
- The visible grid, alternate-screen state, cursor, wrap state, modes, tabs,
  links, supported colors, and Unicode cells match the host after install.
- Theme-owned colors adopt the current app theme after recovery; application
  palette/RGB overrides remain application-owned.
- Snapshot `N` plus all subsequent live frames is equivalent to a fresh
  snapshot at the final sequence across the extended VT corpus.
- Gap and overflow recovery perform one reset/snapshot install and return to
  live delivery without losing or duplicating post-boundary output.
- No replay byte array crosses JSON, and no recovery path silently degrades to
  active-screen-only content.

## Validation

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::replay
cargo test --manifest-path core/backend/Cargo.toml terminal::runtime
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalProtocol.test.ts
./research/20260809-124553-fut-tty/vt-proof/run.sh
just test fast
just test rust
just check all
git diff --check
```

## Exit condition

Do not remove the legacy replay formatter until every supported state above has
an equivalence fixture. If the pinned public range/selection API cannot expose
complete history in a supported screen state, patch and pin only that proven
history-read gap before considering a renderer rewrite. This does not authorize
or require Phase 06A's physical-row-trim fork.
