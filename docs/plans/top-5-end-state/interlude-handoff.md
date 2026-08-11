# Handoff: terminal performance interlude

Date: 2026-08-11

Audience: the team continuing the main terminal single-VT epic in
`docs/plans/top-5-end-state/`.

## Status

The performance interlude is complete. Keep the single-VT design and the
host-owned Ghostty model. The former cell-object JSON representation and
publication on every PTY read were the defects. The mounted compact JSON path
does not send anything close to 1 MB per screen in the measured workload.

Areas 01 and 02 gained the required compact representation and demand-paced
publication. The existing area-03 client model and semantic painter remain in
place. Area 04 still has parity blockers. Do not begin the destructive area-05
cutover or delete the byte rollback path.

All changes are in the current worktree. They are not committed.

## Why the team stopped for this interlude

The transitional semantic path encoded one JSON object per cell and projected a
full screen after each 4 KiB PTY read. Depending on geometry, one screen event
was 185-956 KB. Host CPU was affordable, but the representation amplified a
small PTY read into a large IPC message.

Damage-only encoding was measured and rejected. Scrolling output changes every
row, so row damage saved less than 1 percent. The useful compression boundary
was the styled run rule that the painter already applies.

The approved intervention is recorded in
`docs/plans/top-5-end-state/interludium/plan.md`. The corrected diagnosis is in
`docs/plans/top-5-end-state/perf-insights-20260811-111127.md`.

## What was delivered

### Complete compact semantic wire contract

- Protocol version 10 carries complete run-based screen snapshots.
- Each run keeps `glyphs: string[]`. It preserves every host cell and grapheme
  boundary instead of joining text and asking the frontend to recover cells.
- Rows retain wrap, continuation, prompt, width, style, color, hyperlink,
  selection, cursor, mode, viewport, damage, and history-related facts.
- Selection remains an attachment overlay. It is not part of shared canonical
  screen state.
- The TypeScript decoder expands runs into the existing cell model and rejects
  a malformed event before model mutation.
- Rust-generated protocol and fixture files reproduce byte-for-byte.

The main wire implementation is
`core/backend/src/terminal/wire.rs`. The checked contract and fixtures are under
`core/frontend/terminal/terminal*Contract.json` and
`core/frontend/terminal/terminal*Fixture.json`.

### Consumer-driven publication

- PTY data always feeds Ghostty immediately. Parser replies still go to the
  child immediately.
- A screen change marks state dirty. It no longer forces an unconditional
  projection and encode for every PTY read.
- A visible semantic attachment grants explicit screen credit.
- Each attachment can hold one replaceable screen transaction in flight.
- Later changes replace intermediate screen state. They do not build a queue of
  complete snapshots.
- A client grants the next credit only after validation and atomic model
  commit.
- Hidden surfaces stop granting screen credit and resume from current state
  when demand returns.
- Attachments that need the same state share one immutable projection and one
  JSON encoding.
- Ordered effects use a separate reliable lane. Screen replacement cannot drop
  bells, notifications, clipboard requests, lifecycle, or exit occurrences.
- Tauri sends the already encoded JSON instead of serializing the same screen
  once per recipient.

The host behavior is centered in
`core/backend/src/terminal/runtime.rs`. The client demand and commit boundary is
in `core/frontend/terminal/terminalAttachmentController.ts`.

### Measurement and scenario support

The packaged scenario harness now measures:

- PTY reads and semantic screen changes;
- projections, encodes, encoded bytes, and recipient deliveries;
- current and peak queued screen and effect data;
- client decode, model commit, and paint work;
- hidden-surface work and reveal recovery;
- shared attachment fanout; and
- stalled-client replacement and recovery.

The test run also found and fixed support defects that would have invalidated
manual testing:

- fractional WebKit font geometry no longer reaches a Rust `u32` command;
- repeated identical errors no longer create dozens of notice popups;
- WebKit callback scheduling preserves the required receiver binding;
- the sustained-output scenario sends one short shell loop instead of 2,000
  frontend commands; and
- hidden, fanout, and slow-client measurements first consume the one screen
  credit that the visible view already granted.

## Packaged result

The successful run was:

```text
run id: compact-json-20260811-final-2
terminal id: f76d972a-b7e6-4c1a-bb9f-c5a23ec68c3e
result: 4 passed, 0 failed, 1 skipped
duration: 3,431 ms
```

The skipped scenario was GPU loss. The mounted canvas exposed no way to drop
the GPU context, so the run does not prove renderer recovery.

| Observation | Result |
| --- | ---: |
| PTY reads | 69 |
| Screen changes | 71 |
| Projections and encodes | 51 each |
| Total compact screen bytes | 205,134 B |
| Average encoded screen | about 4,023 B |
| Peak queued screen bytes | 15,143 B |
| Client decode | 50 calls / 1 ms |
| Client model commit | 50 calls / 10 ms |
| Client paint | 34 calls / 14 ms |
| Sampled frame gap, mean / slowest | 24.225 ms / 770 ms |
| Resize round trip | 95 ms |

Further mounted proofs:

- Five hidden screen changes caused no projection, encode, model commit, or
  paint after the already-granted credit was consumed.
- Two observers shared one 3,694-byte encoding and received two deliveries.
- A stalled observer retained one 3,695-byte transaction across three screen
  changes and resumed two sequences ahead.
- The workload emitted no effects. Reliable effect separation is proved by the
  Rust and frontend protocol lanes, not by this mounted transcript.

