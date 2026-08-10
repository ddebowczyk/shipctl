# Ghostty semantic contract and retention are proven

## Outcome

Prove with executable fixtures that the pinned Ghostty dependency can be
Shipctl's sole terminal authority, close every identified semantic gap, and
ship an honest host-retention correction before investing in the replacement
surface.

This is a falsification phase. Failure stops the single-VT implementation and
returns evidence for an owner decision; it does not quietly preserve two
parsers as the architecture.

## Context and purpose

The single-VT destination is only credible if the host can expose all state and
behavior that xterm currently supplies. Public type names are not proof. In
particular:

- Ghostty exposes render snapshots and dirty facts, but Shipctl still needs an
  owned semantic projection and later a revisioned delta contract;
- Ghostty recognizes OSC 9, but the pinned Rust surface does not expose the
  notification payload through terminal effects;
- selection ranges and gestures exist in the binding, but have not been
  exercised through Shipctl's serialized runtime;
- history lookup can traverse Ghostty's page list and must not be assumed safe
  in a render loop without measurement; and
- `max_scrollback` is a byte heuristic documented incorrectly as lines by the
  Rust binding.

The last point is already source-proven. Shipctl's
`MAX_SCROLLBACK_LINES = 1_000` is passed as a byte value. Ghostty computes the
effective maximum as the greater of that explicit value and a
geometry-derived minimum required by its page store. The current value is
normally below that floor and therefore inert. The frontend's row setting is
not connected to the runtime. The existing symptom must not be described as
“one kilobyte of retained history”; the actual defect is that Shipctl does not
control host retention at all.

## Affected areas

- `core/backend/src/terminal/replay.rs`, which currently combines Ghostty
  ownership with ANSI replay and the inert retention constant;
- `core/backend/src/terminal/runtime.rs`, `service.rs`, `types.rs`, and a new
  owned semantic projection module;
- workspace terminal settings and
  `core/frontend/terminal/useTerminalSettingsStore.ts` for the chosen retention
  contract;
- the pinned `libghostty-vt` / `libghostty-vt-sys` dependency and its
  compatibility fixtures;
- terminal corpus fixtures and operations test registration; and
- the capability inventory consumed by areas 2 and 4.

## Work to be done

### 1. Freeze the required semantic inventory

Turn the capability list in [end-state.md](end-state.md) into checked-in
fixtures and an explicit source-to-contract matrix. For every fact, record the
Ghostty API or dependency extension that supplies it and the current xterm
behavior that establishes parity.

Cover active and alternate screens; cell graphemes, combining characters,
wide and continuation cells; styles and color forms; hyperlink URI and cell
extent; wrap continuation; cursor state; modes required by interaction and
input; application defaults versus child-owned palette changes; title,
working directory, bell, clipboard, notification, and lifecycle effects;
selection; and retained history.

Do not claim search parity unless a current integration or approved product
requirement is found. Record that Shipctl does not enable xterm's live-region
screen-reader mode; current parity is the labelled focusable input, keyboard
access, and IME behavior.

### 2. Build an owned Ghostty-to-domain projection

Add a backend-only projection that copies Ghostty render state into owned,
parser-independent domain values. The projection must not expose FFI pointers
or Ghostty lifetimes across the runtime actor boundary.

Exercise complete snapshots across ordinary output, erase and insert/delete
operations, wrapping and reflow, resize, alternate-screen entry/exit, palette
changes, cursor changes, hyperlinks, and retained-history navigation. Prove
which mutations invalidate a dirty baseline. Treat dirty rows as observations;
do not yet encode them as an assumed wire format.

### 3. Close ordered effect gaps

Inventory Ghostty effect callbacks against current Shipctl behavior. Extend
the owned dependency/binding where a required payload is unavailable. OSC 9
desktop-notification text is the known gap.

A bounded host-side side-effect decoder is acceptable only if it has one
explicit responsibility, consumes the same ordered PTY ingress before bytes
are discarded, cannot mutate VT state, and is approved as less costly to own
than the dependency extension. The frontend must not parse OSC under either
branch.

### 4. Prove host-owned input and selection semantics

Run the pinned key, mouse, and paste encoders against mode-changing fixtures,
including application cursor/keypad state, kitty keyboard flags,
`modify_other_keys`, bracketed paste, mouse tracking formats, and supported
macOS option behavior. Device replies and other terminal-generated PTY writes
remain serialized by the runtime actor.

