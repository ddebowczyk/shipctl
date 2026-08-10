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
includes or excludes history until Phase 01 proves it. Herdr validates Expert
2's single-parser cell renderer as a coherent escalation architecture, not as a
proportionate prerequisite for these fixes: its implementation also owns cell
rendering, host-side scrolling/search, structured input encoding, render-frame
scheduling, and a local Ghostty grapheme patch.

## Evidence behind the decision

- **Shipctl:** `resize` and `set_theme` publish `Replay`, and
  `installReplay` calls `term.reset()`. Remove replay from both routine paths.
- **Shipctl:** `TerminalView` tears down its attachment when `visible` changes.
  Separate renderer visibility from attachment lifetime.
- **Pinned Ghostty source:** `max_scrollback` is a byte budget although both the
  generated C/Rust documentation call it lines. Rename and measure it; do not
  claim 1,000 rows.
- **Pinned libghostty-rs API:** `Terminal::total_rows`,
  `Terminal::scrollback_rows`, `Point::Screen`/`Point::History`,
  `Selection::new`, and `FormatterOptions::with_selection` already expose an
  explicit bounded history-read path for the active screen. Use and test that
  surface before proposing a history-read fork; inactive-primary access while
  the alternate screen is active remains a hypothesis.
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
- **Herdr:** one host-owned Ghostty model parses PTY output, encodes structured
  input from current modes, exposes semantic cells/cursor/links, and keeps
  hidden panes parsing while suppressing their presentation work. Its client
  transport separates reliable control from capacity-one replaceable rendered
  state. This is the concrete escalation model if dual-parser convergence is
  rejected; raw PTY frames in the present plan remain non-replaceable.
- **Herdr:** its byte-named application setting and Ghostty test independently
  confirm that `max_scrollback` is bytes despite the vendored C header saying
  lines. Herdr vendors Ghostty and carries a mode-2027 grapheme patch, which
  confirms both the unit finding and the maintenance cost of a direct renderer.

## Implementation and reference anchors

Shipctl surfaces to change:

- `core/backend/src/terminal/runtime.rs`, `replay.rs`, `types.rs`,
  `commands.rs`, and `service.rs`;
- `core/backend/src/workspace/config.rs`, `src-tauri/src/lib.rs`, and the
  terminal-settings command wiring;
- `core/frontend/terminal/TerminalView.tsx`,
  `terminalClientRuntime.ts`, `useTerminalSettingsStore.ts`, and `types.ts`;
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
  and the vendored Ghostty `terminal/Screen.zig`;
- Warp: `/Users/ddebowczyk/projects/_ext/warp/app/src/terminal/view.rs`
  (`resize_internal` and `handle_theme_change`) and `grid_renderer.rs`; and
- Herdr: `/Users/ddebowczyk/projects/_ext/herdr/src/pane/terminal.rs`,
  `src/protocol/wire.rs`, `src/protocol/render_ansi.rs`,
  `src/server/client_transport.rs`, `src/server/headless.rs`, and
  `vendor/libghostty-vt.patches.md`, inspected at commit
  `6c6ddcd49384d6ea9f0ee2e63bf7b2643dfd5bcf`.

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
   not detach it. The host continues PTY reads and Ghostty parsing, and the
   attachment continues sequence processing and non-replaceable xterm writes;
   only DOM measurement, focus, and avoidable presentation work are suppressed.
   An overflow while hidden schedules at most one recovery on reveal.
9. Attachment readiness and terminal lifecycle are distinct facts. The
   controller owns readiness; `TerminalClientRuntime` remains the semantic
   authority for whether a lifecycle accepts input.
10. `TerminalSettings` plus `normalize_terminal_settings()` are the sole
    persisted row-policy authority. `SettingsPanel` supplies choices but does
    not validate. A save is not complete until the canonical persisted policy
    reaches `TerminalService`, all still-live runtime actors, and the frontend
    store/xterms under one monotonic revision.

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
7. [Bound history replay](06b-bounded-history-replay.md) with explicit snapshot
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

The corrected Opus draft now incorporates the substantive earlier review:

- [Phase 01](../20260809-191027-terminal-fix-opus/01-scrollback-retention-budget.md)
  treats replay history and byte retention as hypotheses, locates settings
  validation in `normalize_terminal_settings`, and prices both live-update and
  dependency-ownership choices.
- [Phase 02](../20260809-191027-terminal-fix-opus/02-resize-clear-suppression.md)
  runs only the trace early and defers any suppression until the ordered resize
  generation exists.
- [Phase 03](../20260809-191027-terminal-fix-opus/03-binary-ipc.md) keeps every
  event kind in the total order, makes attach bootstrap one actor operation,
  and uses a request header with a pure binary input body.
- [Phases 04](../20260809-191027-terminal-fix-opus/04-attachment-controller-extraction.md)
  and [05](../20260809-191027-terminal-fix-opus/05-registry-and-input-authority.md)
  separate behavior-preserving extraction from D3/S2 behavior changes.
- [Phase 06](../20260809-191027-terminal-fix-opus/06-attach-visibility-decoupling.md)
  specifies one pending recovery on reveal and rejects frames from the stale
  hidden attachment after overflow.
