# Terminal fix plan — scrollback retention, attachment lifecycle, replay cost

## Why this plan exists

Five defects were reported against the terminal capability (D1 scrollback loss
on resize/theme, D2 JSON number-array IPC, D3 close/registry bookkeeping race,
S1 attachment protocol trapped in a React effect, S2 dual input-enablement
authority). Investigation changed the diagnosis materially:

- **The replay already contains scrollback.** `VtReplayEngine::replay()` emits
  history rows, not just the active screen. D1's stated premise is wrong.
- **The real loss is retention.** `core/backend/src/terminal/replay.rs:21`
  declares `MAX_SCROLLBACK_LINES: usize = 1_000` and passes it as
  `TerminalOptions.max_scrollback`. That field is a **byte budget**, not a line
  count. The host therefore retains roughly one kilobyte of history.
- **The reset frequency is worse than reported.** `TerminalView.tsx:237` bails
  on `!visible` and `:512` lists `visible` as an effect dependency, so a tab
  switch, settings overlay, or sidebar toggle runs the full detach/attach cycle
  through `installReplay`'s `term.reset()`.

Four reference implementations were examined (fut, cmux, openmux, herdr).
herdr is the closest comparable: a Rust terminal multiplexer built on the same
libghostty-vt parser, with a headless server whose panes keep running while
unattached. It is cited in phases 01, 03, 05, 06, 07 and 08. The
supporting evidence, measurements, and comparison live in
`research/` alongside this plan's dated notes; the conclusions that constrain
implementation are restated inline in each phase so no phase depends on
reading the research first.

## Units fact that drives phase 01

Ghostty's own source, vendored in openmux
(`ghostty-src/terminal/Screen.zig:252`):

```zig
/// The maximum size of scrollback in bytes. Zero means unlimited. Any
/// other value will be clamped to support a minimum of the active area.
max_scrollback: usize = 0,
```

