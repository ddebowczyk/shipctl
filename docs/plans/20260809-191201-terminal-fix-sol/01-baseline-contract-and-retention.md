# Phase 01 — Freeze the continuity and retention contracts

## Outcome

Replace disputed assumptions with executable evidence before changing runtime
behavior. This phase produces failing characterization tests, measured payload
baselines, and the owner decision needed by Phases 06A and 06B.

## Context

- `runtime.rs` currently makes resize and theme changes replay boundaries.
- `TerminalView.tsx` also detaches whenever `visible` changes.
- The generated Rust binding and underlying C API documentation both describe
  `TerminalOptions.max_scrollback` as lines, while Ghostty's authoritative
  `Screen.zig` implementation treats it as bytes rounded to its page size.
  Herdr independently reaches the same conclusion: its application setting is
  byte-named and tested even though its vendored C header repeats the line-unit
  documentation bug.
- The pinned public C API exposes construction-time `max_scrollback`, RIS reset,
  and opportunistic compression, but no post-construction byte-cap setter or
  complete-row trim. Exact host row trimming therefore means maintaining a
  Ghostty Zig/C API fork and a libghostty-rs fork. Zig is already part of the
  pinned dependency's build; fork ownership and pin maintenance are the new
  costs.
- `Formatter` says it formats the active screen. In Ghostty terminology that
  may include the active primary screen's retained page list; the current
  Shipctl tests do not establish whether replay includes history. Separately,
  the pinned Rust API already exposes `total_rows`, `scrollback_rows`,
  `Point::Screen`/`Point::History`, `Selection::new`, and
  `FormatterOptions::with_selection`; Shipctl already uses the selection path
  for cursor-cell repair. The unknown is behavior and inactive-primary access,
  not whether any explicit range API exists.
- `VtReplayEngine::replay()` handles an active alternate screen by formatting
  it, writing `DECSET 1049` off into the live host model, formatting primary,
  resetting Ghostty, and replaying both buffers back into the host. If primary
  history is absent or incomplete, this recovery path destroys host history as
  well as renderer history. The primary/alternate fixture is therefore a
  correctness gate, not only a formatter characterization.
- The existing VT proof establishes split-stream equivalence and one reflow
  cursor discrepancy, but it uses `max_scrollback: 1_000` and does not verify
  deep retained history.
- `TerminalSettings.scrollback`, `default_scrollback()`, and
  `normalize_terminal_settings()` in `workspace/config.rs` are the backend
  persistence/validation authority. The normalizer currently handles only
  `url_allowlist`; it accepts arbitrary `u32` scrollback values.
- `SettingsPanel` merely offers 1k, 5k, 10k, 25k, and 50k presentation choices.
  It must not become a second validator or define what the host accepts.
- `save_terminal_settings` currently normalizes and persists only. The frontend
  store then calls `applyTerminalSettings`, which updates cached xterms; no
  command, event, service method, or runtime actor operation updates running
  host terminals.

## Hypotheses to verify

### H1 — Retention uses bytes

The configured `1_000` is a byte budget, not 1,000 rows. Feed numbered rows at
several widths and contents, then inspect retained rows and page accounting.
Falsifier: retention remains exactly 1,000 rows independent of content/width.

### H2 — Formatter history scope

The current unselected formatter serializes retained primary-screen history.
Replay unique numbered rows into a fresh parser and xterm, then search for the
earliest row. Repeat while the alternate screen is active, and separately
format an explicit `Point::History` selection. Falsifier: the unselected
formatter emits only the visible grid, or the public range API cannot read the
required primary history in one of the supported screen states.

### H3 — Current destructive boundaries

Resize, theme, and hide/show each cross a reset boundary today. Count event
kinds, attachment IDs, and `term.reset()` calls. Falsifier: any action completes
with no replay, reset, or detach.

### H4 — Ordered resize convergence

Matching host and xterm geometry at the resize marker limits divergence to the
known wrap-boundary cursor case; later absolute positioning converges. Extend
the proof across output-before/after-resize, relative movement, shell prompt,
and TUI redraw fixtures. Falsifier: supported state remains divergent after an
absolute redraw.

