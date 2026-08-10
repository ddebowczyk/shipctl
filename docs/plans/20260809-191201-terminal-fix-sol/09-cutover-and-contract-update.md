# Phase 09 — Cut over, remove legacy paths, and update the contract

## Outcome

Ship the new continuity model as the only production path, correct the earlier
plan documents that mandate replay on resize, and close the work with complete
functional, race, protocol, performance, and manual evidence.

## Context

The earlier `20260809-130352-better-terminal` plan is treated as a contract
authority in the repository and currently requires authoritative
reset/resize/replay. Leaving that text unchanged would make the fixed code look
incorrect and invite the defect back. The research proof also needs to state
the new exact-at-recovery/convergent-while-live invariant.

This phase performs no architectural invention. Any missing capability returns
to its owning phase.

## Tasks

1. Remove obsolete production code and types:
   - resize/theme replay construction and `note_replay_change` calls;
   - visibility-driven attachment cleanup;
   - JSON `number[]` terminal payloads and input conversions;
   - attachment protocol refs/state left in `TerminalView`;
   - direct close bookkeeping outside the registry reducer; and
   - lifecycle-derived view input flags.
2. Search for every `TerminalEvent::Replay` producer and `term.reset()` caller.
   Keep only initial attach, xterm-model recreation, sequence-gap recovery, and
   queue-overflow recovery, each with a focused test naming that boundary.
3. Update the earlier plan's exactness language in:
   - `docs/plans/20260809-130352-better-terminal/README.md`;
   - `01-evidence-and-architecture-contract.md`;
   - `03-attachments-replay-and-flow-control.md`;
   - `05-renderer-reconciliation.md`; and
   - `08-cutover-and-verification.md`.
4. Replace “resize is an authoritative reset/replay boundary” with the ordered
   live-resize contract. Add history-complete recovery, binary framing,
   visibility continuity, true retention units, and the Phase 01 convergence
   evidence. Mark superseded acceptance criteria explicitly; do not silently
   rewrite historical evidence.
5. Update `research/20260809-124553-fut-tty/vt-proof/README.md` with commands,
   fixture inventory, pinned revisions, observed retention behavior, divergence
   boundary, and the exact pass/fail result supporting the new contract.
6. Add one integration scenario that creates a terminal, emits uniquely
   numbered history, scrolls away from bottom, and performs in order:
   row resize, column resize, drag burst, theme change, settings open/close,
   tab hide/show, output while hidden, explicit gap, recovery, renderer
   recreation, and close during a stale list reconciliation.
7. In that scenario assert event counts, not only screenshots:
   - zero routine replay/reset/detach;
   - one marker per changed canonical resize/theme;
   - one consecutive sequence across data and every control-event kind;
   - one recovery snapshot per injected gap/recreation;
   - no lost/duplicate numbered output; and
   - no descriptor after observed removal.
8. Run alternate-screen, OSC 8, search, selection, Unicode, app palette,
   bracketed paste, mouse mode, exit, and no-view-output regressions through the
   production codec and controller. Unicode coverage includes combining marks,
   flag pairs, ZWJ emoji, and wide-cell tails across reset and resize.
9. Repeat Phase 01 performance measurements in release mode. Record raw output
   throughput, allocation, snapshot size/install time, resize-burst behavior,
   and memory at the selected retention budget. Explain regressions before
   acceptance; do not waive them with an arbitrary percentage.
10. Perform a manual macOS pass using the packaged Tauri app, not only the dev
    web surface. Include a shell producing long history and at least one
    resize-aware full-screen program.
11. Run the complete repository gates and Markdown checks. Inspect the final
    worktree and diff so unrelated `ops/build` changes and the independent Opus
    plan remain untouched.
12. Run every focused terminal Node suite through `ops/test/justfile` with
    `--test-concurrency=1`; fail review if a newly registered terminal suite
    omits the repository's required serial-execution flag.
13. Exercise the new settings route through production Tauri IPC: submit an
    unsupported scrollback value and observe backend canonicalization, then
    switch 50k -> 1k -> 10k with multiple running and background terminals.
    Assert the persisted value, service policy revision, every still-live actor,
    frontend store, cached xterm, first-reveal snapshot, and later spawn agree.
14. Capture hidden-work counters with 1 and 15 output-producing hidden
    terminals. Host parsing and attachment sequence consumption must continue;
    DOM measurement/focus and avoidable presentation work must not scale with
    hidden-pane count.

## Acceptance criteria

- The whole-plan acceptance criteria in `README.md` pass through the production
  Tauri adapter, not only isolated codecs or fake runtimes.
- Source search finds no routine resize/theme/visibility path to `Replay`,
  `term.reset()`, or attachment teardown.
- All retained history and active state expected by Phases 06A/06B survive
  initial attach and every recovery boundary; physical eviction and snapshot
  omission are explicit and independently tested, including a background
  terminal's first reveal.
- The integration scenario proves ordered resize with zero loss/duplication and
  no stale close resurrection.
- Workspace normalization is the only scrollback validator, and the settings
  integration scenario proves canonical startup/live propagation without a
  stale host actor or unchecked frontend value.
- The raw IPC benchmark and memory results are checked in with reproduction
  commands and are no worse than the agreed Phase 01 constraints.
- Earlier plan documents and the VT proof describe the implementation that now
  exists, including its bounded convergence tradeoff and escalation trigger.
- No compatibility branch, feature flag, base64 fallback, or old JSON terminal
  codec remains after cutover.
- All checks below pass from a clean build of the changed terminal surfaces.

## Validation

```sh
rg -n "TerminalEvent::Replay|term\.reset\(\)" \
  core/backend/src/terminal core/frontend/terminal
rg -n "Array\.from\(bytes\)|readonly number\[\]" \
  core/backend/src/terminal core/frontend/terminal core/frontend/platform

./research/20260809-124553-fut-tty/vt-proof/run.sh
just check all
just test full
just modularity boundaries
markdownlint docs/plans/20260809-191201-terminal-fix-sol/*.md
git diff --check
git status --short
```

The `rg` result is inspected, not required to be empty: remaining replay/reset
matches must correspond exactly to the named recovery boundaries and tests.

## Manual acceptance script

1. Print more uniquely numbered lines than one viewport, scroll to a middle
   row, and select text.
2. Resize height, width, and then drag continuously. Confirm the anchor,
   selection, old row searchability, cursor, and new output.
3. Change app theme while visible and again while hidden. Confirm history and
   application-authored colors, then query the terminal defaults.
4. Switch tabs and open/close settings while output continues. Confirm no
   content jump and no attachment-ID change. Change scrollback 50k -> 1k -> 10k
   and confirm all running/background terminals and the next spawned terminal
   report the same canonical revision/value.
5. Trigger the test-only sequence gap and xterm-model recreation. Confirm one
   snapshot each and explicit `history_truncated` status with independent
   `host_eviction`/`snapshot_omission` causes when older history is unavailable.
6. Enter/exit a full-screen program, test mouse/paste, follow an OSC 8 link,
   search history, and copy a selection.
7. Close the terminal while the reconciliation test hook delays a list result.
   Confirm it does not return after the host removal event.

## Completion rule

Close the plan only when automated and packaged-app evidence agree. If a gate
fails, return to the phase that owns the violated contract; do not restore
routine replay as a general fallback.
