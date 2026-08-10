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

An independent project reached the same conclusion and acted on it. herdr
(`~/projects/_ext/herdr`) embeds the same library and names the setting
`scrollback_limit_bytes: usize` (`src/config/model.rs:941-943`, default
10,000,000 at `src/config.rs:50`) with `#[serde(alias = "scrollback_lines")]`
— it *had* the lines-named key and renamed it, keeping the old spelling as a
parse alias. Its constructor parameter is `max_scrollback` and its committed
test is `max_scrollback_limit_bytes_retains_more_history_for_larger_limits`
(`src/ghostty/mod.rs:3645`). That alias is also the migration recipe for
shipctl's `TerminalSettings.scrollback`: rename the field to its true unit and
accept the old key rather than silently reinterpreting a stored number.

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

**The setting reaches the backend already — just not this capability.** An
earlier draft of this phase said it "reaches only xterm". That was wrong.
`scrollback` appears in the backend at exactly two sites, both in `workspace`
(`config.rs:148-149,166-168,187`); `terminal` never reads it, and
`replay.rs:37` uses its own constant instead. The remaining work, precisely:

- **persistence exists.** `get_terminal_settings` / `save_terminal_settings`
  (`terminal/commands.rs:160-175`) already round-trip the value through
  `WorkspaceManager`, and `terminal/commands.rs:15-16` already imports both
  `WorkspaceManager` and `TerminalSettings` — so no new capability boundary is
  crossed and the modularity gate is not at issue.
- **the launch path does not carry it.** `TerminalLaunchRequest`
  (`types.rs:362-370`) has `target`, `cwd`, `environment`, `columns`, `rows`,
  `color_theme`, `metadata` — no scrollback. Either add the field or have
  `TerminalService::spawn` read it from `WorkspaceManager`; pick one owner and
  state it.
- **validation is missing.** `normalize_terminal_settings`
  (`workspace/config.rs:195-197`) normalizes **only** `url_allowlist`, so
  `scrollback` is an unvalidated `u32` straight from IPC. Extend that
  normalizer — adding a second validator inside `terminal` would recreate the
  two-owners defect this phase exists to remove.
- **no live-update channel exists at all, and the VT has no setter to call at
  the end of one.** `save_terminal_settings` persists and returns; the frontend
  store calls `applyTerminalSettings` (`useTerminalSettingsStore.ts:45,77`),
  which reaches xterm and nothing else. Below that, `max_scrollback` is a
  **construction argument only** — H1.4 finds no post-construction setter, and
  herdr confirms it by design: `scrollback_limit_bytes` is a parameter of
  `spawn`, `spawn_with_initial_history` and `from_handoff_fd`
  (`src/terminal/runtime.rs:65,90,119`) and appears nowhere else; a config
  reload writes `state.pane_scrollback_limit_bytes` (`src/app/mod.rs:1524`),
  which only reaches panes spawned afterwards. Live panes keep the budget they
  were born with.

  So "a reduction trims immediately" is not one piece of missing plumbing. It
  is either **out of scope** — the setting applies to terminals created after
  it, which is what the one shipping reference does — or it means **rebuilding
  the VT** from its own replay at the new budget, which is a different and much
  larger claim that must be stated as such. Pick one and say which. An increase
  applies to future output and cannot restore evicted rows either way.

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
commit `ab0b9da9e88fcb4b0533a1854e84628f663930af` and builds it with Zig.

**Be precise about what that costs, because an earlier draft overstated it.**
Zig is *already* a build requirement: `build.rs` invokes `zig build`
unconditionally (`:130,171`) and offers no prebuilt-library path — only
`GHOSTTY_SOURCE_DIR`, `GHOSTTY_ZIG_SYSTEM_DIR` and
`LIBGHOSTTY_VT_SYS_OPTIMIZE` overrides. Shipctl builds Ghostty from source
today. So exposing `eraseHistory` adds **no new toolchain**; it adds
maintenance of two forks — Ghostty and `libghostty-rs` — and the obligation
to rebase both onto upstream. `GHOSTTY_SOURCE_DIR` is the seam a fork would
use, which makes the mechanics cheap and the ongoing ownership the real
cost.