### H5 — Child clear sequences

Child-issued history clears are not a general consequence of Shipctl resize.
Trace representative shells/TUIs during SIGWINCH and classify `CSI 2 J` and
`CSI 3 J`. Falsifier: a supported child reproducibly clears only in the resize
window.

### H6 — JSON amplification

JSON byte arrays materially amplify the hot path. Measure serialized bytes,
encode/decode time, and peak allocation for small, screen-sized, and burst
payloads. Falsifier: raw framing gives no material benefit on supported Tauri.

### H7 — Retention survives resize

Ghostty continues enforcing the intended byte ceiling after narrow-to-wide and
wide-to-narrow resize. Measure retained rows and native page bytes before and
after reflow and freeze the missing setter/trim inventory. Falsifier: resize
silently changes the effective byte ceiling. Lack of row trim is already a
known dependency constraint, not a reason to stall the no-fork path.

### H8 — Palette cost and provenance

Measure replay bytes with and without formatter palette/default state, then
round-trip a fixture containing child-authored OSC 4 and OSC 10/11 overrides.
Falsifier: removing theme defaults also loses terminal-authored state, requiring
explicit provenance or sparse override extraction rather than a blanket
`with_palette(false)` change.

### H9 — Settings topology

Saving scrollback reaches persistence and cached xterms but not
`TerminalService` or any running `RuntimeActor`. Trace load, save, spawn, and a
live reduction. Falsifier: an existing host runtime already receives a
canonical row-policy update.

## Tasks

1. Add backend replay fixtures that write uniquely numbered ASCII, styled,
   wrapped, hyperlink, combining-mark, flag, ZWJ-emoji, and wide-cell-tail rows
   at narrow and wide geometries.
2. Add test-only Ghostty observations sufficient to report visible rows,
   retained rows, native page bytes, replay bytes, and whether the earliest
   retained row survives a fresh parse. Do not expose diagnostic internals in
   the production API. Exercise the existing `Point::History`/selection
   formatter before proposing any dependency extension, including
   primary-history access while alternate screen is active.
3. Extend `research/20260809-124553-fut-tty/vt-proof` with:
   - deep-history reconstruction;
   - ordered resize markers with output immediately on both sides;
   - relative movement at a wrap boundary;
   - an absolute-position redraw that must converge; and
   - theme, tab-visibility, and xterm-model-recreation scenarios; and
   - recovery while alternate screen is active, followed by exit back to
     primary, proving retained primary history and both buffers survive.
4. Add `core/frontend/terminal/tests/terminalContinuityBaseline.test.ts` around
   `TerminalView` or its extracted seams to count attach, detach,
   replay-install, reset, and resize calls. Register it in `ops/test/justfile`.
5. Capture current JSON output/replay/input payload size and allocation data in
   a checked-in benchmark result next to the proof harness. Record hardware,
   build mode, payload corpus, and command.
6. Run the retention corpus across narrow-to-wide and wide-to-narrow resize.
   Record whether the effective byte cap survives reflow and whether the pinned
   binding exposes a post-construction cap setter or complete-row trim.
7. Record replay size with palette/default formatting enabled and disabled.
   Keep a child-authored palette/default fixture that proves whether application
   overrides can be separated from app-theme defaults.
8. Freeze the mandatory memory-safety byte cap from measured supported
   geometry, content fixtures, and the terminal memory budget.
9. Obtain an explicit owner decision for the product row policy:
   - **fork:** add a narrow complete-row trim to Ghostty's C API, pin a Ghostty
     fork through a libghostty-rs fork, and physically enforce both bounds; or
   - **no fork (default if no fork is approved):** enforce the row setting in
     xterm and snapshot selection while Ghostty may retain extra rows within
     its byte cap.
   If privacy or data-erasure requirements demand physical live row removal,
   the no-fork branch is invalid and Phase 06A must wait for fork approval.
