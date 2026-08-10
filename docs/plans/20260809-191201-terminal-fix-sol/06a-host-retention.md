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

The current settings path is not a host update channel. The backend command
normalizes and persists, while `useTerminalSettingsStore` subsequently calls
`applyTerminalSettings` on cached xterms. Phase 06A must introduce the service
and actor path for both newly spawned and already running terminals. Validation
belongs only in `workspace/config.rs`; `SettingsPanel` remains a selector.

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

### H6A.4 — Canonical live settings delivery

A saved row setting is normalized once by the workspace authority, persisted,
installed under one monotonic `TerminalService` policy revision, acknowledged
by every still-running actor, returned canonically to the frontend, and then
applied to xterm. Falsifier: any layer validates independently, a new/running
terminal retains a stale policy, or the frontend commits its unnormalized input.

## Tasks

1. Implement Phase 01's frozen admissible row domain and canonicalization beside
   `TerminalSettings` in `workspace/config.rs`. Extend
   `normalize_terminal_settings()` so persisted and IPC values follow the same
   rule. Keep UI choices non-authoritative; add workspace tests for below-range,
   above-range, boundary/default, and—if presets are exact—off-preset values.
2. Change `save_terminal_settings` to return
   `AppliedTerminalSettings { settings, retention_revision }`. Make
   `useTerminalSettingsStore.updateSettings()` commit and apply the canonical
   response, never its pre-save `next` object, and ignore an older revision that
   resolves after a newer save. Add store tests for canonicalization and
   reversed rapid-save responses.
3. Rename the misleading backend constant and fields so Ghostty's construction
   option is visibly byte-valued. Apply the measured Phase 01 cap to every new
   terminal.
4. Add a backend-owned `TerminalRetentionPolicy { row_limit, byte_limit,
   revision }` to `TerminalService`. Construct the workspace before the service
   in `src-tauri/src/lib.rs`, load and normalize persisted settings, and seed the
   service policy before any terminal can spawn. Define a tested default/failure
   path for unreadable configuration rather than silently using frontend state.
   New spawns capture this policy from the service; do not add a caller-supplied
   row limit to public `TerminalLaunchRequest`.
5. Add `TerminalService::update_retention_policy` and a runtime actor command.
   Serialize the complete settings mutation—not only the disk write—so rapid
   saves cannot reorder persistence and runtime application. Perform this route:
   `normalize -> persist -> commit service revision -> acknowledge every live
   actor -> return AppliedTerminalSettings`. Do not hold the terminal registry
   lock while awaiting actors. New spawns capture the latest service policy. An
   actor that raced to exit may be skipped; every actor still capable of
   output/snapshot must acknowledge the same revision. Design application of a
   normalized policy as infallible so a persisted change cannot become a
   frontend-only partial success.
6. In the no-fork branch, actors store the row policy for future snapshot
   selection without pretending to trim Ghostty. In the fork branch, the actor
   also performs complete-row trim before acknowledging a reduction. The
   frontend applies canonical `settings.scrollback` to all cached xterms only
   after the backend returns the applied revision.
7. Add backend retention fixtures for ASCII, wide Unicode, combining cells,
   wraps, styles, hyperlinks, blank rows, primary/alternate transitions,
   narrow/wide resize, and sustained output with no renderer attached.
8. Add an internal `TerminalRetentionStats` observation containing retained
   rows/pages/bytes and physical `host_eviction` cause. Keep it independent of
   the Phase 05 wire codec; Phase 06B serializes only the supported subset.
9. For the fork branch:
   - add the narrow complete-row trim operation in a pinned Ghostty fork;
   - pin a libghostty-rs fork that exposes it without leaking Zig types;
   - trim after output and reflow at deterministic points;
   - preserve the independent byte cap; and
   - document fork update, compatibility-test, and CI ownership.
10. For the no-fork branch, add no fake host trim. Retain extra rows only within
   the byte cap and ensure every user-facing row projection applies the product
   row limit. Record that a live reduction is not physical erasure.
11. Define eviction accounting once: `byte_limit` means Ghostty discarded
   history; `row_limit` is legal only in the fork branch; `none` makes no claim
   about rows that a later bounded snapshot may omit.
12. Add creation/live-update tests that cover save before spawn, save with
    multiple running terminals, one actor exiting during delivery, decrease,
    increase, invalid IPC input, persisted invalid input, app restart, and both
    fork/no-fork semantics.
13. Register focused backend tests and the new serial frontend settings-store
    test in `ops/test/justfile`; capture memory, retained-row, and resize results
    for the selected branch.

## Acceptance criteria

- The backend's byte cap has a measured value, byte-named source symbols, and
  fixtures proving it remains effective through output and resize.
- `workspace/config.rs` is the sole row-validation authority. Unsupported disk
  and IPC values normalize identically, save returns the canonical value, and
  the frontend never commits its unchecked request.
- The plan adds and tests an explicit settings-delivery path; it does not imply
  that save, `applyTerminalSettings`, or an existing runtime channel already
  propagates host policy.
- New and running terminals converge on one monotonic service policy revision.
  Every live actor acknowledges before the save response is applied to cached
  xterms; an exit race cannot leave a writable/snapshot-capable stale actor.
- Concurrent saves serialize across persistence and actor delivery; a delayed
  older response cannot roll the frontend store/xterms back from a newer
  revision.
- Tauri, module, and control-socket terminal creation all inherit the service
  policy; no launch caller can bypass normalization with its own row limit.
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
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalSettingsStore.test.ts
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