The exact local transcript is at
`research/notes/terminal-compact-json-packaged-profile-20260811-1349.md`.
`research/notes/` is ignored by Git. The tracked performance and interlude plans
contain the conclusions needed by the team, but the exact transcript will not
travel in a normal commit unless the team deliberately changes its placement.

The old transcript contains an `output.rate` value derived from command
admission time. It is not terminal throughput and must not be cited as such.
The harness no longer emits that derived measurement.

## Decisions the main epic must preserve

1. Keep Ghostty as the sole semantic and Unicode-occupancy authority.
2. Keep complete compact JSON snapshots as the current wire representation.
3. Do not implement raw binary unless later packaged evidence shows a material
   benefit for the same semantic schema and workload.
4. Do not implement damage-only rows for scrolling output.
5. Keep replaceable screen state separate from reliable ordered occurrences.
6. Keep explicit commit credit. A successful Tauri send is not a client
   acknowledgement.
7. Do not introduce a timer, frame-rate target, byte limit, queue size, or
   performance threshold without an authoritative requirement or measurement
   that requires it.
8. Keep the byte renderer unchanged as a rollback path until area 04 passes.
9. Do not start area-05 deletion while any area-04 capability is blocking.

## How this changes the five-area plan

### Area 01: host semantic authority

Demand-paced publication is implemented. The actor still owns PTY ingress,
Ghostty mutation, parser replies, sequence order, and projection. Do not move
these duties into Tauri commands or the frontend.

### Area 02: protocol and adapters

The compact run contract, fixtures, Tauri adapter, control protocol, and CLI
adaptation are implemented. Treat version 10 as the current contract. Future
wire changes must preserve exhaustive fixture generation and atomic frontend
rejection.

### Area 03: persistent client model

The model was deliberately not redesigned. Runs expand at the decoder boundary
into the existing model. The attachment controller now owns demand and grants
credit after model commit. Preserve that boundary when continuing lifecycle and
continuity work.

### Area 04: presentation parity

The packaged measurements for sustained output, hidden catch-up, attachment
fanout, and slow-client recovery now pass. The following register entries still
block parity:

- `unicode.glyph-fits-span`: perform the written glyph review.
- `renderer.gpu-loss-fallback`: establish a reachable GPU-loss mechanism or an
  approved packaged manual proof. The current scenario skipped.
- `input.ime`: perform the real input-method review.
- `input.paste`: connect the client to the host paste-safety answer.
- `selection.copy`: write and run the platform copy-gesture procedure.
- `effect.clipboard-write`: declare and prove the visible or typed outcome.
- `links.plain-text`: project link matches in the host or record an approved
  product removal.
- `a11y.keyboard-focus`: write and run the keyboard entry and escape procedure.

The capability register in
`core/frontend/terminal/scenarios/capabilityRegister.ts` is the executable
inventory. Do not replace its blockers with a general statement that the
browser needs more testing.

### Area 05: cutover and deletion

Area 05 remains blocked. Do not remove raw `Output` or `Replay`, the byte
renderer, xterm comparison support, or migration fallback yet. The compact
transport result removes wire size as a blocker; it does not prove presentation
parity or fallback recovery.

## Remaining performance question

The mounted run sampled one 770 ms frame gap. Decoder, model-commit, and painter
timers accounted for only 25 ms across the complete run, so this evidence does
not attribute the gap to compact JSON.

Do not optimize the wire in response. First run a mounted long-task or event
dispatch profile around the existing sustained-output scenario. Identify which
host, WebKit, event-loop, layout, or test-harness activity occupied that gap.
Report the observed cause. Do not convert the 770 ms sample into a product
threshold.

## Verification already completed

- `just test rust`: passed.
- `just test full`: passed.
- `just check all`: passed.
- `just check release-bundle`: passed; the release has no scenario entry point.
- Focused terminal scenario, controller, decoder, model, painter, viewport, and
  protocol tests passed.
- TypeScript checks, Rust formatting, modularity boundaries, Markdown lint, and
  `git diff --check` passed.
- Contract generation with `SHIPCTL_WRITE_TERMINAL_CONTRACT=1` reproduced every
  checked JSON contract and fixture without drift.

`just check all` reports 42 Clippy warnings against the recorded soft baseline
of 25. This check is non-blocking, but the increase is visible and must not be
described as a zero-warning result.

## Worktree state

The implementation spans the terminal backend, instance protocol, Tauri
adapter, CLI painter, frontend controller and model boundary, scenario harness,
fixtures, and focused tests. Two new source files are untracked:

- `core/backend/src/terminal/wire.rs`
- `core/frontend/terminal/terminalPerformanceMetrics.ts`

The remaining files are modified but unstaged. Do not discard or overwrite the
worktree. Re-run `git status --short` before integrating because other work may
arrive after this handoff.

The callback-id console messages observed during testing were caused by
reloading the app while Rust asynchronous operations were still running. They
are not part of the packaged performance result.

## Recommended next action

First, review and integrate the current interlude diff as one coherent protocol
and pacing slice. Preserve the generated contract fixtures and run the existing
full gates after resolving any concurrent worktree changes.

After that integration is stable, return to area 04. Start with a mounted
long-task or event-dispatch profile of `measure.sustained-output`, because the
770 ms unexplained gap is the only new performance question. Then close the
explicit capability-register blockers. Start area 05 only when the register and
packaged/manual evidence say that presentation parity and fallback recovery
pass.
