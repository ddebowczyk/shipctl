# Drive assessment: executing the five areas

Written by ClaudeA. The five area plans state what the end state is and what
each gate must prove. This file answers a different question: given what the
enablers actually left in the tree, in what order should the work happen, and
where is the remaining risk?

The gate order in `README.md` is an **acceptance** order. It says which proof
must exist before another proof counts. It is not an execution order, and
reading it as one puts the project's only surviving unknown last.

## What the enablers actually left

Counted, not estimated:

```sh
rg -c '#\[test\]' core/backend/src/terminal/*.rs
rg -c '^\s*test\(' core/frontend/terminal/tests/*.test.ts
```

Backend terminal: 63 tests. Frontend terminal: 140 tests across 18 files.

The distribution matters far more than the totals.

| Module | Tests | What that means |
| --- | --- | --- |
| `compat.rs` | 19 | The Ghostty capability surface is proven |
| `service.rs` | 19 | Registry and lifecycle are covered |
| `retention.rs` | 7 | Budget arithmetic is covered |
| `replay.rs` | 5 | The engine is covered |
| `runtime.rs` | **2** | Both cover `resolve_launch_command` |

## Finding 1: area 01's falsification already succeeded

Area 01 is written as a falsification phase — prove the pinned dependency can be
the sole authority, or stop. That proof exists and passes. `compat.rs` holds 19
tests covering geometry, alternate screen, retained history, grapheme width,
style and color resolution, reflow, cursor, semantic prompts, child-owned
colors, hyperlinks, modes, ordered effects, input encoders, and selection.

It is also quarantined. `mod.rs` declares it `#[cfg(test)] mod compat;` with the
comment "Tests only: it is a compatibility gate, not production code."

So the risk area 01 was designed to retire **is already retired**. What remains
is promotion of proven capability into the production path — a wiring problem
with known scope, not a discovery problem. Area 01 should be planned and staffed
as the lower-risk area it now is.

## Finding 2: the one real backend gap is the actor, and it is cheap

`runtime.rs` contains two tests and both cover launch-command resolution.
Nothing executes `handle_output`, the actor's `resize`, or the actor's
`set_theme`. Every claim about what a client receives rests on reading — and
reading is the method that produced three refuted claims during this review.

One actor harness closes:

- output byte identity through `handle_output`;
- replay publication on `resize`;
- replay publication on `set_theme`; and
- area 01 criterion 5, on **both** its producer paths — `write_response` is
  called from `handle_output` and from `set_theme`, so a test against the output
  path alone satisfies half the requirement.

This is the highest proof-per-unit-work item in the entire plan and it has no
dependencies. It should be first.

## Finding 3: area 03 is half-built and its pattern is proven

The client scaffolding exists and is tested: attachment controller (21),
client runtime (16), viewport (15), event decoder (9), keybinding presets (8),
fit plan (7), retention (6), OSC notification (5), bootstrap (5).

More important than the count is *how* those tests run. The frontend lane is
`pnpm exec node --test` over `.ts` through Node's type stripping. Every tested
module that touches xterm imports it as a **type only**, so xterm never loads
and the test supplies a structural fake. Only three modules value-import xterm:
`terminalMeasure.ts`, `terminalRendererAddons.ts`, and `TerminalView.tsx`.

That is the extraction pattern area 03 describes, already working, repeatedly.
Area 03 does not need a new toolchain, a DOM, or a JSX transform. It needs the
logic moved out of the component, which is the work the area already specifies.

`TerminalView.tsx` still has no test, and an outline of it returns one interface
and one exported function — the whole file is a single component body with no
seam to attach a test to. Creating that seam *is* area 03.

## Finding 4: area 04 is the only thing that can still kill this

Nothing of area 04 exists. It is also the only area whose failure invalidates
the other four: if a non-xterm surface cannot present host-supplied cell spans
with acceptable IME, accessibility, selection, and fallback behavior, then areas
01 through 03 were built for a surface that cannot ship.

Area 04's own text already says its probes "start early because any can falsify
the target surface." That instruction should govern staffing, not sit inside the
area that the gate order places fourth.

One constraint on how it starts, from the frontend lane above: an area-04 spike
attempted **before** area 03's extraction lands has no `.ts` seam to test
against and will appear to require a second frontend toolchain. Sequencing area
03 first dissolves that, and no toolchain decision needs to be made at all.

## The execution order the evidence supports

1. **Actor harness** — no dependencies, closes four claims plus criterion 5 on
   both paths. Backend, small, immediate.
2. **Area 03 extraction, continuously** — proven pattern, already half done, and
   it is what makes every later frontend claim testable in the existing lane.
3. **Area 04 falsification probes, in parallel from now** — the only surviving
   unknown. Consumes area 03's extracted model; adopts no second toolchain.
4. **Area 01 promotion** — proven capability into production. Known scope.
5. **Area 02 contract extension** — mechanical. The Rust-to-JSON-to-TypeScript
   drift gate already exists and works; extend it rather than invent a second.
6. **Area 05 cutover and deletion** — unchanged, last, conditional on the rest.

The gate order in `README.md` stays exactly as written. This is the order in
which the work should be *started*, and it differs because risk and dependency
do not point the same way.

## One live defect this assessment rests on, now fixed

A theme change ran two paths at once. `applyThemeToTerminals` preserved the
viewport and skipped hidden terminals; `update_terminal_color_theme` fanned out
through `TerminalService::set_color_theme` to every record, published a replay,
and `installReplay` reset the terminal with no preservation and no guard. The
first path's care was undone by the second.

It is fixed and tested at `49a43d9`: the offset is captured before the reset and
re-applied when the output queue reports empty. It is recorded here because it
is the shape of defect this refactor exists to remove — two authorities
disagreeing about one piece of state — and because area 03 now inherits a
working implementation and a tested ordering constraint rather than a blank page.
