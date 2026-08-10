# Recovery is bounded and history-complete

## Outcome

Every new or untrusted xterm model reconstructs the newest complete history
suffix selected from host-retained state plus the complete active terminal
state. Snapshot size, ordering, and loss metadata are explicit.

## Context and purpose

The earlier closure changes remove replay from normal visibility, resize, and
theme operation. Snapshot installation remains essential when no renderer
state exists or the attachment cannot prove continuity.

The host-retention preparatory change owns physical retention. This plan owns
only bounded recovery selection, encoding, installation, and reporting. It must
not add a second row or byte policy or infer exact host rows from Ghostty's
byte-valued `max_scrollback` option.

## Recovery contract

A `Snapshot` at sequence `N` contains:

- terminal incarnation, canonical geometry, and descriptor revision;
- retained-row and delivered-history-row counts;
- separate physical `host_eviction` and recovery `snapshot_omission` causes;
- the newest complete selected primary-screen history suffix;
- the complete active primary or alternate screen;
- cursor position, shape and visibility, wrap state, modes, tab stops,
  hyperlinks, and supported semantic color overrides; and
- semantic palette state that remains portable across application themes.

The controller resets the fresh or untrusted xterm, applies canonical geometry,
writes the snapshot, waits for the xterm write callback, then releases live
frames strictly after `N`.

## Dependencies

- Preparatory raw framing, atomic attach bootstrap, retention authority, and VT
  dependency decision are complete.
- Visibility, resize, and theme closure plans are complete, leaving exactly the
  four recovery boundaries defined in [`end-state.md`](end-state.md).
- Formatter expansion and supported-state evidence exist for the selected
  dependency branch.

## Affected areas

- `core/backend/src/terminal/replay.rs`
- `core/backend/src/terminal/runtime.rs`
- `core/backend/src/terminal/types.rs`
- `core/backend/src/terminal/service.rs`
- raw terminal protocol codecs and adapters
- the preparatory attachment controller
- `core/frontend/terminal/terminalOutputQueue.ts`
- `core/frontend/terminal/terminalCache.ts`
- terminal replay, runtime, protocol, controller, and visibility tests
- `research/20260809-124553-fut-tty/vt-proof`

## Work to be done

1. Consume the service-owned retained-row view and retention statistics. Do not
   mutate Ghostty retention or choose a dependency branch in snapshot code.
2. Use the pinned formatter when it can emit the selected complete state. Where
   fixtures prove a gap, use the public history selection API before proposing
   a narrow read-only dependency patch.
3. Define the snapshot install stream so selected history scrolls into xterm
   history, only the active grid is cleared, complete active state is restored,
   and live output resumes without duplicated bottom rows or changed hard/soft
   wrap semantics.
4. Select the newest complete history rows that fit the canonical product row
   policy and a derived snapshot byte budget. Never start inside a wrapped
   logical row, UTF-8 sequence, control sequence, grapheme, or wide-cell pair.
5. Always include the complete supported visible grid and restoration state.
   If those cannot fit the derived bound, return a typed attachment error with
   measured diagnostics instead of emitting partial state.
6. Derive the snapshot byte budget from formatter expansion measurements, raw
   channel throughput and allocation evidence, supported geometry, and the
   subscriber-queue policy. Check in the formula; do not introduce an
   unexplained constant.
7. Encode independent loss causes:
   - `host_eviction`: no loss, byte-limit eviction, or an approved fork's
     row-limit eviction;
   - `snapshot_omission`: no loss, row-policy omission, or byte-budget omission.
   Derive user-facing history truncation when either cause is present.
8. Preserve terminal-authored semantic palette and default-color overrides
   without serializing the previous application theme as terminal content.
9. Hold live frames while the snapshot at `N` installs. Drop duplicates at or
   before `N`, accept `N + 1`, and start one new recovery on a later gap.
10. Add equivalence fixtures for initial attach, first reveal of a background
    terminal, xterm-model recreation, explicit sequence gap, subscriber
    overflow, output while no renderer exists, and recovery after resize and
    theme changes.
11. Cover primary and alternate screens, cursor/wrap/modes, tab stops, links,
    selection/searchable history, Unicode graphemes, wide cells, and supported
    color overrides.
12. Prove the invariant: snapshot `N` plus live frames `N + 1...M` produces the
    same supported state as a fresh host snapshot at `M`.

## Acceptance criteria

- Snapshot construction consumes but does not redefine host retention policy.
- Every legitimate boundary performs one reset and one snapshot installation;
  routine resize, theme, and hide/show perform none.
- A new renderer restores all rows selected by the bounded host snapshot,
  including output produced before first attachment or while no renderer exists.
- Selected history is a newest complete suffix and the complete active state
  always follows it without duplicated rows or damaged wrap semantics.
- Physical host eviction and snapshot selection omission are independently
  encoded, tested, and exposed. Active-screen-only fallback is never silent.
- The active screen, alternate-screen state, cursor, modes, tabs, links,
  supported colors, and Unicode cells match the host after installation.
- Theme-owned colors adopt the current application theme while supported
  terminal-authored overrides remain terminal-owned.
- Snapshot `N` plus later live frames is equivalent to fresh state at the final
  sequence across the checked-in corpus.
- Gap and overflow recovery return to live delivery without losing,
  duplicating, or applying stale-generation output.
- No replay or snapshot byte array crosses JSON.

## How to validate

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::replay
cargo test --manifest-path core/backend/Cargo.toml terminal::runtime
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalProtocol.test.ts \
  core/frontend/terminal/tests/terminalVisibility.test.ts
./research/20260809-124553-fut-tty/vt-proof/run.sh
just test fast
just test rust
just check all
git diff --check
```

Run boundary tests with deliberately delayed snapshot writes and live frames on
both sides of `N`. Run first-reveal tests with output beyond host and snapshot
budgets so both loss causes are observable.

## Exit and rollback

Exit only when every supported state has a recovery-equivalence fixture. If
the pinned dependency cannot expose required retained state, patch and pin only
the proven read gap. Do not replace bounded history with unbounded replay or an
unreported active-screen-only snapshot.
