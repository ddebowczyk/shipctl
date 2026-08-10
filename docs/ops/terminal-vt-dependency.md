# Terminal VT dependency — Ghostty

Shipctl's terminal capability parses PTY bytes with `libghostty-vt`. The
single-VT end state makes that dependency the *only* VT authority: screen
state, history, effects, selection, and input encoding all come from it, and
xterm.js stops being a parser.

This page records the go/no-go result for that decision, the gaps it leaves
open, and the ownership and upgrade contract for the dependency.

The evidence is executable and lives in the code:

| Evidence | Location |
|---|---|
| Semantic compatibility corpus | `core/backend/src/terminal/compat.rs` |
| Measured retention behavior | `core/backend/src/terminal/retention.rs` |
| Replay round-trip proof | `research/20260809-124553-fut-tty/vt-proof/` |

## Verdict: **feasible**

Against revision `72ac98f292879bf9f788fcbb11238c562a1eebe6`, the safe public
API exposes every terminal fact, effect, encoding, and selection the product
needs, as values that can be copied into Shipctl-owned memory before the call
returns. One narrow ownership extension is required (OSC 9 payload, below).
Nothing in the inventory depends on unsafe bindings, on undocumented behavior,
or on reading ANSI formatter output.

The formatter stays where it is today — the replay transport in
`core/backend/src/terminal/replay.rs` — and is not part of the future semantic
read boundary. The compensations that file carries (blank wrap continuations,
per-cell hyperlink reprints, cursor-cell restoration) exist because the
*formatter* cannot express those states in a byte stream. The semantic API
expresses all three directly, which is one of the reasons the end state removes
the formatter from the read path.

### Inventory and evidence

Every row is a test in `core/backend/src/terminal/compat.rs` unless noted.

| Required fact or operation | Evidence |
|---|---|
| Geometry, resize, active screen | `geometry_and_active_screen_are_readable_and_mutable` |
| Alternate screen preserves primary | `the_alternate_screen_leaves_the_primary_screen_intact` |
| Retained history is addressable as cells | `retained_history_is_addressable_as_cells` |
| Rows, cells, graphemes, widths, styles, resolved colors | `the_render_snapshot_carries_text_widths_styles_and_colors` |
| Wide graphemes, spacer cells, combining marks, width measurement | same test, plus `libghostty_vt::unicode` |
| Soft wrap and continuation rows | `soft_wrap_and_continuation_rows_are_distinguishable` |
| Reflow across resize, both directions | `reflow_preserves_content_across_a_resize` |
| Cursor position, visibility, style, pending wrap | `cursor_position_visibility_style_and_pending_wrap_are_readable` |
| Semantic prompt rows (OSC 133) | `semantic_prompt_marking_reaches_rows` |
| Child-owned palette and default colors (OSC 4/10/11) | `the_child_owns_the_palette_and_the_default_colors` |
| Per-cell hyperlink URIs (OSC 8) | `hyperlink_uris_are_readable_per_cell` |
| Mode state, including modes that change input encoding | `terminal_modes_are_queryable` |
| Ordered non-cell effects: title, pwd, bell, clipboard, PTY replies | `non_cell_effects_are_positioned_inside_one_write_with_owned_payloads` |
| Desktop notification (OSC 9) | **gap** — `the_desktop_notification_payload_is_not_exposed` |
| Mode-aware key and text encoding, Kitty keyboard flags | `key_encoding_follows_terminal_modes` |
| Paste encoding and paste safety | `paste_encoding_follows_bracketed_paste_mode` |
| Mode-aware mouse encoding, pixel-to-cell geometry | `mouse_encoding_follows_the_tracking_mode_and_format` |
| Focus reporting | `focus_events_encode_only_when_the_child_asked_for_them` |
| Word, line, range, and command-output selection, with copied text | `word_line_range_and_output_selections_produce_owned_text` |
| Copied facts outlive the FFI call | `facts_copied_out_stay_valid_after_the_terminal_moves_on` |
| `max_scrollback` retention behavior | `core/backend/src/terminal/retention.rs` (the single authority; the corpus deliberately does not restate it) |

## Gap ledger

### 1. OSC 9 desktop notification payload — open, owned

