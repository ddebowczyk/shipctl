# Cutover deletes the second VT

## Outcome

Every client routes through semantic frames, the legacy path is deleted as a
unit, and no build ships both. `libghostty-vt` in the backend is the only VT in
Shipctl. A conformance gate keeps it that way after the people who did this work
have moved on.

This area deletes and proves. It designs nothing. If it discovers design work,
that is evidence an earlier area did not finish, and the correct response is to
return there rather than to design during a deletion.

## Context and purpose

Deletion is the only step in the programme that cannot be rolled back by
removing new code. Every earlier area is additive by construction and reverts by
deleting what it added. This one removes the fallback.

That is why it is last, and why it is separate from the surface. Welding the
irreversible step onto the least understood work would put the point of no
return at the end of a serial chain, at the moment of least information. The
parity register in area 04 gates this area precisely so the decision to delete is
made against closed rows rather than against a deadline.

The deletion set is already enumerable, which is the useful property of having
done areas 01 to 04 first:

- **Five packages**, `package.json:30-34`: `@xterm/addon-fit`,
  `@xterm/addon-unicode11`, `@xterm/addon-web-links`, `@xterm/addon-webgl`,
  `@xterm/xterm`.
- **Eight frontend files** import them: `TerminalView.tsx`,
  `terminalRenderer.ts`, `terminalRendererAddons.ts`, `terminalOutputQueue.ts`,
  `terminalCache.ts`, `terminalMeasure.ts`, `terminalTheme.ts`,
  `terminalViewport.ts`.
- **The ANSI formatter**, `core/backend/src/terminal/replay.rs`, including the
  three compensations area 01 identified as evidence that the formatter is the
  wrong instrument: blank wrap continuations (`:330`), per-cell hyperlink
  reprints (`:392`), and cursor-cell restoration (`:276`). The state traversal
  survives in semantic snapshot production; only the re-encoding dies.
- **The byte-carrying contract variants**: `Output` and `Replay` at
  `core/backend/src/terminal/types.rs:238-268`, `TerminalReplay` at `:270-277`,
  and their control twins at `core/backend/src/instance/protocol.rs:346`.
- **The CLI raw path**, which is larger than the closure plan recorded:
  `write_raw_replay` (`cli/src/terminals.rs:319`) with its two callers at
  `:335-336`, and also `write_raw_event` (`:333`) and `render_raw_error`
  (`:372`), which that plan does not name. There are five `args.raw` branches,
  each a single line: `:257`, `:265`, `:279`, `:286` and `:292`. The closure
  plan lists three of them, so `:279` and `:292` would have survived a deletion
  driven by that list. Drive the deletion from this enumeration, and re-run it
  against the tree before cutting — a list that was wrong once should not be
  trusted twice, this one included.
- **The JSON numeric byte array**: `Array.from(bytes)` in `writeTerminal`
  (`core/frontend/platform/tauri.ts:241-244`).
- **The transitional row budget**:
  `TRANSITIONAL_RENDERER_SCROLLBACK_ROWS` (`terminalRetention.ts:31`) and its
  three call sites in `terminalTheme.ts:119`, `terminalMeasure.ts:35` and
  `TerminalView.tsx:83`, together with the assertion at
  `tests/terminalRetention.test.ts:45`.
- **The parity harness** from area 04. It was migration evidence, not a
  dependency, and it leaves with the thing it compared against.

## Dependencies

- **Blocked by.** Areas 01, 02, 03 and 04, and specifically by the area 04
  register having no open row. `end-state.md:227` is the authority: an open row
  blocks cutover.
- **Blocks.** Nothing. This is the end state.

## Affected areas

Everything named in the deletion set above, plus `ops/test/justfile` where the
conformance gate is registered, and `docs/ops/` where its procedure lives.

## Work to be done

Items 1 to 5 remove the old path. Items 6 to 12 prove the contract. Items 13 to
17 keep it closed. Items 18 and 19 leave the record true.

1. **Route every terminal through semantic frames and remove the migration
   switch in the same change.** One commit, one diff. A build that can be
   configured back to the legacy path has not cut over.
2. **Remove the five packages and the lockfile entries**, and the eight
   importing files or their xterm dependencies. The parity harness goes too.
3. **Remove the ANSI formatter and its production paths** in `replay.rs`:
   `format_active_screen`, cursor-cell and wrap-continuation emission, hyperlink
   re-emission, and style-sequence construction.
4. **Remove every path that carries child PTY bytes or replay ANSI across a
   Shipctl boundary.** The byte variants in `types.rs` and `protocol.rs`, the
   base64 twins, `Array.from(bytes)` in `tauri.ts:241-244`, and the CLI raw
   branches. The CLI cuts over to the presentation adapter area 02 prototyped
   and measured.

   The distinction is transport versus local presentation. The CLI may emit
   paint sequences it generates locally from semantic frames, and the external
   terminal interprets them. Those sequences are not a transported VT authority:
   the CLI never reparses the child PTY stream. There is no exception branch
   here. Single-VT closure cannot be claimed through a register waiver while a
   Shipctl adapter still transports PTY bytes.
5. **Remove the residue in React**: attachment protocol state, descriptor
   membership writes outside the registry reducer, and lifecycle-derived
   attachment-readiness flags. Remove the transitional row constant and its
   three call sites, and update the test that asserts against it.
6. **Exercise the production codec and controller through all three consumers**
   — Tauri, the instance control socket, and the CLI. Adding or dropping any
   semantic field must still fail the drift gate at `contract.rs:297-305`.
