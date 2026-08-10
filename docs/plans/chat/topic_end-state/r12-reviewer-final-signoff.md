# Round 12 — Reviewer final signoff

- From: independent reviewer
- To: sol
- Round: 12 of 12
- Type: final fixed-point audit
- Evidence boundary: canonical rounds 01-11, the corrected six-file target set,
  and the live modules named by those plans

## Ownership compliance

The reviewer exclusively owns this file. I did not edit any sol-owned round or
target plan. The canonical exchange preserves sol ownership of odd rounds and
target plans, and reviewer ownership of even rounds.

## Decision

**APPROVE.** No remaining claim passes the MSW necessity test. The corrected
target set is self-contained, executable as a delivery plan, and sufficient to
replace the current double-VT path with one backend VT authority and then delete
the browser VT, raw-output protocol, replay reconstruction, and migration
switch.

## Round-10 correction proof

The two required corrections are exact:

- Area 02 uses Node's test runner with the live decoder and bootstrap paths
  under `core/frontend/terminal/tests/`.
- Area 03 names the live controller and bootstrap test modules, uses Node's test
  runner, and preserves serialized execution for the controller/runtime pair.

The corrected commands ran successfully:

- decoder plus bootstrap: 14 tests passed;
- bootstrap alone: 5 tests passed; and
- attachment controller plus client runtime with test concurrency one: 38 tests
  passed.

## Artifact and link proof

The target directory contains exactly the requester-authorized artifacts:

- `README.md`; and
- five numbered target plans, `01` through `05`, with no sixth work area.

After adding this file, the canonical exchange contains exactly one numbered
round for each round `01` through `12`. The README links to all five target
plans. All plan-to-plan relative links resolve, and
`README.md#delivery-and-acceptance-order` resolves to the corresponding README
heading.

No target file refers to another plan directory or research artifact. Each plan
restates its outcome, context, dependencies, live modules, work, exclusions,
acceptance criteria, validation, and stop or rollback rule.

## Live-module and boundary proof

`ast-grep outline` and focused discovery confirm that the plans are grounded in
the current production seams:

- backend terminal runtime, replay, types, commands, contract, compatibility,
  retention, and service;
- instance protocol and control adapters;
- CLI attachment, input, replay, and streaming output;
- frontend Tauri adapter, decoder, bootstrap, attachment controller, lifecycle
  runtime, view, byte queue, measurement, renderer, addons, viewport, theme,
  and cache; and
- package and lockfile xterm dependencies.

Authority and dependency rules are consistent across all five areas:

- Area 01 makes backend Ghostty state and input production-authoritative.
- Area 02 carries that meaning across Tauri, control, CLI, and module adapters.
- Area 03 owns renderer-independent client continuity without a second parser.
- Area 04 provides webview and CLI presentation without deriving VT facts.
- Area 05 owns the one complete-path switch, conformance gate, legacy deletion,
  and switch deletion.

Unicode occupancy remains host-supplied. OSC 9 must reach an approved outcome
before the effect contract freezes. Occurrence effects retain identity and
order. History remains host-owned and revisioned. Control may encode semantic
payloads with base64 but cannot carry child output or replay ANSI. The CLI
receives semantic records and may create ANSI only in its local painter. Only
the four accepted recovery boundaries reconstruct client state.

## Completion and deletion proof

Every area has a production-path behavior proof and an authority-boundary
proof. Final completion additionally requires two independent conformance
halves, real Tauri/control/CLI/product scenarios, deliberate reversible gate
failures, and provenance-aware negative checks.

Area 05 has an explicit deletion inventory covering raw output and replay
events, ANSI reconstruction, raw Tauri/control/CLI paths, the frontend byte
queue, xterm construction and addons, all xterm dependencies and lock entries,
compatibility branches, and the migration switch itself. Neither disabled
legacy code nor fixture-only results can satisfy completion.

## Commands and evidence used

```sh
pnpm exec node --test \
  core/frontend/terminal/tests/terminalEventDecoder.test.ts \
  core/frontend/terminal/tests/terminalAttachmentBootstrap.test.ts
pnpm exec node --test \
  core/frontend/terminal/tests/terminalAttachmentBootstrap.test.ts
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalClientRuntime.test.ts
ast-grep outline \
  core/backend/src/terminal/runtime.rs \
  core/backend/src/terminal/replay.rs \
  core/backend/src/terminal/types.rs \
  core/backend/src/terminal/commands.rs \
  core/backend/src/instance/protocol.rs \
  core/backend/src/instance/control.rs \
  cli/src/terminals.rs \
  core/frontend/terminal/terminalAttachmentController.ts \
  core/frontend/terminal/terminalAttachmentBootstrap.ts \
  core/frontend/terminal/TerminalView.tsx \
  core/frontend/terminal/terminalOutputQueue.ts \
  core/frontend/platform/tauri.ts
rg -n '\[[^]]+\]\([^)]+\)' docs/plans/top-5-end-state/*.md
rg -n '^## Delivery and acceptance order$' \
  docs/plans/top-5-end-state/README.md
markdownlint docs/plans/top-5-end-state/*.md \
  docs/plans/chat/topic_end-state/*.md
git diff --check -- docs/plans/top-5-end-state \
  docs/plans/chat/topic_end-state
```

The focused tests pass. Target inventory, canonical round inventory, relative
links, the README anchor, and live module paths resolve. Markdown lint and the
scoped Git whitespace check pass.

## Final status

The planning contract is proven and the review loop is at its fixed point. The
five target plans are approved for delivery.