The `libghostty-vt` Rust binding documents the same field as a line count —
and so does Ghostty's own C header, which the binding merely mirrors
(`crates/libghostty-vt-sys/src/bindings.rs:2030`, "Maximum number of lines to
keep in scrollback history"). The documentation is wrong at both layers, which
matters: a reader who checks the C API to double-check the Rust wrapper gets
the same wrong answer. cmux hit this and fixed it
(`GhosttyConfig.swift:60`, changelog "Fix scrollback-limit byte handling
(#2927)"); openmux side-stepped it by disabling the byte budget and enforcing
lines itself. herdr — which embeds the same library — hit it too and renamed
its setting `scrollback_limit_bytes`, keeping `scrollback_lines` as a parse
alias (`src/config/model.rs:941-943`). Three independent projects reached the
same conclusion; the documentation is the outlier, not the measurement.

## Phases

- **01 — `01-scrollback-retention-budget.md`.** Derive the host retention
  budget in the units the parser actually uses. Independent.
- **02 — `02-resize-clear-suppression.md`.** Evidence-gated: shell `CSI J` on
  SIGWINCH destroying history. The trace runs now; any implementation waits
  for 07, which supplies the generation the suppression should key on.
- **03 — `03-binary-ipc.md`.** D2 — raw binary replay and input instead of
  JSON number arrays, in one atomic frame, with the host attach asserted
  atomic. Independent.
- **04 — `04-attachment-controller-extraction.md`.** S1 — extract the
  attachment state machine from the React effect. **Pure refactor: no
  behaviour change.** Independent.
- **05 — `05-registry-and-input-authority.md`.** D3 and S2 — registry removal
  authority and a single input-enablement writer. These are behaviour changes
  and are kept out of 04 for that reason. Needs 04.
- **06 — `06-attach-visibility-decoupling.md`.** Stop tearing down the
  attachment when a tab is hidden, with an explicit hidden-overflow rule so
  the change cannot create reattach churn. Needs 04 and 05.
- **07 — `07-ordered-resize-and-local-reflow.md`.** Stop replaying on geometry
  change; sequence a `Resized` marker through a renderer queue barrier and let
  xterm reflow locally. Needs 04-06.
- **08 — `08-theme-ordering.md`.** Stop replaying on theme change; apply the
  palette through the same barrier and resolve the hidden-terminal hazard.
  Needs 07 for the barrier and 06 for the hidden case.
- **09 — `09-bounded-history-replay.md`.** Make the surviving recovery replay
  bounded and history-complete, reporting host eviction and snapshot
  truncation separately. Needs 07-08.
- **10 — `10-cutover-and-contract-update.md`.** Remove the legacy paths,
  correct the superseded contract documents, and close on production-adapter
  integration, release-mode performance, and a packaged-app pass. Needs all.

## Sequencing rationale

Phases 01 and 03 are small, independently shippable, and touch no shared
structure. Phase 01 alone recovers most of the history users currently lose.

Phase 04 is deliberately placed **before** the behaviour work and deliberately
holds none of it. It creates the test seam phases 05-09 need: today the
attachment protocol lives inside a React effect closure in `TerminalView.tsx`,
so attach/detach counts, sequence handling, and reset behaviour cannot be
asserted by any test. Doing 05 or 06 first would mean changing untestable
code — and putting D3 and S2 inside 04 would mean a refactor whose contract is
"nothing changes" shipping changes, which makes its own acceptance criteria
unfalsifiable. Hence the 04/05 split.

Phases 07 and 08 are the two ordered-event phases and share one mechanism, the
renderer queue barrier, built in 07. Phase 08 follows 07 because until the
geometry-driven replay is gone, dropping palette state from the replay would
regress every resize.

Phase 09 is late because the replay it bounds is only well-defined once 06-08
have reduced replay to the four recovery boundaries. Phase 10 is last by
definition: it removes what the earlier phases made dead and updates the
contract documents that still mandate the old model.

## Corrections adopted from the parallel review

A second plan was produced independently at
`docs/plans/20260809-191201-terminal-fix-sol/`. Six of its findings were
verified against the repository and folded into the phases above:

- **Ordering, not just removal.** Deleting the resize replay leaves a race:
  output read before and after the host's `TIOCSWINSZ` can parse at different
  geometries in the two emulators. A sequenced `Resized` marker plus a
  **renderer queue barrier** is required. Phase 07.
- **Theme is an ordered event too.** Child-authored OSC palette bytes share
  the stream, so a local theme apply must be a barrier, not a free-floating
  call. Phase 08.
- **Hidden terminals cannot take a theme.** `terminalTheme.ts:84-86` states
  that `options.theme` under `display: none` corrupts xterm's scroll state.
  Phase 06 makes this reachable; phase 08 resolves it.
- **Retention is user-selectable.** `SettingsPanel.tsx:517` offers
  1k/5k/10k/25k/50k lines, so the budget is a function of a live setting and
  needs two bounds (rows, bytes) with the binding one reported. Phase 01.
- **Input is two facts, not one.** Transport readiness and lifecycle write
  eligibility have different owners; merging them is the wrong fix. Phase 05.
- **The IPC envelope cannot stay JSON.** A JSON envelope plus a raw payload is
  not one atomic channel message, and below 1 KiB Tauri still expands raw
  bodies to a JSON array (`tauri-2.11.5/src/ipc/channel.rs:163-165`). Phase 03.

Two divergences are deliberate. That plan front-loads a no-production-change
evidence phase; this one keeps phases 01 and 03 independently shippable so the
retention fix — the largest single recovery of lost history — is not gated
behind the full contract freeze. And where that plan settles the retention
mechanism, this one keeps it an owner decision with a recommendation (`A′` in
phase 01).

## Second round of corrections

A further review of this plan raised nine gaps. Eight produced structural
changes, and the plan grew from seven phases to ten as a result:

- The replay-contains-history claim was measured but not held by any committed
  test. It is now **H1.0**, a regression test, so a formatter change cannot
  silently invert the premise the whole plan rests on.
- Phase 01's task sketch still hardcoded a row count and leaned on an
  ASCII-derived bytes-per-row multiplier. Both removed: the target comes from
  the live setting, and the multiplier only becomes load-bearing if the
  recommended option `A′` is rejected — in which case it must be measured
  against worst-case content, not ASCII.
- Phase 02 was sequenced to implement before the generation it wants to key on
  exists. Split into a trace now and an implementation after 07.
- Phase 03 gained an explicit atomic host attach — snapshot boundary,
  subscriber registration, first snapshot enqueue in one actor turn — stated
  and tested rather than inherited from the actor loop.
- Phases 04 and 05 were split, as described above.
- Phase 06 gained a designed hidden-overflow rule instead of a hypothesis:
  mark recovery pending, reject frames from the stale attachment while hidden,
  recover exactly once on reveal.
- Phase 07's rollback restored replay-on-every-resize — the original defect.
  It now keeps the ordering work, routes flagged divergences into phase 09
  recovery, and escalates rather than widening the fallback.
- Phases 08 and 09 were split: theme ordering and bounded history need
  different APIs, hypotheses, and rollback boundaries.
- Phase 10 was added for legacy removal, contract updates, production-adapter
  integration, release-mode performance, and the packaged-app pass.

## Third round — corrections from reviewing the parallel plan

Reviewing `20260809-191201-terminal-fix-sol` in detail produced six changes
here, five of them from agreeing with it and one from verification:

- **The retention decision is a fork decision.** Both plans proposed a
  row trim; verification showed no trim exists in the Rust API *or* Ghostty's
  C API, and `libghostty-vt-sys/build.rs` builds Ghostty from a pinned source
  clone with Zig — which shipctl already does, so the fork adds no toolchain,
  only ownership of two rebased forks. Options `A` and `A′` both require that;
  `B` is the only no-fork option.
  Phase 01's `OPEN DECISION` now says so instead of calling `A′` the cheap
  middle. This corrects a real understatement in the earlier draft. *Amended in
  the fourth round:* a tracked fork is not the only way to own the dependency —
  see option `C`.
- **Palette provenance is per slot and spans two families** — OSC 4 indexed
  entries and OSC 10/11/12 defaults behave differently under a later theme
  change. Adopted from the parallel plan's H8; phase 08's H8.2 covered only
  OSC 4.
- **Renderer mode is not palette.** `applyThemeToTerminals` also swaps the
  WebGL addon; that is presentation and must not enter the backend type or the
  ordered marker. Phase 08.
- **The hidden-palette pause is priced.** A theme change reaches every
  terminal, so a pause at the barrier can turn one theme change into N
  recoveries. Phase 08 now bounds and measures it rather than assuming it is
  an edge case. This applies equally to the parallel plan.
- **Ordered resize has a latency cost** — every drag frame now waits for a
  host round-trip. New H7.5 measures it, with a presentational mitigation and
  an explicit ban on reverting to optimistic local resize. Neither plan had
  this gate.
- **The scrollback setting already reaches the backend.** An earlier draft of
  phase 01 said it "reaches only xterm" and sized the work as end-to-end
  plumbing. An `ast-grep outline` pass showed `TerminalSettings.scrollback`
  declared and defaulted to 10,000 in `core/backend/src/workspace/config.rs`
  and persisted through `terminal/commands.rs`, while `replay.rs` reads its own
  constant. The phase now separates four facts: persistence exists,
  `TerminalLaunchRequest` does not carry the value, `normalize_terminal_settings`
  never validates it, and no change channel to a running terminal exists at
  all. *Amended in the fourth round:* the last fact is not merely missing
  machinery — there is no setter beneath it to call.
- **Input during install: the reason to gate is encoding, not transport
  safety** — xterm owns cursor-key, mouse and paste modes. The first draft
  concluded "hold the bytes and encode later", which does not work: `onData`
  delivers bytes xterm has already encoded. Phase 05 now makes the
  pre-encoding seam a hypothesis (H5.6) and, if it fails, suppresses input
  *visibly* rather than silently.

Note when reading that plan: its validation blocks invoke
`pnpm exec vitest run …`, but this repository has no vitest. Frontend tests
run under `pnpm exec node --test` via `ops/test/justfile`.

## Fourth round — corrections from herdr

herdr embeds the same VT library and solves several of the same problems in
production. Reading it produced five changes here. Two are corrections; three
replace a hypothesis with an implemented answer.

- **A live scrollback-setting change was over-promised.** Phase 01 listed
  "build the settings-change channel" as new machinery to size. Below that
  channel there is nothing to call: `max_scrollback` is a construction argument
  and no setter exists at any layer. herdr treats it accordingly — the limit is
  a parameter of every spawn path and a config reload reaches only future
  panes. Phase 01 now makes this a decision with a default (applies to new
  terminals) and states plainly that live application means rebuilding the VT,
  which is separate work.
- **shipctl steals child-owned default colors, today.** `set_theme` calls
  `set_default_fg_color`/`set_default_bg_color` unconditionally
  (`replay.rs:150-152`). herdr guards the same operation with per-slot
  ownership flags and applies the theme selectively, and answers color queries
  from the same flags. Phase 08 gains a task and a criterion for this; it is a
  defect fix, not a refactor, and it is independent of removing the replay.
- **Ordering a theme change is cheaper than phase 08 assumed.** herdr writes
  the OSC sequence *into the parser* rather than calling a setter, so the
  palette mutation takes a position in the same byte stream as child output and
  cannot be reordered against it. Phase 08 prefers that mechanism.
- **Drag coalescing has a known host-side shape.** herdr holds resize in a
  latest-wins slot on a control path separate from the input channel, and
  carries the VT's response to the resize *with* the resize so the two cannot
  reorder. Phase 07 adopts both.
- **One input authority must be re-read after every await.** herdr's single
  write gate is checked twice — before parking on a channel permit and again
  before sending. Phase 05 previously required one authority but not the
  re-check, which leaves the race it was created to close.

Two things from herdr were considered and rejected: its protocol version
handshake and its frame-size caps (phase 03) solve a problem shipctl does not
have, since its peers ship in one bundle rather than meeting over a socket. Its
vendored-dependency approach, by contrast, was adopted as a third option in
phase 01's open decision — vendoring a released archive with in-tree bindings
costs less than the tracked fork that decision previously assumed was the only
way to own the dependency.

## Global constraints

- **No invented limits.** Every numeric constant introduced or changed by this
  plan must carry its authority in a comment: a project setting, a platform
  contract, or a derivation from a measurement reproduced by a committed test.
  Where a value is an unresolved owner choice, the phase marks it
  `OPEN DECISION` and does not manufacture one.
- **Rejected scope.** Replacing xterm.js with a custom cell renderer (the
  "Expert 2" proposal) is out of scope for every phase. Its premise — that the
  replay cannot carry scrollback — is falsified, and the repository's own
  research already rejected structured-cell wire formats on cost grounds.
- **No behavior change is complete without a test that fails before it.** Each
  phase names the test file and the assertion.

## Validation commands

```sh
just check all          # tsc --noEmit and the ops checks
just test fast          # node --test suites, including core/frontend/terminal/tests
just test rust          # cargo test --workspace
just test full          # both, plus the modularity gate
```

New frontend tests belong in `core/frontend/terminal/tests/` and must be added
to `ops/test/justfile` in the same commit. New backend tests belong in
`#[cfg(test)] mod tests` blocks inside the module under test, matching
`core/backend/src/terminal/types.rs:372` and `service.rs:469`.