**And "fork" is not the only way to own the dependency.** herdr does not
depend on `libghostty-rs` at all. It vendors a *released distribution archive*
of libghostty-vt into `vendor/libghostty-vt/` (`vendor/libghostty-vt.vendor.json`
records `1.3.2-HEAD-+c5a21edfc` and its source commit), writes its own
`src/ghostty/bindings.rs` and safe wrapper, and builds the vendored tree with
`zig build` from its own `build.rs`. That removes the rebase treadmill — there
is no fork branch tracking upstream, only a version bump when the project
chooses one — at the price of owning the bindings shipctl currently gets from
`libghostty-rs`. It is a real third position between A and B, and it is the one
the closest comparable project chose.

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
3. Get `TerminalSettings.scrollback` into `VtReplayEngine::new`, by one of the
   two owners named above. No `SCROLLBACK_LINES` literal appears in
   `replay.rs`: 10,000 is already declared once at
   `workspace/config.rs:166-168`, and re-declaring it inside the terminal
   capability is the same class of defect this phase exists to remove.
4. Extend `normalize_terminal_settings` to validate `scrollback` against the
   supported set. Extend it — do not add a validator inside `terminal`.
5. Decide what a settings change does to *running* terminals, and write the
   decision down. The default answer — the one herdr ships and the one the C
   API supports — is that the new budget applies to terminals created
   afterwards; running terminals keep theirs. Choosing that closes this task
   with a documented limit and a test. Choosing live application means building
   both a settings-change channel (`save_terminal_settings` today persists and
   returns, notifying nothing) *and* a VT rebuild, because no setter exists at
   any layer. That is a separate piece of work with its own risk, and it must
   be sized before it is promised, not discovered here.
6. Under option `A′` the byte figure is a **memory-safety cap**, independent
   of the row target — not a row count in disguise. It needs no per-content
   accuracy, only a defensible ceiling, and it is reported when it binds
   first.
7. Only if `A′` is rejected does a bytes-per-row multiplier become load
   bearing. In that case it must be measured across *content*, not just width:
   H1.2's ~9 B/col-row came from ASCII fixtures, and styled, wide-Unicode and
   hyperlinked cells cost more. A single multiplier derived from ASCII would
   silently under-retain exactly the content users most want to scroll back
   to. Measure the worst supported case and derive from that, or state the
   guarantee as approximate.
8. Assert the outcome: a test proving the configured row target survives at
   the construction width for each supported setting value, or that the
   memory cap bound first and said so.

## OPEN DECISION (owner)

If H1.3 fails — a widening resize silently shrinks retention and the binding
cannot re-assert the budget — there are three sound options, and the choice is
the owner's, not the implementer's.

**Read H1.4 first: this is not a choice between implementation styles. It is a
choice about whether shipctl owns its VT dependency.** Every option built on a
row trim requires the Zig-level change described there. That cost belongs in
the question, not discovered during implementation. H1.4 also shows the cost
has two shapes — a tracked fork, or a vendored release with in-tree bindings —
and they price very differently.

- **A.** Fork Ghostty to expose `eraseHistory`, fork `libghostty-rs` on top,
  and adopt openmux's model: unlimited byte budget, line trim enforced by
  shipctl on write and resize. Correct at any width and any content.
  **Cost:** two pinned forks and ownership of rebasing both onto upstream —
  not a new toolchain, since Zig already builds Ghostty here.
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
- **C.** A or A′, delivered herdr's way: vendor a released libghostty-vt
  archive plus the one added entry point, and carry the bindings in-tree
  instead of depending on `libghostty-rs`. Same capability as A, with no branch
  to rebase — version bumps happen when shipctl chooses one. **Cost:** shipctl
  owns the FFI surface it currently gets for free, plus a `build.rs` of its own.

Do not select by intuition, and do not present A′ as the cheap middle option:
on capability it sits with A, not between A and B. Present the H1.2/H1.3
measurements *and* the dependency-ownership cost together, pricing C's
vendoring separately from A's fork — they are not the same bill. If the owner
declines to own the dependency at all, B is the answer and the settings copy
changes with it — a product decision, not an implementation detail to absorb
silently.

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
- The task-5 decision is testable either way, and the test asserts against
  `scrollback_rows()` rather than the persisted value — persisting was never
  the gap. Under the default decision: the next terminal spawned after a change
  retains at the new budget while a running one is unaffected, and the settings
  UI says so. Under live application: a reduction trims a running terminal's
  retained rows, and an increase changes only future retention and reports that
  evicted rows are unrecoverable.
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
