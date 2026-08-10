# Phase 01 — Scrollback retention budget

## Objective

Make the host retain the history the renderer is configured to show. Today it
retains about one kilobyte.

## Context

`core/backend/src/terminal/replay.rs`:

```rust
// This is the configuration exercised by the host-canonical replay proof. It
// is retained as evidence-backed parser behavior, not a subscriber buffer.
const MAX_SCROLLBACK_LINES: usize = 1_000;   // :21

let mut terminal = Terminal::new(TerminalOptions {
    cols, rows,
    max_scrollback: MAX_SCROLLBACK_LINES,     // :37
})
```

`max_scrollback` is a **byte** budget (Ghostty `Screen.zig`: "The maximum size
of scrollback in bytes. Zero means unlimited."). The name, the comment, and
the binding's own doc string all say lines. The value is off by roughly three
orders of magnitude for its apparent intent.

The configured history is `10000`, and it is **already a backend value**:
`core/backend/src/workspace/config.rs:148,166-168` declares
`TerminalSettings.scrollback: u32` with `default_scrollback() -> 10000`. So the
backend holds two different retention numbers in two different units — 10,000
"lines" in `workspace`, 1,000 bytes-labelled-lines in `terminal` — and the
terminal capability reads the wrong one. The host must not be the tighter of
the two, or the setting is silently a lie.

**Retention is user-selectable, not a constant.**
`core/frontend/shell/SettingsPanel.tsx:517` offers
`[1000, 5000, 10000, 25000, 50000]`, labelled "Number of lines kept in the
terminal scroll buffer." So the host budget is a function of a live setting.

**The plumbing already exists; only the last hop is missing.** An earlier
draft of this phase said the setting "reaches only xterm". That was wrong, and
the correction shrinks the work:

- the value already crosses IPC and is persisted —
  `get_terminal_settings` / `save_terminal_settings`
  (`core/backend/src/terminal/commands.rs:160-175`) through `WorkspaceManager`;
- `terminal/commands.rs:15-16` already imports `WorkspaceManager` and
  `TerminalSettings`, so no new capability boundary is crossed and the
  modularity gate is not at issue — the value must be threaded from
  `commands.rs` through `TerminalService::spawn` and the runtime into
  `VtReplayEngine::new`;
- `normalize_terminal_settings` (`workspace/config.rs:195-197`) normalizes
  **only** `url_allowlist`. `scrollback` is an unvalidated `u32` straight from
  IPC, so validation against the supported set is a real gap — extend the
  existing normalizer rather than adding a second validator;
- a live *reduction* trims immediately; a live *increase* applies to future
  output and cannot restore already-evicted rows, and must say so. There is no
  live-update path today: `save_terminal_settings` persists and returns, and
  nothing notifies a running terminal.

**Two bounds, not one.** The row count is the product policy; a byte cap is
memory safety. They are different facts with different authorities, so keep
both, let whichever is reached first win, and record which one evicted. A
single derived byte budget silently converts a product promise into a
width-dependent guess.

## Hypotheses to verify

Each hypothesis is settled by a committed test, not by reading. State the
measured numbers in the test's assertion comment.

**H1.0 — the replay reconstructs retained history, not just the active
screen.** This plan's diagnosis rests on it and it was measured during
investigation (a dump of `engine.replay()` contained history rows), but no
committed test holds it. An unproven claim is not a settled one, and a future
formatter change could silently invert it.
Method: write uniquely numbered rows until history exceeds one viewport,
replay into a fresh parser, and assert the earliest retained row is present.
Falsifier: only the visible grid is reconstructed — the whole plan reverts to
Expert 1's premise and phase 09 grows a formatter extension.

**H1.1 — `max_scrollback` is measured in bytes.**
Method: build two `VtReplayEngine`s at identical `cols`/`rows`, differing only
in budget (e.g. `1_000` and `10_000_000`), feed each an identical stream of
20,000 distinct lines, compare `scrollback_rows()`.
Falsifier: retained row counts are equal, or scale with the budget as if it
were a line count (budget 1,000 → 1,000 rows at every width).

**H1.2 — retained rows ≈ budget ÷ (cols × k), with k constant across widths.**
Method: same harness at 80, 120, and 200 columns for a fixed budget.
Prior measurement (to be reproduced, not assumed): a 10 MB budget retained
14,061 rows at 80 cols, 9,279 at 120, 5,453 at 200 — i.e. k ≈ 8.9, 9.0, 9.2
bytes per column-row.
Falsifier: k varies by more than the page-quantization step across widths, in
which case a per-width derivation is unsound and phase escalates to H1.4.

**H1.3 — the effective budget survives `resize`.**
Method: fill history at 80 cols, record `scrollback_rows()`, call
`VtReplayEngine::resize` to 200 cols, record again without feeding more data.
Why it matters: openmux re-asserts `pages.explicit_max_size` after every
resize (`lifecycle.zig:206-213`) precisely because Ghostty recomputes the
budget during resize. The pinned Rust binding offers **no** post-construction
setter, so if this hypothesis is falsified the budget cannot be maintained.
Falsifier: retained rows drop by more than the reflow itself accounts for.

**H1.4 — no line-based trim exists at any layer, and adding one means forking
Ghostty.**
Surveyed at `libghostty-rs` rev `72ac98f`, both layers:

- Rust API: `resize`, `scroll_viewport`, `scrollbar`, `scrollback_rows`,
  `total_rows`. No `erase_history`, no `set_max_scrollback`.
- C API (`crates/libghostty-vt-sys/src/bindings.rs`): the only
  scrollback-mutating entry points are `max_scrollback` at construction
  (`:2030`), a full RIS reset (`:2485`), and opportunistic compression
  (`:2522`, which explicitly "never changes … its logical contents or
  scrollback limit"). No trim, no post-construction cap setter.

So the trim is missing *upstream*, not merely unwrapped.
`crates/libghostty-vt-sys/build.rs` clones `ghostty-org/ghostty` at pinned
commit `ab0b9da9e88fcb4b0533a1854e84628f663930af` and builds it with **Zig**.
Exposing `eraseHistory` therefore means patching Ghostty in Zig, pinning that
fork, forking `libghostty-rs` on top of it, and carrying a Zig toolchain in
shipctl's build and CI. openmux can take this route only because it vendors
its own Zig wrapper; shipctl consumes a prebuilt binding.

Record this in the code comment so the next reader does not re-derive it.
Falsifier: such a symbol exists after all, in which case prefer openmux's
design (unlimited byte budget, explicit line trim after each write) over any
byte arithmetic — at the ordinary cost of a binding bump rather than a fork.

## Tasks

1. Add `#[cfg(test)] mod tests` to `replay.rs` with the harness described
   above (feed N numbered lines, read `scrollback_rows()`, reconstruct into a
   fresh parser), and land H1.0–H1.3 as tests. They are the deliverable, not
   scaffolding.
2. Rename the constant to `MAX_SCROLLBACK_BYTES` and replace the misleading
   comment with the units fact and its source
   (`ghostty-src/terminal/Screen.zig`, "in bytes").
3. Thread the existing `TerminalSettings.scrollback` from `commands.rs`
   through `TerminalService::spawn` and the runtime into `VtReplayEngine::new`.
   No `SCROLLBACK_LINES` literal appears in `replay.rs`: 10,000 is already
   declared once at `workspace/config.rs:166-168`, and re-declaring it in the
   terminal capability is the same class of defect this phase exists to
   remove. Add the missing pieces only — `scrollback` validation in
   `normalize_terminal_settings`, and a change path so a live reduction trims
   immediately while an increase applies to future output and reports that
   evicted rows cannot be restored.
4. Under option `A′` the byte figure is a **memory-safety cap**, independent
   of the row target — not a row count in disguise. It needs no per-content
   accuracy, only a defensible ceiling, and it is reported when it binds
   first.
5. Only if `A′` is rejected does a bytes-per-row multiplier become load
   bearing. In that case it must be measured across *content*, not just width:
   H1.2's ~9 B/col-row came from ASCII fixtures, and styled, wide-Unicode and
   hyperlinked cells cost more. A single multiplier derived from ASCII would
   silently under-retain exactly the content users most want to scroll back
   to. Measure the worst supported case and derive from that, or state the
   guarantee as approximate.
6. Assert the outcome: a test proving the configured row target survives at
   the construction width for each supported setting value, or that the
   memory cap bound first and said so.

## OPEN DECISION (owner)

If H1.3 fails — a widening resize silently shrinks retention and the binding
cannot re-assert the budget — there are three sound options, and the choice is
the owner's, not the implementer's.

**Read H1.4 first: this is not a choice between three implementation styles.
It is a choice between forking Ghostty and not forking Ghostty.** Every option
built on a row trim requires the Zig-level fork described there. That cost
belongs in the question, not discovered during implementation.

- **A.** Fork Ghostty to expose `eraseHistory`, fork `libghostty-rs` on top,
  and adopt openmux's model: unlimited byte budget, line trim enforced by
  shipctl on write and resize. Correct at any width and any content.
  **Cost:** two pinned forks, a Zig toolchain in the app build and CI, and
  ownership of rebasing both onto upstream Ghostty.
- **B.** No fork. Accept a per-terminal memory budget as the policy (cmux
  states 50 MB per terminal for this reason) and change the renderer setting's
  documented meaning from "lines retained" to "lines shown, subject to a
  memory cap". Cheap and shippable immediately; makes the retained-row
  guarantee width- and content-dependent, and changes settings copy.
- **A′.** A's row trim *plus* a retained, measured byte cap — openmux's
  mechanism without openmux's unlimited budget. The row trim honours the
  user's 1k–50k choice at any width; the byte cap independently bounds memory
  and may retain fewer rows, which the host reports. It keeps the settings
  label honest without giving up a memory bound, and the parallel review
  converged on it independently — **but it inherits A's fork in full**, since
  the row trim is precisely the forked capability.

Do not select by intuition, and do not present A′ as the cheap middle option:
on cost it sits with A, not between A and B. Present the H1.2/H1.3
measurements *and* the fork cost together. If the owner declines the fork, B is
the answer and the settings copy changes with it — a product decision, not an
implementation detail to absorb silently.

## Acceptance criteria

- No constant in `replay.rs` names a unit it does not use.
- Every numeric literal introduced carries its authority in a comment: a
  project setting, or "measured, see `tests::…`".
- A test fails if the host retains fewer rows than the renderer's configured
  scrollback at the construction width, without reporting that the memory cap
  bound first.
- No scrollback row count is hardcoded in the terminal capability; the value
  resolves to the one `workspace/config.rs` declaration.
- `normalize_terminal_settings` validates `scrollback` against the supported
  set, with a test for an out-of-set value arriving over IPC.
- If the chosen option is B, the `SettingsPanel` copy changes in the same
  commit as the budget; label and behaviour never disagree.
- A committed test holds H1.0, so a formatter change cannot silently stop
  replaying history.
- H1.3's outcome is recorded in the module (comment or test name), whichever
  way it resolves.

## Validation

```sh
just test rust          # cargo test --workspace, includes the new replay tests
```

Manual confirmation: run a terminal, emit several thousand lines, scroll back,
switch tabs and return. History depth before and after the change is the
observable.

## Out of scope

Reducing how *often* the replay is produced (phases 06-08), and reducing
its *size* on the wire (phase 03). This phase changes only what the host
retains.
