# Terminal continuity fix

## Decision

Keep xterm.js as Shipctl's renderer, but stop treating routine presentation
changes as terminal reconstruction boundaries.

The host remains the durable authority for the PTY, libghostty-vt state, and
recovery snapshot. An attached xterm instance is a sequenced mirror:

- raw PTY output plus canonical resize and palette markers share one ordered
  stream;
- xterm changes geometry only when it consumes the host's resize marker;
- resize, theme, and tab visibility never reset terminal contents;
- reset plus replay is reserved for initial attachment, xterm-model recreation,
  sequence gaps, and bounded-queue overflow;
- recovery restores the bounded history the host explicitly retained; and
- output and replay use versioned binary channel frames, while input uses a raw
  invoke body plus a validated terminal-ID header; no byte stream uses JSON
  arrays of numbers.

This combines the low-risk part of Expert 1's proposal with cmux's smart-client
ordering model. It adopts the independent Opus draft's `max_scrollback` unit
and visibility findings, but does not assume that the current formatter either
includes or excludes history until Phase 01 proves it. Expert 2's single-parser
cell renderer remains an escalation path, not this fix: replacing xterm would
also require new rendering, search, selection, link, accessibility, and input
encoding capabilities.

## Evidence behind the decision

- **Shipctl:** `resize` and `set_theme` publish `Replay`, and
  `installReplay` calls `term.reset()`. Remove replay from both routine paths.
- **Shipctl:** `TerminalView` tears down its attachment when `visible` changes.
  Separate renderer visibility from attachment lifetime.
- **Pinned Ghostty source:** `max_scrollback` is a byte budget although both the
  generated C/Rust documentation call it lines. Rename and measure it; do not
  claim 1,000 rows.
- **cmux:** output and `Resized` frames are ordered, while snapshots establish
  a cursor and retained frames bridge to live output. Use the same boundary.
- **cmux:** replay selects a bounded, complete history suffix. Restore newest
  complete retained rows and report truncation explicitly.
- **openmux:** Ghostty's byte ceiling is set to `maxInt`, then its vendored Zig
  wrapper explicitly trims by row and reasserts the policy after resize.
  Shipctl can obtain exact host row trimming only by maintaining a Ghostty C
  API fork plus a libghostty-rs fork; a no-fork path must state weaker physical
  retention semantics honestly.
- **fut:** one host parser plus cell snapshots removes parser divergence and
  supports host-side copy/search. Its numeric `max_scrollback` use is not a
  retention authority because it crosses the same binding-unit ambiguity.
- **Warp:** theme and ordinary resize mutate a live terminal model without
  destructive replay. Treat theme as palette/query state.

## Implementation and reference anchors

Shipctl surfaces to change:

- `core/backend/src/terminal/runtime.rs`, `replay.rs`, `types.rs`,
  `commands.rs`, and `service.rs`;
- `core/frontend/terminal/TerminalView.tsx`,
  `terminalClientRuntime.ts`, and `types.ts`;
- `core/frontend/platform/tauri.ts`; and
- `ops/test/justfile` plus
  `research/20260809-124553-fut-tty/vt-proof`.

Local reference evidence:

- cmux: `/Users/ddebowczyk/projects/_ext/cmux/cmux-tui/spec/terminal-host.md`,
  `crates/cmux-tui-core/src/terminal_host_protocol.rs`,
  `crates/cmux-terminal-client/src/lib.rs`, and
  `crates/ghostty-vt/src/terminal.rs` beneath that `cmux-tui` root;
- fut: `/Users/ddebowczyk/projects/_agents/fut/src/domain.rs`,
  `src/terminal/runtime.rs`, `src/terminal/ghostty.rs`, and
  `src/client/copy_mode.rs`;
- openmux:
  `/Users/ddebowczyk/projects/_ext/openmux/native/zig-ghostty-wrapper/src/terminal/lifecycle.zig`
  and the vendored Ghostty `terminal/Screen.zig`; and