- **Required behavior.** Turn a coding agent's OSC 9 notification into a native
  desktop notification. The product does this today:
  `core/frontend/terminal/TerminalView.tsx` registers an xterm OSC 9 handler and
  calls `notifyAgent`. Removing xterm as the parser removes that handler, so the
  host must produce the payload instead.
- **Observed API limit.** The parser recognizes the command and nothing more.
  There is no `Terminal::on_*` callback for it, and
  `osc::CommandType::ShowDesktopNotification` carries no payload field. Proven by
  `the_desktop_notification_payload_is_not_exposed`, which asserts the limit and
  therefore fails when an upgrade closes it.
- **Smallest credible ownership branch.** A binding-only patch that exposes the
  existing OSC 9 payload through `libghostty-vt-sys` and one `on_*` callback —
  upstream first, carried as a narrow vendor patch if upstream declines. The
  payload is already parsed inside Ghostty; nothing new has to be implemented.
  The C API is already shaped for it: `ghostty_osc_command_data(command,
  data_kind, out)` is a generic accessor, and `GhosttyOscCommandData` defines
  one payload kind today (`CHANGE_WINDOW_TITLE_STR`) beside a reserved
  `MAX_VALUE`. The patch adds an enum value, a switch arm over parsed data, and
  a callback. It is additive and breaks no ABI.
- **Approved plan (2026-08-10).** Open the upstream change now, while nothing
  depends on it. Carry a local binding-only patch only if the single-VT closure
  removes xterm as the parser before the upstream change merges. Until then
  OSC 9 needs no patch at all, because the xterm handler in
  `core/frontend/terminal/TerminalView.tsx` still produces the payload.
- **Removal trigger.** `the_desktop_notification_payload_is_not_exposed` fails
  as soon as upstream exposes the payload. Follow step 5 of the upgrade
  procedure: delete this entry, the test, and any carried patch.
- **Owner task.** The patch design, the upstream contribution rules, and the
  steps are in [terminal-osc9-upstream-task.md](terminal-osc9-upstream-task.md).
  Ghostty's rules require a vouched human to submit it; an agent may prepare
  and explain the change but must not file it.
- **Not chosen: a Shipctl-side OSC 9 scanner.** Scanning the raw PTY stream in
  parallel with the parser recreates a second escape-sequence parser — the exact
  defect the single-VT end state removes.

### 2. Exact-row retention — closed by product decision, not by ownership

`max_scrollback` is a byte budget with a geometry-derived page floor and
page-granular eviction, and there is no complete-row trim in the public API. The
measurements are in `core/backend/src/terminal/retention.rs`. The product setting
was therefore defined as a byte budget rather than a row count, so no dependency
extension is required. The API's own naming and prose remain misleading; the
tests, not the prose, are the authority.

Approved 2026-08-10 by Dariusz Debowczyk: the product promises a byte budget,
not a row count. Retained rows now vary with line length and terminal width,
and no part of the product may state a row promise.

### 5. Running retention updates — closed by product decision

`Terminal` takes `max_scrollback` in `TerminalOptions` and exposes no setter
(`set_mode`, the default color and cursor setters, `set_apc_max_bytes`, and
`set_glyph_protocol_enabled` are the whole set). Rebuilding the parser to apply
a setting is not an accepted branch.

Approved 2026-08-10 by Dariusz Debowczyk: retention changes are
construction-only. `core/frontend/shell/SettingsPanel.tsx` states this to the
user. If upstream adds a setter that preserves retained history, the
`RetentionCommit { policy, revision }` in `TerminalService` is the seam that
carries it.

### 3. OSC 7 reports a URI, not a path — documentation defect, no extension

`Terminal::pwd()` returns exactly what the child sent (`file:///workspace`), not
a filesystem path. Converting it is the host's job. Recorded because the API
name suggests otherwise; asserted in the ordered-effects test so an upgrade that
changes the representation fails here.

### 4. Clipboard read — not required

`on_clipboard_write` covers OSC 52 writes, which the product may need. There is
no read-side callback, and no product requirement for letting a child read the
user's clipboard. Not a gap.

## Dependency ownership: **pinned upstream**