7. **Add end-to-end coverage** that creates numbered history, anchors the
   viewport away from the bottom, and performs row resize, column resize, drag,
   visible and hidden theme change, settings overlay, tab hide and show, hidden
   output, injected gap, recovery, surface recreation, history-window browsing,
   and close during stale reconciliation.
8. **Assert the protocol facts in that coverage**: zero reconstruction on
   resize, theme change or visibility; one consecutive sequence across frames
   and effects; exactly one unbased snapshot per injected recovery boundary and
   none from resize or surface recreation; every frame applied against its
   declared base revision; no missing or duplicate numbered output; and no
   descriptor resurrection after observed removal.
9. **Run the full capability set through the production surface**: alternate
   screen, OSC 8 and plain-text links, selection, copy, paste, graphemes and
   wide cells, application palette, mouse modes, IME, bell, OSC 9, title, exit,
   and no-surface-output behaviour.
10. **Confirm the module contract.** Registry lifecycle reaches module
    subscribers exactly once, and attachment visibility emits no lifecycle event
    at all. Both characterisation suites run unmodified, or a deliberate
    contract change is recorded with the module owner.
11. **Exercise terminal settings through production IPC** across running,
    hidden, background, newly spawned and later recovered terminals. Prove one
    canonical persisted policy revision. Prove retention applicability
    separately for new and already-running terminals: the closed register row
    selected construction-only, so what is proven is the disclosure area 01
    requires, not an update the pinned API cannot perform.
12. **Repeat the release-mode measurements** from areas 02 and 04 using the
    recorded method, and explain any regression against a recorded constraint.
13. **Build the conformance corpus in two halves**: fixed PTY input to a fixed
    semantic model, and a fixed semantic model to fixed presentation facts.
    Neither half may be asserted against the other's implementation, because a
    gate that compares two implementations to each other passes when both are
    wrong in the same way.
14. **Cover the measured divergence surface** in the first half: reflow at wrap
    boundaries, alternate-screen entry and exit, cursor save and restore, wide
    characters, combining marks, mode changes, colours, and scrollback eviction.
15. **Promote the corpus out of `research/`.** Dated working notes stay there; a
    merge gate is durable tooling. This follows the repository policy: durable
    reference in `docs/`, dated evidence in `research/`, procedure prose in
    `ops/<capability>/skills/`.
16. **Register the gate in `ops/test/justfile`** beside the consolidated
    terminal suites, on the same trigger as the libghostty-vt compatibility
    fixtures. A dependency bump that passes one and fails the other must not
    merge.
17. **Break the gate on purpose to prove it works.** Perturb one covered case in
    the semantic extractor, confirm the gate fails and names the case, revert.
    Perturb one covered case in the presentation model, confirm the same,
    revert. A gate never observed failing has not been shown to work. This is
    the second time the programme applies that rule; the first is area 02's
    drift gate.
18. **Update the earlier terminal plans and the VT proof** to describe
    single-authority behaviour, the true retention units and effective floor,
    the four recovery boundaries, host-owned history windows, and the register
    outcome. Mark superseded criteria as superseded rather than silently editing
    evidence.
19. **Run the full repository, modularity, documentation and worktree checks**,
    and keep unrelated user changes outside the closure diff.

## Acceptance criteria

1. `rg -l '@xterm/'` returns no file under `core/`, `src/` or `cli/`. Remaining
   matches are historical plan documents and `pnpm-lock.yaml` regenerated
   without the packages.
2. No Shipctl boundary carries child PTY bytes or replay ANSI. Asserted by a
   negative gate over the contract artifact, not by inspection.
3. `write_raw_replay` and the `args.raw` branches are gone, and
   `shipctl terminals attach` serves the characterisation session from semantic
   frames.
4. One build path exists. The migration switch is absent from the source, not
   merely defaulted off.
5. The end-to-end coverage in item 7 asserts every fact in item 8, and passes.
6. Both halves of the conformance corpus exist, neither asserted against the
   other's implementation, and both were seen failing under deliberate
   perturbation.
7. The gate runs in CI on the same trigger as the compatibility fixtures. A
   deliberate libghostty-vt bump that changes a covered behaviour fails it.
8. The area 04 register has no open row on the date of the cut, and the dates
   prove the rows closed before the cut rather than with it.
9. `docs/ops/` documents how to run the gate, how to read a failure, how to
   accept a new conformance change, and who approves that.
10. The superseded plans say so. A reader arriving at
    `docs/plans/top-5-single-vt-closure/` learns what replaced it.

## How to validate

```sh
just check all
just test full
just test rust
just modularity boundaries
rg -l '@xterm/' core src cli
cargo test --manifest-path core/backend/Cargo.toml terminal::
```

Plus the manual macOS pass on the packaged application, and the release-mode
measurement run compared against the recorded baselines.

## Exit and rollback

There is no rollback. That is the definition of this area, and it is why the
gate is the area 04 register rather than a schedule.

Before the cut, the whole programme reverts by deleting new code. After it,
recovery means restoring deleted code from history, which is why items 6 to 12
run before item 1 lands rather than after. Ordering the proof ahead of the
deletion is not caution; it is the only sequence in which the evidence is
capable of stopping the change.

If a capability is discovered missing after the cut and has no register row, the
failure is traced to area 04, not repaired quietly here. A quiet repair at this
point would be the second VT growing back, one compensation at a time — which is
how the first one arrived.
