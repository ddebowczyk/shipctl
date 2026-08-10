# Recovery is bounded and history-complete

## Outcome

Every new or untrusted xterm model reconstructs the newest complete history
suffix selected from host-retained state plus the complete active terminal
state. Snapshot size, ordering, and loss metadata are explicit, and recovery is
cheap enough that the design stops avoiding it.

## Context and purpose

The earlier closure changes remove replay from normal visibility, resize, and
theme operation. Snapshot installation remains essential when no renderer state
exists or the attachment cannot prove continuity.

Recovery today sends the whole retained history. `replay()`
(`core/backend/src/terminal/runtime.rs:692`) produces a `TerminalReplay` whose
bytes the view installs after `term.reset()`. While that is expensive, every
design decision bends around avoiding it — which is the deeper reason routine
presentation changes were made to carry it reluctantly, and why the overflow
path has the shape it does. Make recovery bounded and quick and gap handling
stops being a hazard. It becomes an ordinary transition.

The host-retention preparatory change owns physical retention. This plan owns
only bounded recovery selection, encoding, installation, and reporting. It must
not add a second row or byte policy, and it must not infer exact host rows from
Ghostty's byte-valued `max_scrollback` option. That option is the source of the
most visible history-loss symptom: `MAX_SCROLLBACK_LINES`
(`core/backend/src/terminal/replay.rs:21`) is named as lines and enforced by
Ghostty as bytes. The preparatory change corrects the naming and establishes
the measurement; this change spends it.

Two numbers that must agree are one number. The snapshot bound and the
retention policy come from the same authority at the same revision.

## Dependencies

- Preparatory raw framing, atomic attach bootstrap, retention authority, and
  the VT dependency decision are complete.
- Visibility, resize, and theme closure plans are complete, leaving exactly the
  four recovery boundaries defined in [`end-state.md`](end-state.md).
- Formatter expansion and supported-state evidence exist for the selected
  dependency branch.
Snapshot routing uses the existing `TerminalId`, the stable UUID identity of
one host-owned terminal runtime (`core/backend/src/terminal/types.rs:9-12`).
No separate incarnation concept is introduced. A host restart cannot present a
reset sequence under a live identity: records live only in an in-memory map
(`service.rs:38-43`), `shutdown_all()` drains it (`service.rs:319-341`), UUIDs
are asserted never to be reused (`service.rs:91-101`), and a remote client
holding an old ID observes absence rather than a new runtime. That is
lifecycle, not recovery.

## Recovery contract

A `Snapshot` at sequence `N` contains:

- terminal ID, canonical geometry, and descriptor revision;
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

Applying geometry here does not violate change 02's rule that xterm geometry
changes only from the ordered `Resized` marker. A recovery boundary is the
other legitimate source, and the snapshot carries the canonical value. The
cutover search in change 05 must not treat this path as a surviving
independent geometry assertion.

## Affected areas

- `core/backend/src/terminal/replay.rs`
- `core/backend/src/terminal/runtime.rs`
- `core/backend/src/terminal/types.rs`
- `core/backend/src/terminal/service.rs`
- `core/backend/src/instance/protocol.rs`
- raw terminal protocol codecs and adapters
- the preparatory attachment controller
- `core/frontend/terminal/terminalOutputQueue.ts`
- `core/frontend/terminal/terminalCache.ts`
- terminal replay, runtime, protocol, controller, and visibility tests
- the differential VT corpus

## Work to be done

1. Consume the service-owned retained-row view and retention statistics. Do not
   mutate Ghostty retention or choose a dependency branch in snapshot code.
2. Use the pinned formatter when it can emit the selected complete state. Where
   fixtures prove a gap, use the public history selection API before proposing
   a narrow read-only dependency patch.
3. Define the snapshot install stream so selected history scrolls into xterm
   history, only the active grid is cleared, complete active state is restored,
   and live output resumes without duplicated bottom rows or changed hard and
   soft wrap semantics.
4. Select the newest complete history rows that fit the canonical product row
   policy and a derived snapshot byte budget. Never start inside a wrapped
   logical row, UTF-8 sequence, control sequence, grapheme, or wide-cell pair.
5. Always include the complete supported visible grid and restoration state. If
   those cannot fit the derived bound, return a typed attachment error with
   measured diagnostics instead of emitting partial state.