- [Phase 07](../20260809-191027-terminal-fix-opus/07-ordered-resize-and-local-reflow.md)
  measures marker latency, forbids replay-on-every-resize as rollback, and
  escalates broad divergence.
- [Phases 08](../20260809-191027-terminal-fix-opus/08-theme-ordering.md) and
  [09](../20260809-191027-terminal-fix-opus/09-bounded-history-replay.md) now
  separate theme ordering/provenance from bounded history extraction.
- [Phase 10](../20260809-191027-terminal-fix-opus/10-cutover-and-contract-update.md)
  supplies the production-IPC, packaged-app, legacy-removal, and contract
  cutover gate.

Two gaps remain after the Herdr and pinned-binding review:

1. Opus Phase 09 should start with the already-pinned
   `Point::History`/`Selection` formatter surface and test access to inactive
   primary history while the alternate screen is active. Dependency work is
   justified only by a checked-in fixture proving that public surface
   insufficient.
2. Phase 09's rollback may not declare success with an unbounded recovery
   payload: that contradicts its objective and leaves a memory/IPC failure on
   every attach or resync. Failure to derive a safe bound blocks production
   cutover. For resize-triggered exceptional recovery, also preserve the
   viewport and explicitly measure selection loss; otherwise escalate the
   divergence instead of silently weakening the continuity contract.

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
  first revealed after background output must report any loss explicitly:
  `host_eviction` when the host discarded rows and `snapshot_omission` when the
  snapshot bound omitted rows the host still retained. Calling byte-cap
  eviction `snapshot_truncated` would blame the transport for data the host no
  longer retained.
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

## Reconciliation with the settings-authority correction

All three follow-up findings are accepted:

1. The row authority is now explicitly `TerminalSettings`,
   `default_scrollback()`, and `normalize_terminal_settings()` in backend
   workspace configuration. `SettingsPanel` is only a selector.
2. Phase 06A now treats live settings delivery as new machinery: startup seeding,
   a service policy revision, a runtime actor command, canonical save response,
   and frontend application. The current persist-then-xterm path is not called
   a host propagation channel.
3. Phase 01 only specifies supported values and delivery semantics. Production
   normalization and propagation are implemented in Phase 06A, preserving
   Phase 01's no-production-behavior exit condition.

## Reconciliation with Herdr

Herdr changes the confidence in the escalation path, not the order of this
fix. The following elements are incorporated:

- hidden terminals must continue host parsing and stream consumption while
  only presentation work is suppressed;
- structured key, paste, and mouse intent encoded from the authoritative host
  model is the single-parser target if recovery input must be retained;
- a future semantic renderer should carry revisioned viewport cells, cursor,
  styles, hyperlinks, and dirty-row deltas, with reliable control separated
  from capacity-one replaceable render state; and
- direct rendering must explicitly cover grapheme clustering, wide-cell tails,
  combining marks, ZWJ emoji, flags, search, selection, copy, links, graphics,
  accessibility, and host-owned viewport navigation.

These Herdr mechanisms are deliberately not copied into the xterm phase:

- pending raw PTY output cannot be replaced like a derived semantic frame;
  dropping it requires the existing gap/overflow snapshot recovery;
- Herdr's foreground-client rule for shared TUI geometry does not apply to
  Shipctl's independently owned terminal tabs;
- Herdr's byte-only scrollback setting does not implement Shipctl's product row
  policy or a live complete-row trim; and
- its resize-time recent-ANSI reinjection is a product-specific workaround,
  not a general substitute for ordered resize or a canonical snapshot.

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
- Every data and control event carries a non-zero consecutive sequence; dropping
  metadata, activity, exit, resync, or detach is detected like dropped output.
- Output and replay cross Tauri IPC as raw channel frames. Input crosses as a
  pure raw invoke body with the terminal ID in a validated request header.
  Public TypeScript APIs contain no `readonly number[]` payload and input
  contains no `Array.from(bytes)` conversion.
- A `listTerminals()` result that began before `close()` cannot leave the
  closed terminal resurrected after the host's `Removed` event is observed.
- An exit racing a keystroke is treated as expected terminal unavailability;
  real transport failures remain visible.
- Existing alternate-screen, OSC 8 link, selection, search, Unicode, palette,
  mouse, paste, and lifecycle behavior remains covered and passing. Unicode
  fixtures include combining marks, flags, ZWJ emoji, and wide-cell tails.
- Invalid persisted and IPC scrollback values canonicalize only through the
  backend workspace normalizer. Saving a valid live change updates every
  still-running host actor, future spawn, frontend store, and cached xterm to
  the same policy revision/value.
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

Use Herdr's boundary—not its TUI implementation—as the conditional target:
Ghostty becomes the sole parser, geometry/mode/history authority, and structured
input encoder; clients receive versioned semantic viewport snapshots and
base-revision row deltas; scrolling/search/copy address canonical host rows;
hidden panes keep parsing without frame generation; reliable control is never
dropped, while stale derived frames may be replaced by the newest full frame.
The migration gate must prove feature parity, grapheme-mode reset survival,
slow-client recovery, renderer performance, and accessibility before xterm is
removed.
