# Phase 06A — Implement host retention without transport coupling

## Outcome

The backend enforces a measured Ghostty byte-safety cap immediately after
Phase 01 and applies the approved product row policy without waiting for the
binary codec. Physical retention and later snapshot selection remain distinct.

## Context

The pinned libghostty-vt-sys build clones Ghostty at a fixed commit and builds
it with Zig. Its public C API sets `max_scrollback` only at construction and
exposes reset and compression, not complete-row trimming. Compression does not
change logical history or its configured limit.

Exact host row trimming therefore is not a small binding wrapper change. It
requires a Ghostty Zig/C API fork, a libghostty-rs fork that pins it, and ongoing
compatibility and release ownership. The build already carries Zig; maintaining
the two forks is the incremental cost.

Phase 01 selects one branch:

- **Fork:** physically enforce the product row limit and byte cap in Ghostty.
- **No fork:** always enforce the native byte cap; enforce product rows in
  xterm and recovery-snapshot selection. Ghostty may retain extra rows within
  the byte cap, and a live row reduction does not physically erase them.

No fork is the progress-preserving default unless the owner records that
privacy or data-erasure semantics require physical live row removal.

## Hypotheses to verify

### H6A.1 — Byte-cap stability

The measured Ghostty byte cap remains effective through output, compression,
and narrow/wide reflow. Falsifier: observed native allocation or retained pages
cross the Phase 01 bound without a typed failure.

### H6A.2 — Fork capability

If the fork branch is selected, one narrow C API can trim only complete oldest
rows, preserve active/alternate state, and reassert the policy after resize.
Falsifier: exact trimming corrupts row boundaries or requires a broader
terminal-model fork than the owner approved.

### H6A.3 — No-fork honesty

If the no-fork branch is selected, all user-visible history and future snapshot
selection honor `TerminalSettings.scrollback`, while diagnostics never claim
that extra host rows were physically erased. Falsifier: an over-limit row is
displayed/replayed or reported as physically evicted when it remains in memory.

## Tasks

1. Rename the misleading backend constant and fields so Ghostty's construction
   option is visibly byte-valued. Apply the measured Phase 01 cap to every new
   terminal and reject invalid persisted settings before construction.
2. Add backend retention fixtures for ASCII, wide Unicode, combining cells,
   wraps, styles, hyperlinks, blank rows, primary/alternate transitions,
   narrow/wide resize, and sustained output with no renderer attached.
3. Add an internal `TerminalRetentionStats` observation containing retained
   rows/pages/bytes and physical `host_eviction` cause. Keep it independent of
   the Phase 05 wire codec; Phase 06B serializes only the supported subset.
4. Propagate `TerminalSettings.scrollback` to terminal creation and live
   updates. In both branches, xterm and future snapshot selection adopt a
   decrease immediately and an increase only affects future output.
5. For the fork branch:
   - add the narrow complete-row trim operation in a pinned Ghostty fork;
   - pin a libghostty-rs fork that exposes it without leaking Zig types;
   - trim after output and reflow at deterministic points;
   - preserve the independent byte cap; and
   - document fork update, compatibility-test, and CI ownership.
6. For the no-fork branch, add no fake host trim. Retain extra rows only within
   the byte cap and ensure every user-facing row projection applies the product
   row limit. Record that a live reduction is not physical erasure.
7. Define eviction accounting once: `byte_limit` means Ghostty discarded
   history; `row_limit` is legal only in the fork branch; `none` makes no claim
   about rows that a later bounded snapshot may omit.
8. Register focused backend tests in `ops/test/justfile` and capture memory,
   retained-row, and resize results for the selected branch.

## Acceptance criteria

- The backend's byte cap has a measured value, byte-named source symbols, and
  fixtures proving it remains effective through output and resize.
- The committed owner decision identifies fork maintenance ownership or
  explicitly accepts no-fork physical retention semantics.
- Phase 06A completes without depending on H5.1/H5.2 or the raw codec.
- In the fork branch, complete-row trimming enforces the product limit without
  corrupting active state, and CI builds both pinned forks reproducibly.
- In the no-fork branch, user-visible rows honor the product limit, extra host
  retention never crosses the byte cap, and diagnostics disclose that a row
  reduction was not physical erasure.
- Output produced before any renderer attaches is retained or evicted according
  to the selected branch and byte bound; it is never silently discarded by
  frontend visibility state.

## Validation

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::replay
cargo test --manifest-path core/backend/Cargo.toml terminal::runtime
./research/20260809-124553-fut-tty/vt-proof/run.sh
just test rust
just check all
git diff --check
```

## Exit condition

Do not block this phase on the Phase 05 transport probe. If exact physical row
trimming is required and the fork is not approved, stop with that owner blocker;
otherwise ship the no-fork branch and carry bounded snapshot selection into
Phase 06B.
