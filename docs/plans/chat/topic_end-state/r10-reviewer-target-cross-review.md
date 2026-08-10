# Round 10 — Reviewer target cross-review

Date: 2026-08-10

Ownership: reviewer-owned canonical round. This round does not edit the target
plans or sol-owned rounds.

## Verdict

**Revise.** The five-area architecture, dependency order, and deletion contract
are ready. Two execution-blocking documentation corrections remain. Once those
commands and paths are corrected, I approve the target set without another
architectural change.

The MSW necessity test rejected every other candidate edit. The plans are
self-contained and consistently preserve the accepted boundaries: the backend
is the sole VT authority; implemented enablers remain regression gates rather
than being replanned; control and CLI receive semantic state; Unicode occupancy
comes from the host; OSC 9 has an explicit dependency gate; effects retain
ordered occurrence identity; history remains host-owned; and one area-05 switch
controls the complete-path cutover and deletion proof.

## Required correction 1 — Area 02 frontend validation cannot run

Target: `02-semantic-protocol-reaches-every-client.md`, **How to validate**.

Reason: the plan invokes Vitest against paths outside the live `tests/`
directory. This repository does not provide the claimed Vitest runner. The live
frontend test lane in `ops/test/justfile` uses Node's test runner, and the two
files are:

- `core/frontend/terminal/tests/terminalEventDecoder.test.ts`
- `core/frontend/terminal/tests/terminalAttachmentBootstrap.test.ts`

Without this correction, the decoder and atomic-bootstrap acceptance proof is
not executable from the plan.

Exact correction: replace the two `pnpm exec vitest` lines with:

```sh
pnpm exec node --test \
  core/frontend/terminal/tests/terminalEventDecoder.test.ts \
  core/frontend/terminal/tests/terminalAttachmentBootstrap.test.ts
```

## Required correction 2 — Area 03 test modules and commands are mislocated

Target: `03-client-model-owns-terminal-continuity.md`, **Affected live modules**
and **How to validate**.

Reason: the affected-module list and all three focused commands omit the live
`tests/` directory, and the commands invoke the unavailable Vitest runner. This
leaves the controller, bootstrap, and lifecycle continuity proof unexecutable.
The production test lane also serializes the controller/runtime pair.

Exact correction:

1. Replace the affected test-module entry with
   `core/frontend/terminal/tests/terminalAttachmentController.test.ts` and
   `core/frontend/terminal/tests/terminalAttachmentBootstrap.test.ts`.
2. Replace the three `pnpm exec vitest` commands with the live Node test lanes:

```sh
pnpm exec node --test \
  core/frontend/terminal/tests/terminalAttachmentBootstrap.test.ts
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalClientRuntime.test.ts
```

## Evidence and disposition

`ast-grep outline` confirms that the target plans name the live backend runtime,
replay, contract, command, instance protocol/control, CLI, frontend controller,
bootstrap, view, and output-queue seams. Focused file discovery confirms the
test locations above. Dry runs confirm that `just test fast`, `just test rust`,
`just test full`, `just check all`, and `just modularity boundaries` resolve;
those commands need no correction.

No omission was found in the semantic client coverage, CLI/control boundary,
Unicode-width rule, OSC 9 stop condition, ordered-effects path, history path,
single-switch cutover, or area-05 negative/deletion proof that would leave the
single-VT contract unmet or unproven.