The public API satisfies the approved semantics, so the dependency stays a
pinned git revision. Vendoring is not selected: nothing in the ledger requires
owned source today, and vendoring as a precaution would add maintenance without
buying a proven need. Vendoring would also convert a bounded, deletable patch
into permanent ownership of the whole source. Gap 1 is the only extension in
scope, and it is a binding patch to be attempted upstream first.

Approved 2026-08-10 by Dariusz Debowczyk.

### Provenance

| Item | Value |
|---|---|
| Rust bindings | `https://github.com/uzaaft/libghostty-rs`, rev `72ac98f292879bf9f788fcbb11238c562a1eebe6` (crates `libghostty-vt` and `libghostty-vt-sys`, version 0.2.1) |
| Bindings license | `MIT OR Apache-2.0` (workspace); repository `LICENSE` is MIT, © 2026 Uzair Aftab, Leah Amelia Chen |
| Nested source | `https://github.com/ghostty-org/ghostty.git`, commit `ab0b9da9e88fcb4b0533a1854e84628f663930af`, pinned in `crates/libghostty-vt-sys/build.rs` |
| Ghostty license | MIT |
| Declared in | `core/backend/Cargo.toml`, locked in `Cargo.lock` |
| Features | `default-features = false` (static link; no Kitty graphics, no logging bridge) |

### Build path

`libghostty-vt-sys`'s build script clones the pinned Ghostty commit into
`OUT_DIR` and builds it with `zig build`, then links the resulting static
library. Consequences:

- A **Zig 0.16.x** toolchain is required to build this repository. The
  research proof enforces the same range.
- The **first** build for a given `OUT_DIR` needs network access to
  `github.com`. Later builds reuse the clone when the commit matches.
- `GHOSTTY_SOURCE_DIR` overrides the fetch with a local checkout, and
  `GHOSTTY_ZIG_SYSTEM_DIR` supplies Zig's package cache. Both are the levers to
  use if this build ever has to run offline.

### Hazards

- **The API is pre-1.0 and explicitly unstable.** Upstream states that breaking
  changes are expected. This is why the compatibility corpus is a gate rather
  than documentation.
- **Nothing is thread-safe.** Every type is `!Send` and `!Sync`. The runtime
  already respects this: `VtReplayEngine` is constructed inside the terminal
  runtime thread (`core/backend/src/terminal/runtime.rs`) and never crosses a
  thread boundary. Any future semantic transport must copy facts out rather than
  move the parser.
- **Grid references are borrows.** `GridRef`, `Selection`, `title()`, and
  `pwd()` are only valid until the next mutating call. No client, IPC, or
  transport type may hold one; the corpus proves the copies survive the calls
  that invalidate the borrows.
- **Documentation defects.** `max_scrollback` is bytes, not lines; `pwd()` is a
  URI, not a path. Both are pinned by tests.

## Updating the dependency

An upgrade changes a parser Shipctl depends on for correctness, so it is gated:

1. Change the `rev` in `core/backend/Cargo.toml` and update `Cargo.lock`.
2. Note the new nested Ghostty commit from
   `crates/libghostty-vt-sys/build.rs`, and confirm the license is unchanged.
3. Run the gate, in this order:

   ```sh
   cargo test --manifest-path core/backend/Cargo.toml terminal::compat
   cargo test --manifest-path core/backend/Cargo.toml terminal::retention
   cargo test --manifest-path core/backend/Cargo.toml terminal::replay
   ./research/20260809-124553-fut-tty/vt-proof/run.sh
   just test rust
   just check all
   ```

4. Read every failure as a behavior change, not as a broken test. Re-derive the
   constant or the expectation from the new measurement, and record why it
   changed. A retention constant in particular must be re-measured, never
   guessed.
5. If a gap in the ledger closed, delete its entry and the test that asserted
   the limit, and remove the workaround it justified.
6. Record the approval below.

## Owner

The approving owner for this dependency is the repository owner, Dariusz
Debowczyk. This working tree is the only deployment, so there is no separate
platform or security approver.

| Revision | Verdict | Approved |
|---|---|---|
| `72ac98f292879bf9f788fcbb11238c562a1eebe6` | feasible | Dariusz Debowczyk, 2026-08-10 |

Record each later revision as a row here. An unapproved row means the gate ran
but nobody accepted the behavior changes it reported.