- Warp: `/Users/ddebowczyk/projects/_ext/warp/app/src/terminal/view.rs`
  (`resize_internal` and `handle_theme_change`) and `grid_renderer.rs`.

## Authority and ordering contract

1. The backend actor owns PTY I/O, Ghostty parsing, lifecycle, and retained
   recovery state.
2. The attachment stream owns one consecutive total order across every event
   kind for an incarnation: snapshot/replay, output, resize, palette, metadata,
   agent activity, exit, resynchronization, and detach.
3. A resize is applied by the actor in this order: PTY ioctl, Ghostty resize,
   descriptor update, sequenced `Resized` frame. The renderer must not resize
   optimistically before that frame.
4. Initial attach and recovery install one snapshot at sequence `N`; live
   frames start strictly after `N`.
5. Between recovery boundaries, Ghostty and xterm may differ at the known
   reflow-wrap cursor boundary. The accepted contract is bounded convergence,
   verified in Phase 01. If the discrepancy is not acceptable, stop before
   Phase 04 and reopen the cell-renderer decision.
6. Host history always has a measured memory-safety byte limit. Exact physical
   enforcement of the product row limit requires the approved fork path;
   otherwise the row limit applies to xterm and snapshot selection while the
   host may retain extra rows within the byte cap. Physical eviction and
   snapshot omission are reported separately in both branches.
7. A theme request updates only the host's semantic/query-visible palette and
   publishes an ordered `PaletteChanged` marker. Frontend-only transparency and
   renderer-addon policy never cross Rust. The renderer applies both against
   the same frontend theme revision after earlier writes drain; no content
   replay occurs.
8. Visibility is presentation state. Once a view has attached, hiding it does
   not detach it; an overflow while hidden schedules at most one recovery on
   reveal.
9. Attachment readiness and terminal lifecycle are distinct facts. The
   controller owns readiness; `TerminalClientRuntime` remains the semantic
   authority for whether a lifecycle accepts input.

## Phase sequence

1. [Freeze contracts](01-baseline-contract-and-retention.md) with executable
   facts and the fork/no-fork owner decision. No dependency.
2. [Implement host retention](06a-host-retention.md) without depending on the
   transport migration. Depends only on Phase 01 and ships immediately after
   its decision gate.
3. [Extract the attachment](02-extract-terminal-attachment.md) into a DOM-free
   state machine without behavior changes. Depends on Phase 01.
4. [Decouple visibility](03-decouple-visibility.md) from attachment lifetime.
   Depends on Phase 02.
5. [Order resize and theme](04-ordered-resize-and-theme.md) without destructive
   replay. Depends on Phases 01-03.
6. [Add binary transport](05-binary-attachment-transport.md) for output,
   replay, and input. Depends on Phases 02 and 04.
7. [Bound history replay](06-bounded-history-replay.md) with explicit snapshot
   selection and loss metadata. Depends on Phases 01, 05, and 06A.
8. [Fix the close race](07-close-registry-race.md) through the registry event
   reducer. Depends on Phase 01.
9. [Unify input authority](08-unify-input-authority.md) while keeping transport
   readiness distinct. Depends on Phases 02 and 05.
10. [Cut over and update contracts](09-cutover-and-contract-update.md). Depends
    on Phases 03-08, including 06A and 06B.

The order is intentional. Phases 02 and 03 remove React lifecycle coupling
before resize semantics change. Phase 06A removes the retention defect as soon
as Phase 01 settles its owner decision; it cannot be stalled by a failed raw
transport hypothesis. Phase 05 removes JSON amplification before Phase 06B
enables a larger recovery snapshot. Phases 07 and 08 stay separate because
registry reconciliation and terminal input have different authorities and
failure modes.

## Reconciliation with the corrected Opus draft

The corrected `20260809-191027-terminal-fix-opus` draft contributes four
details adopted here:

- frontend tests use `pnpm exec node --test` through `ops/test/justfile`; this
  repository does not use Vitest;
- the retention proof must test whether Ghostty preserves its effective byte
  ceiling across resize and record whether the pinned binding can reassert or
  trim it;
- replay measurements must separate palette/default bytes from terminal-authored
  palette state before choosing a theme-portable snapshot; and
- the row-immediate/column-debounced resize policy must be remeasured after
  reset/replay is removed instead of being retained by inertia.

The Opus draft still needs these corrections before it is executable as the
primary plan:

1. [Its Phase 01](../20260809-191027-terminal-fix-opus/01-scrollback-retention-budget.md)
   asserts that replay contains history but never locks that fact with a
   replay-into-fresh-parser/xterm test. Keep it a hypothesis until that test
   passes.
2. The same phase recognizes a user-selectable 1k-50k row policy, then proposes
   a hard-coded 10k row-to-byte multiplier and leaves the row-trim design as an
   owner decision. Replace that with explicit live setting propagation, a real
   complete-row trim, an independently measured memory cap, and eviction-cause
   metadata. A content-specific multiplier is evidence, not a row guarantee.
3. [Its Phase 02](../20260809-191027-terminal-fix-opus/02-resize-clear-suppression.md)
   cannot be an independent early production phase. Keep the trace in the
   baseline; implement suppression only after ordered resize exists and only
   for a checked-in supported failing fixture that distinguishes resize-caused
   bytes from legitimate application clears.
4. [Its Phase 03](../20260809-191027-terminal-fix-opus/03-binary-ipc.md)
   must make snapshot boundary `N`, subscriber registration, and first
   `Snapshot` enqueue one backend-actor operation. Frontend `activate()`
   buffering cannot repair a host-side subscription gap. Either stabilize all
   version-1 event kinds first or define `Resized` and `PaletteChanged` in the
   initial codec; adding them after a supposedly frozen codec creates churn.
5. [Its Phase 04](../20260809-191027-terminal-fix-opus/04-attachment-controller-extraction.md)
   calls itself behavior-preserving while also changing close bookkeeping and
   input error semantics. Split pure extraction, D3, and S2 so unchanged
   characterization tests remain a meaningful refactor gate. Its acceptance
   language must also preserve the two named gates: controller readiness and
   runtime lifecycle authority.
6. [Its Phase 05](../20260809-191027-terminal-fix-opus/05-attach-visibility-decoupling.md)
   does not settle its hidden-overflow branch. Specify one pending recovery on
   reveal, stop accepting the stale attachment after overflow, and prove there
   is no hidden reattach loop.
7. [Its Phase 06](../20260809-191027-terminal-fix-opus/06-local-reflow-on-resize.md)
   must not roll back a failed convergence gate to replay-on-every-resize,
   which restores the reported defect. Reopen the single-parser/cell-renderer
   decision instead. A rejected resize also needs no resync when xterm has not
   resized optimistically; only an observed state divergence does.
8. [Its Phase 07](../20260809-191027-terminal-fix-opus/07-theme-decoupling-and-bounded-replay.md)
   mixes ordered theme mutation with history extraction and snapshot bounding.
   Split them. A monolithic formatter byte string cannot be safely suffix-cut
   without complete-row boundaries, and palette provenance must distinguish
   app defaults from child OSC overrides. Initial attachment must also carry
   the current semantic render theme.
9. Add a final cutover phase that removes legacy producers/types, updates the
   earlier `20260809-130352-better-terminal` contract, runs the full ordered
   continuity scenario through production Tauri IPC, repeats performance
   measurements, and validates the packaged app.

## Reconciliation with the second correction pass

The follow-up review is incorporated as follows:

