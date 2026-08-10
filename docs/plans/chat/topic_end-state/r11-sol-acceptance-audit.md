# Round 11 — sol acceptance audit

- From: sol
- To: independent reviewer
- Round: 11 of 12
- Type: correction application and completion audit
- Evidence boundary: canonical rounds 01-10, the original closure set, live
  code, and the corrected six-file target set

## Ownership

Sol exclusively owns this file and every target plan. The reviewer exclusively
owns round 12 and may report a final correction but cannot edit sol-owned files.

## Round 10 corrections applied

The reviewer found two necessary defects and no architectural defect.

Applied to area 02:

- replaced unavailable Vitest commands;
- corrected decoder and bootstrap paths to the live `tests/` directory; and
- combined them in the Node test-runner command used by the repository.

Applied to area 03:

- corrected affected test-module paths;
- replaced unavailable Vitest commands with the live Node runner; and
- preserved the serialized controller and runtime test lane.

No other round-10 candidate passed the necessity test, so no unrelated edit was
made.

## Direct command proof

The corrected focused commands ran successfully:

- decoder plus bootstrap: 14 tests passed;
- bootstrap alone: 5 tests passed; and
- serialized attachment controller plus client runtime: 38 tests passed.

Repository command resolution was checked with dry runs:

- `just test fast` resolves to the live Node test lanes;
- `just test rust` resolves to `cargo test --workspace`;
- `just test full` resolves frontend, Rust, and modularity lanes;
- `just check all` resolves the aggregate check runner; and
- `just modularity boundaries` resolves the module-boundary checker.

These checks validate that the plans' commands exist. They do not claim the
future refactor already passes the future acceptance scenarios.

## Completion audit against the requested artifacts

### End state is explicit and self-contained

`README.md` leads with the single-VT outcome, current double-parse path, target
semantic path, implemented enablers, dependency graph, four recovery boundaries,
authority rules, stop decisions, and global completion proof.

The target set contains no reference to another plan or research directory. A
team can execute it without this exchange.

### Exactly five priority areas are defined

The five plan files move or delete distinct authority:

1. backend semantic facts and input;
2. cross-client semantic protocol;
3. durable renderer-independent client continuity;
4. webview and CLI presentation parity; and
5. coordinated cutover, deletion, and permanent conformance.

Deleting any one leaves a known duplicate authority or an unproven replacement.
No sixth work area is hidden in the README.

### Implemented enablers are preserved, not replanned

- compatibility fixtures seed production semantics but remain an upgrade gate;
- retention remains the one byte-based, construction-only service policy;
- the exhaustive legacy contract pattern evolves into the semantic contract;
- the existing attachment controller evolves into the client model owner; and
- `TerminalClientRuntime` remains the descriptor and lifecycle reducer.

Every plan distinguishes the completed seam from remaining production work.

### Live code grounding is complete

`ast-grep outline` and focused source reads mapped the affected symbols across:

- backend `terminal` runtime, replay, types, commands, contract, compatibility,
  retention, and service modules;
- instance protocol and control attachment adapters;
- CLI attach, input, raw replay, and stream rendering;
- frontend Tauri adapter, decoder, bootstrap, attachment controller, client
  runtime, view, byte queue, measurement, renderer, addons, viewport, theme,
  and cache; and
- package and lockfile xterm dependencies.

The plans assign every mapped production owner to one primary area and final
deletion to area 05. TypeScript LSP references confirm the controller has one
production view consumer. Rust references confirm terminal event production
adapters are concentrated in runtime, commands, and instance control.

### Cross-cutting risks have one disposition

- **Unicode:** host occupancy is authoritative; presentation owns pixels only.
- **OSC 9:** area 01 must close or explicitly remove it before area 02 freezes.
- **Effects:** occurrence identity and order survive state coalescing.
- **History:** host retention and semantic anchors prevent mixed revisions.
- **CLI:** area 02 protocol, area 04 local painter, area 05 cutover and deletion.
- **Control:** semantic payload encoding may use base64; child and replay bytes
  are prohibited by type and provenance.
- **Migration:** area 05 owns one switch from introduction through deletion.
- **Recovery:** only the four accepted boundaries can request reconstruction.

### Acceptance is behavioral and structural

Each area requires a production-path behavior proof and an authority-boundary
proof. Area 05 adds:

- independent PTY-to-semantic and semantic-to-presentation fixture halves;
- Tauri, control, CLI, and packaged-product scenarios;
- an exact legacy deletion inventory;
- provenance-aware negative gates; and
- deliberate reversible failures proving those gates can detect regressions.

Fixture-only or disabled-legacy results cannot claim completion.

### Limits remain authoritative

The target set introduces no guessed frame size, batch interval, queue capacity,
history window, timeout, retry, soak duration, comparison sample count, or
performance threshold. It requires each selected limit to cite a technical
contract, product requirement, or recorded measurement.

The exact five files and twelve coordination rounds are requester-authorized.
The four recovery boundaries come from the accepted end-state contract.

## Artifact validation

The following checks are required after this round and before final sign-off:

```sh
markdownlint docs/plans/top-5-end-state/*.md \
  docs/plans/chat/topic_end-state/*.md
git diff --check -- docs/plans/top-5-end-state \
  docs/plans/chat/topic_end-state
```

File inventory must show `README.md` plus exactly five target plans and one
canonical coordination file for each round 01-12. All relative target-plan
links and the README delivery-order anchor must resolve.

## Round 12 review request

Verify the current files without editing sol-owned artifacts. Confirm:

1. the two round-10 corrections are exact and executable;
2. no target link, command, module path, or authority boundary is broken;
3. the six target files meet the requested end state and exact five-area scope;
4. all twelve canonical round files exist with the ownership protocol intact;
   and
5. no remaining claim passes the necessity test.

Write the approve or revise decision only in reviewer-owned round 12.

## Status

Round 11 complete. Required corrections are applied and directly tested. The
architecture, plan coverage, execution commands, and completion proofs are ready
for final independent sign-off.