10. Specify—without implementing—the new Phase 06A settings path:
    `workspace/config` normalization -> persistence -> `TerminalService` policy
    revision -> new/running runtime actors -> canonical save response ->
    frontend store/xterm. In the fork branch a live reduction physically trims;
    in the no-fork branch it narrows xterm and future snapshot selection but
    cannot erase extra host rows. Increases never restore physically evicted
    rows.
11. Define internal retention observations that distinguish physical
    `host_eviction` (`none`, `byte_limit`, or fork-only `row_limit`) from later
    snapshot omission. Do not imply exact host row enforcement in the no-fork
    branch.
12. Record the byte-cap value and derivation. Do not relabel a guessed byte
    multiplier as a guaranteed number of rows. Freeze the backend-owned
    admissible row domain—bounded range or exact preset set—and its canonical
    normalization behavior for persisted and IPC input. Defer implementation in
    `normalize_terminal_settings()` to Phase 06A.
13. If H5 is confirmed, add a narrowly scoped Phase 04 task keyed to the ordered
    resize generation and exact byte signature from the trace. Use a timer only
    if a deterministic generation boundary is proven impossible, and then base
    it on a recorded timing distribution. If H5 is false, record suppression as
    out of scope.
14. Freeze the conditional cell-renderer parity matrix from Herdr's proven
    boundary: semantic cells/cursor/links, dirty rows, host viewport/search,
    structured input encoding, hidden parse without render, reliable control,
    replaceable derived frames, and grapheme-mode reset survival. This is a
    decision artifact only; Phase 01 adds no renderer implementation.

## Acceptance criteria

- Tests state definitively whether the current formatter contains retained
  history and fail if that behavior changes unintentionally. They separately
  state whether the existing selection API can read a bounded primary-history
  range while primary and alternate screens are active.
- The `max_scrollback` unit mismatch is reproduced against the pinned revision,
  Shipctl-owned symbols do not describe the current `1_000` as a line count,
  and the known upstream generated C/Rust documentation error is called out at
  every local API boundary that could mislead a maintainer.
- The C header/generated binding unit error and the authoritative Zig byte
  behavior are both recorded; neither API documentation layer is treated as
  independent confirmation.
- The fork/no-fork decision names its owner, physical retention semantics,
  update behavior, maintenance cost, and fallback. Phase 06A can proceed on the
  no-fork path unless physical row erasure is a product requirement.
- The row-policy specification names `workspace/config.rs` and
  `normalize_terminal_settings()` as the sole validation authority. The panel
  is a selector only, and Phase 01 changes no production normalizer behavior.
- The missing running-runtime settings route is captured as new Phase 06A
  machinery with named source, persistence, service, actor, response, and
  renderer boundaries; it is not sized as an existing channel modification.
- The known resize divergence has an exact fixture and an explicit pass/fail
  product gate. Phase 04 does not start if the gate rejects convergence.
- Every current destructive boundary has a failing regression test ready for
  the later phases to make pass.
- Baseline IPC size/allocation results are reproducible from a documented
  command; no performance threshold is invented without those measurements.
- Resize-retention tests prove the byte cap survives reflow and identify the
  exact missing C API operation required only by the fork branch.
- Palette measurements distinguish app-theme defaults from child-authored
  overrides; no theme-portable replay decision relies only on total byte size.
- H5 resolves to either a reproducible failing fixture or a documented
  out-of-scope decision.
- H9 has an executable characterization proving whether a running host runtime
  observes a saved row-policy change before Phase 06A.
- The conditional single-parser path has a named capability and validation
  matrix, so an H4 failure opens a bounded architecture program rather than an
  unspecified renderer rewrite.

## Validation

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::replay
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalContinuityBaseline.test.ts
./research/20260809-124553-fut-tty/vt-proof/run.sh
just test fast
git diff --check
```

## Exit condition

Commit no production behavior change in this phase. Stop and reopen the
architecture decision if H4 shows persistent supported-state divergence after
absolute redraw; otherwise freeze the README contract and continue to Phase 02.