Exercise Ghostty's selection gesture state machine for press, drag, release,
word, line, rectangular behavior where supported, extension, and autoscroll.
Prove selection formatting across wrapped, wide, combining, and history cells.
The later browser surface supplies pixel-to-cell positions; it does not
reimplement these semantics.

Custom keybinding presets remain explicit application commands. Decide their
host command shape here so they cannot reopen a general raw-byte input path.

### 5. Measure and repair retention

Replace the misleading constant and record the actual Ghostty rules from the
pinned Zig source in the dependency compatibility fixture. Measure retained
rows and bytes across the supported terminal geometries and representative
content classes, including styled and grapheme-heavy output. Measure history
window extraction separately from live screen projection.

Use the evidence to close the product retention decision:

- if the promise is an exact configured row count, own a dependency branch
  that exposes row-based trimming and prove it; or
- if the promise is byte retention, expose that contract honestly and derive
  the configured byte value from the selected policy and measurements.

Wire the selected canonical setting through `TerminalService` into every new
runtime. The pinned API consumes `max_scrollback` only during `Terminal::new`;
it exposes retained-row facts but no runtime limit setter. Close the
product-visible lifecycle choice using one real branch:

- disclose that retention-setting changes apply only to terminals created
  afterward; or
- extend the owned dependency with a runtime limit change and prove it
  preserves existing history.

Destroying and rebuilding Ghostty would erase the history the setting exists
to preserve and is not an implementation branch. Test the selected behavior
through the service and settings UI rather than inferring it from a React store
update. The correction may ship as soon as this contract is closed and does
not wait for the cell renderer.

No byte value, row limit, conversion ratio, or runtime-change policy may be
invented in this plan. Each comes from the approved product contract,
Ghostty's technical requirements, or recorded measurement.

### 6. Own the dependency branch

Check in a compatibility fixture that fails when a Ghostty update changes any
API or behavior this architecture depends on: render projection, dirty
invalidation, effects, input encoders, selection, history, and retention.

Choose pinned upstream, vendored release, or fork from the measured gaps and
the retention decision. If Shipctl patches OSC effects or row trimming, the
selected branch must be reproducible and updateable in-tree; a transient Cargo
checkout is not dependency ownership.

### 7. Publish the spike record and stop decision

Record the corpus, source mapping, measurements, missing behavior, chosen
dependency branch, and named approvals. Stop before area 2 if a current-product
capability cannot be represented, input cannot remain host-authoritative,
history cannot meet the selected contract, or required dependency maintenance
is rejected by its owner.

## Acceptance criteria

- Executable fixtures prove every host-owned semantic fact named in the end
  state, including alternate screen, reflow boundaries, palette state,
  hyperlink metadata, cursor state, effects, input modes, selection, and
  history.
- The owned projection contains no ANSI and no borrowed FFI state after the
  actor operation completes.
- Dirty-state fixtures identify full-baseline invalidations and do not mistake
  Ghostty dirty flags for a complete subscriber delta protocol.
- OSC 9 notification text and every other supported effect are available as
  ordered host domain events without frontend OSC parsing.
- Mode-aware key, mouse, paste, terminal reply, selection, and copy behavior
  pass the checked-in corpus.
- The inert `1_000` constant and the false line naming are gone; the selected
  retention policy reaches every new runtime and its behavior is measured.
- Exact-row retention is claimed only if an owned row-trim implementation
  proves it. Otherwise the product exposes the approved byte contract.
- The retention-promise, running-update, and dependency-branch register rows
  in [end-state.md](end-state.md) are closed with evidence, date, and named
  approvers.
- Every new runtime receives the selected retention policy. A setting change
  either applies only to later terminals with that scope visible to the user,
  or uses a proved dependency extension without discarding existing history.
- A dependency compatibility test fails on semantic or retention drift.
- The spike record either authorizes area 2 or stops with a reproducible
  falsifying case; it cannot produce an unrecorded dual-parser fallback.

## How to validate

Add focused Rust fixtures for projection, effects, input, selection, history,
and retention, plus a dependency compatibility lane. Run them against the
exact dependency artifact used by the application, not a separately installed
Ghostty version.

Validate the early retention correction in a packaged application by producing
history with ordinary, styled, wide, and combining content; changing geometry;
restarting new terminal sessions; and observing the selected setting lifecycle.

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal
just test rust
just test full
just build app
markdownlint docs/plans/top-5-single-vt-closure/*.md
git diff --check
```
