# Phase 10 — Cutover, legacy removal, and contract update

## Objective

Make the new model the only production path, correct the repository documents
that still mandate the old one, and close the work with evidence gathered
through the real Tauri adapter and the packaged app — not through fakes.

This phase invents nothing. Any capability discovered missing here returns to
the phase that owns it.

## Why a contract update is required

`docs/plans/20260809-130352-better-terminal/` is treated as a contract
authority in this repository, and it mandates resize as an authoritative
reset/replay boundary. Left unchanged, it makes the corrected code look wrong
and invites the defect back. The VT proof's README likewise still describes
exactness as a per-geometry property.

The invariant changes from *exact at every instant* to **exact at recovery
boundaries, convergent while live**. That is a real weakening and must be
written down as such, with the phase-07 divergence measurement behind it — not
quietly rewritten.

## Tasks

1. Remove the code the earlier phases made dead: resize and theme replay
   construction and `note_replay_change`, visibility-driven attachment
   teardown, JSON `number[]` terminal payloads and `Array.from(bytes)`,
   protocol refs left in `TerminalView`, direct close bookkeeping, and
   lifecycle-derived view input flags.
2. Enumerate every remaining `TerminalEvent::Replay` producer and
   `term.reset()` caller. Exactly four boundaries may remain — initial attach,
   renderer recreation, sequence gap, queue overflow — each named by a test.
3. Update `docs/plans/20260809-130352-better-terminal/` where it states the
   superseded contract: `README.md`,
   `01-evidence-and-architecture-contract.md`,
   `03-attachments-replay-and-flow-control.md`,
   `05-renderer-reconciliation.md`, `08-cutover-and-verification.md`. Mark
   superseded criteria explicitly; do not silently rewrite historical
   evidence.
4. Update `research/20260809-124553-fut-tty/vt-proof/README.md` with the new
   invariant, the fixture inventory, pinned revisions, measured retention
   behaviour, and the divergence boundary.
5. Add one integration scenario through the production adapter: create a
   terminal, emit uniquely numbered history, scroll off the bottom, then
   perform in order — row resize, column resize, drag burst, theme change,
   settings open/close, tab hide/show, output while hidden, injected gap,
   recovery, renderer recreation, and close during a delayed list
   reconciliation.
6. Assert **event counts**, not screenshots: zero routine replay, reset or
   detach; one marker per changed geometry and per changed theme; one
   recovery per injected gap; no lost or duplicated numbered output; no
   descriptor surviving an observed removal.
7. Re-run the regression surface through the production codec: alternate
   screen, OSC 8 links, search, selection, Unicode, application palette,
   bracketed paste, mouse modes, exit, and output with no view attached.
8. Repeat the phase 03 measurements in release mode and check the results in
   with their reproduction command: frame sizes, throughput, snapshot size and
   install time, resize-burst behaviour, and memory at the selected retention
   budget. Explain regressions rather than waiving them.
9. Manual pass on the packaged macOS app — not the dev web surface — with a
   shell producing long history and at least one resize-aware full-screen
   program.

## Acceptance criteria

- A source search finds no routine resize, theme or visibility path reaching
  `Replay`, `term.reset()` or attachment teardown; every remaining match maps
  to one of the four named recovery boundaries.
- The integration scenario passes through the real Tauri adapter with the
  asserted event counts.
- No compatibility branch, feature flag, base64 fallback, or legacy JSON
  terminal codec remains.
- The earlier plan and the VT proof describe the system that now exists,
  including its weakened invariant and the measurement supporting it.
- Performance results are checked in and no worse than the phase 03 baseline.
- The packaged-app pass and the automated evidence agree.

## Validation

```sh
rg -n "TerminalEvent::Replay|term\.reset\(\)" core/backend/src/terminal core/frontend/terminal
rg -n "Array\.from\(bytes\)|readonly number\[\]" \
  core/backend/src/terminal core/frontend/terminal core/frontend/platform
just check all
just test full
markdownlint docs/plans/20260809-191027-terminal-fix-opus/*.md
git diff --check
```

The `rg` results are inspected, not required to be empty.

## Completion rule

Close the plan only when automated and packaged-app evidence agree. If a gate
fails, return to the phase that owns the violated contract. Do not restore
routine replay as a general fallback — that is the original defect.