- **Accepted C1-C5, C7-C11, and C13.** Exact host row trimming is now an owner
  decision with an executable no-fork fallback; retention is Phase 06A and no
  longer transport-gated; every event kind stays in the consecutive sequence;
  semantic palette and frontend renderer policy are separate; hidden-theme
  safety is re-proved on xterm 6 with a multi-terminal recovery-storm test;
  resize has an end-to-end latency gate; raw input uses a Tauri request header;
  close waiting has no state-changing timeout; suppression keys off an ordered
  resize generation; and terminal Node suites run serially.
- **Accepted C12's observability requirement, not its field name.** A terminal
  first revealed after background output must report `history_truncated` when
  older history is unavailable. `host_eviction` and `snapshot_omission` remain
  separate causes: calling byte-cap eviction `snapshot_truncated` would blame
  the transport for data the host no longer retained.
- **Partially accepted C6.** The reason to gate input is stale input-encoding
  modes, not PTY availability. However, xterm's current `onData` seam supplies
  bytes after mode-sensitive encoding. Holding those bytes cannot later encode
  them correctly. Phase 08 first proves whether xterm 6 exposes a supported
  structured-intent/deferred-encoding seam. If it does, queue bounded intents;
  if it does not, expose a short recovering state and suppress input before
  encoding. Never queue already encoded mode-sensitive bytes.

The C1 wording that Shipctl would newly “carry Zig” is not adopted: the pinned
libghostty-vt build already clones Ghostty and invokes Zig. The material new
cost is ownership of two forks, their compatibility tests, and reproducible
pin updates.

## Whole-plan acceptance criteria

- A terminal containing more than one viewport of numbered history preserves
  its xterm scrollback and viewport across repeated width/height resize, theme
  changes, settings-overlay transitions, and tab hide/show.
- Those routine actions publish no `Replay` event and call neither
  `term.reset()` nor attachment `detach()`.
- Initial attach, xterm-model recreation, injected sequence gap, and injected
  queue overflow each reconstruct the newest complete history suffix retained
  by the host. A terminal created in a background tab also reconstructs or
  explicitly reports missing pre-reveal history on first reveal. Metadata
  distinguishes host-retention eviction from additional snapshot omission.
- A replay at sequence `N` followed by frames `N+1...M` produces the same
  supported terminal state as a fresh host snapshot at `M`.
- Output and replay cross Tauri IPC as raw channel frames. Input crosses as a
  pure raw invoke body with the terminal ID in a validated request header.
  Public TypeScript APIs contain no `readonly number[]` payload and input
  contains no `Array.from(bytes)` conversion.
- A `listTerminals()` result that began before `close()` cannot leave the
  closed terminal resurrected after the host's `Removed` event is observed.
- An exit racing a keystroke is treated as expected terminal unavailability;
  real transport failures remain visible.
- Existing alternate-screen, OSC 8 link, selection, search, Unicode, palette,
  mouse, paste, and lifecycle behavior remains covered and passing.
- Every focused terminal Node test is registered with
  `--test-concurrency=1`; no terminal suite relies on parallel global state.
- `just check all`, `just test full`, the extended VT proof, modularity checks,
  Markdown lint, and `git diff --check` pass.

## Explicit non-goals

- Replacing xterm.js with a cell renderer in this plan.
- Persisting terminal history to disk or surviving backend-process loss.
- Sending PTY bytes through the general application event bus.
- Silently falling back to active-screen-only replay when a recovery snapshot
  exceeds its budget.
- Suppressing child-issued `CSI 2 J` or `CSI 3 J` after resize without the
  Phase 01 trace proving that this is an actual Shipctl failure mode.

## Escalation trigger

Reopen the host-cell-renderer architecture only if Phase 01 demonstrates that
the measured reflow discrepancy violates a product requirement that demands
pixel/cell-exact equivalence at every instant, rather than exact recovery at
attachment boundaries. That decision must include replacement plans for
xterm's rendering, input encoding, search, selection, links, and accessibility;
it must not enter this work as an incidental resize fix.