6. Derive the snapshot byte budget from formatter expansion measurements, raw
   channel throughput and allocation evidence, supported geometry, and the
   subscriber-queue policy. Check in the formula and the numbers behind it. An
   unexplained constant is not admissible.
7. Encode independent loss causes:
   - `host_eviction`: no loss, byte-limit eviction, or an approved fork's
     row-limit eviction;
   - `snapshot_omission`: no loss, row-policy omission, or byte-budget omission.

   Derive user-facing history truncation when either cause is present. Losing
   history to the retention cap and losing it to the snapshot bound are
   different defects and must never report as one.
8. Report omission where it matters. If a recovery drops history the user was
   reading, that must be visible in the terminal, not silent.
9. Use one snapshot production path for first attach and for recovery. They are
   the same operation at different times; two paths will drift.
10. Preserve terminal-authored semantic palette and default-color overrides
    without serializing the previous application theme as terminal content.
11. Hold live frames while the snapshot at `N` installs. Drop duplicates at or
    before `N`, accept `N + 1`, and start one new recovery on a later gap.
12. Re-time the overflow boundary. With a bounded snapshot, decide whether
    queue overflow still needs a full reattach or can resolve inside the
    controller.
13. Carry the bound and the omission through the instance control protocol.
    `TerminalReplayFrame` (`core/backend/src/instance/protocol.rs:318-324`)
    must express both, or the CLI observes a different truth from the app.
14. Add equivalence fixtures for initial attach, first reveal of a background
    terminal, xterm-model recreation, explicit sequence gap, subscriber
    overflow, output while no renderer exists, and recovery after resize and
    theme changes.
15. Cover primary and alternate screens, cursor, wrap and modes, tab stops,
    links, selection, restored scrollback history, Unicode graphemes, wide
    cells, and supported color overrides. History is asserted as restored and
    selectable, not as searchable: no search addon is installed.
16. Prove the invariant: snapshot `N` plus live frames `N + 1 ... M` produces
    the same supported state as a fresh host snapshot at `M`.
17. Measure time to a correct screen after a gap, and snapshot size, encode
    time, and install time across the checked-in corpus. Record them beside the
    preparatory baselines.

## Acceptance criteria

- Snapshot construction consumes but does not redefine host retention policy.
  The snapshot bound and the retention policy resolve to one authority at one
  revision, and no second constant exists.
- Every legitimate boundary performs one reset and one snapshot installation;
  routine resize, theme, and hide and show perform none.
- A new renderer restores all rows selected by the bounded host snapshot,
  including output produced before first attachment or while no renderer
  exists.
- Selected history is a newest complete suffix, and the complete active state
  always follows it without duplicated rows or damaged wrap semantics.
- Physical host eviction and snapshot selection omission are independently
  encoded, tested, and exposed. Active-screen-only fallback is never silent.
- Omitted history is visible to the user when it affects what they were
  reading.
- The snapshot byte budget is derived from checked-in measurements, and the
  derivation is recorded with the numbers.
- First attach and recovery use the same snapshot production path.
- The active screen, alternate-screen state, cursor, modes, tabs, links,
  supported colors, and Unicode cells match the host after installation.
- Theme-owned colors adopt the current application theme while supported
  terminal-authored overrides remain terminal-owned.
- Snapshot `N` plus later live frames is equivalent to fresh state at the final
  sequence across the checked-in corpus.
- Gap and overflow recovery return to live delivery without losing,
  duplicating, or applying stale-generation output.
- The instance control protocol carries the bound and the omission with its
  declared schema intact.
- No replay or snapshot byte array crosses JSON.
- Time to a correct screen after a gap is measured and recorded. A regression
  against the pre-change replay path is fixed or accepted by a named owner.

## How to validate

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::replay
cargo test --manifest-path core/backend/Cargo.toml terminal::runtime
cargo test --manifest-path core/backend/Cargo.toml terminal::service
cargo test --manifest-path core/backend/Cargo.toml instance::control
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
budgets so both loss causes are observable. Use corpus content with different
byte-to-row expansion, so no test can pass under both the byte and the row
reading of the bound.

## Exit and rollback

Exit only when every supported state has a recovery-equivalence fixture. If the
pinned dependency cannot expose required retained state, patch and pin only the
proven read gap. Do not replace bounded history with unbounded replay or an
unreported active-screen-only snapshot.
