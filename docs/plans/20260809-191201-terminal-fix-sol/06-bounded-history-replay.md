# Phase 06 — Make recovery replay bounded and history-complete

## Outcome

Initial attach and recovery reconstruct the newest complete history suffix that
the host intentionally retained, plus the exact active-screen state. Retention
units and snapshot truncation are explicit; neither depends on a misleading
constant name or an unbounded channel message.

## Context

Daily history continuity is fixed by Phases 03 and 04, because hide/show,
resize, and theme no longer reset xterm. Recovery still needs a host snapshot
when xterm is new or untrusted. Phase 01 determines two facts that this phase
must branch on:

1. whether Shipctl's current `Formatter` already emits retained rows; and
2. the measured byte safety cap for the frozen row-plus-byte retention policy.

Do not implement a cell-by-cell formatter if the pinned formatter already emits
history. Do not claim a row guarantee from Ghostty's byte-valued
`max_scrollback` option.

## Recovery contract

A `Snapshot` frame at sequence `N` contains:

- canonical columns and rows;
- descriptor revision and terminal incarnation;
- retained-row count, host-eviction cause, and snapshot-truncation flag;
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

## Tasks

1. Replace `MAX_SCROLLBACK_LINES` with the measured byte-valued safety setting
   selected in Phase 01. Keep its byte unit visible in source and diagnostics.
2. Extend the pinned Ghostty binding with explicit complete-row trimming and
   reassert both limits after resize, following openmux's tested row-trim
   pattern without copying its unlimited byte budget. Expose retention stats
   that distinguish explicit row trimming from native byte-budget eviction.
3. Pass `TerminalSettings.scrollback` through terminal launch/update commands.
   Trim immediately on a live reduction. Apply increases to future output and
   report that already evicted rows cannot be restored.
4. Add retention tests for narrow/wide geometry, resize reflow, ASCII,
   wide-Unicode, combining graphemes, styled cells, hyperlinks, blank rows,
   primary/alternate transitions, and content written with no view attached.
5. Use the Phase 01 formatter result:
   - if retained rows are already emitted, add bounded selection around that
     implementation; or
   - if not, extend the pinned binding to expose/format history and port the
     bounded-selection approach proven by cmux.
6. Select the newest complete history rows that fit the snapshot budget. Never
   start in the middle of a wrapped logical row or UTF-8/control sequence, and
   always include the complete active grid and restoration state.
7. Derive the snapshot byte budget from Phase 01 retention measurements,
   Phase 05 raw-channel throughput/allocation data, and the subscriber queue
   policy. Record the formula and supported-geometry proof; do not insert an
   unexplained constant.
8. Encode `retained_rows`, `host_eviction` (`none`, `row_limit`, or
   `byte_limit`), and `snapshot_truncated` in the `Snapshot` payload. A snapshot
   containing only the active grid because retained rows did not fit must
   report snapshot truncation; it is never a silent fallback.
9. Separate theme-owned defaults from terminal-authored semantic colors. Extend
   the pinned binding only as narrowly as necessary to replay application
   overrides without serializing the old app theme as terminal content.
10. Add controller tests that hold live frames during snapshot installation,
   drop duplicates at/before `N`, accept `N+1`, and reattach on a gap.
11. Add backend/frontend equivalence fixtures for initial attach, renderer
    replacement, explicit gap, subscriber overflow, host output while detached,
    and recovery after multiple resize/theme changes.
12. When even the supported visible grid cannot fit the derived bound, return a
    typed attachment error with measured diagnostics. Do not emit a partial or
    malformed replay.

## Acceptance criteria

- The source and docs name both retention units. Explicit row trimming enforces
  the product cap; Ghostty's measured byte cap independently enforces memory
  safety and may retain fewer rows.
- A new renderer recovers all rows selected by the bounded host snapshot,
  including output produced while no renderer was attached.
- The selected history is a newest complete suffix. `host_eviction` identifies
  which retention bound discarded older rows; `snapshot_truncated` is true only
  when the host retained additional rows that this snapshot omitted.
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
pnpm exec node --test \
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
an equivalence fixture. If the pinned binding cannot expose complete history,
patch and pin that narrow capability before considering a renderer rewrite.
