# Cutover deletes the second VT

## Outcome

Every Shipctl terminal client uses the semantic path, and every legacy terminal
authority is removed. The webview, control socket, CLI, attachment recovery, and
input path cut over inside one completion gate. xterm, raw child-output events,
ANSI replay, byte adapters, and the migration switch no longer ship.

This area owns the sole migration switch from its introduction through its
deletion. It may begin comparison instrumentation while
[areas 01-04](README.md#delivery-and-acceptance-order) progress, but cannot
select the semantic path by default until their gates pass.

Completion is deletion plus durable negative proof, not a default flag pointing
at new code.

## Context and purpose

Areas 01-04 are intentionally additive while Shipctl needs a safe migration
comparison. Without a coordinated cutover and deletion area, the product would
retain:

- raw `TerminalEvent::Output` and ANSI `TerminalEvent::Replay`;
- `VtReplayEngine` and formatter-based reconstruction;
- Tauri numeric byte arrays and webview raw input;
- control-socket replay and output base64 frames;
- CLI direct replay and raw-output painting;
- xterm's parser, buffer, width, mode, selection, input, and addon paths;
- the frontend byte queue and reset/replay behavior; and
- a permanent switch capable of restoring duplicate authority.

That state would preserve the root problem even if the semantic path were
working. Final authority is an architectural absence claim and therefore needs
explicit deletion inventory, negative gates, production conformance, and a
rollback policy that does not become a permanent fallback.

## Dependencies and gate

The migration switch and shadow diagnostics can start early under this area's
ownership. Default selection requires:

- [area 01](01-host-semantic-authority-is-production.md): production semantic
  facts, commands, effects, cell occupancy, selection, and OSC 9 disposition;
- [area 02](02-semantic-protocol-reaches-every-client.md): exhaustive semantic
  protocol for Tauri, control, CLI, and webview;
- [area 03](03-client-model-owns-terminal-continuity.md): persistent model and
  bounded recovery; and
- [area 04](04-presentation-surface-achieves-parity.md): accepted webview and
  CLI presentation parity.

Gate 05 passes only after every consumer is cut over, the legacy implementation
and switch are deleted, and production plus negative conformance proves the
single-VT boundary.

“Cut over together” means every consumer is inside the same gate before legacy
deletion. It does not require one pull request or an invented atomic deployment
mechanism.

## Affected live modules and deletion inventory

### Backend terminal path

- `core/backend/src/terminal/types.rs`
  - delete raw `TerminalEvent::Output`, ANSI `TerminalEvent::Replay`,
    `TerminalReplay`, and raw semantic-path input DTOs.
- `core/backend/src/terminal/replay.rs`
  - delete `VtReplayEngine`, `format_active_screen`, cursor-cell repair,
    wrap-continuation repair, hyperlink reprinting, and formatter tests. Delete
    the module if no non-legacy responsibility remains.
- `core/backend/src/terminal/runtime.rs`
  - delete raw output publication, replay snapshots, routine replay call sites,
    and legacy subscriber branches. Keep PTY ingress and host-encoded PTY input
    internal to the actor.
- `core/backend/src/terminal/commands.rs`
  - remove legacy attach/write commands or DTO branches after all callers use
    semantic attachment and commands.
- `core/backend/src/terminal/contract.rs`
  - remove legacy samples and generated shapes after the semantic contract is
    the only current version.

### Tauri and webview

- `core/frontend/platform/tauri.ts`
  - remove numeric terminal byte-array output and arbitrary raw-write input.
- `core/frontend/terminal/terminalEventContract.json` and decoder
  - remove raw output and replay shapes.
- `core/frontend/terminal/terminalOutputQueue.ts`
  - delete the xterm byte-write queue and replay recovery role.
- `core/frontend/terminal/TerminalView.tsx`
  - remove xterm construction, `term.write`, `term.reset`, parser handlers,
    raw `onData`, addon setup, and legacy visibility behavior.
- `terminalRenderer.ts`, `terminalRendererAddons.ts`, `terminalViewport.ts`,
  `terminalTheme.ts`, `terminalCache.ts`, and styles
  - remove xterm-specific code, imports, CSS, and compatibility branches while
    retaining only presentation-only implementations from area 04.
- `terminalXtermMeasure.ts` and `core/frontend/terminal/browser.ts`
  - delete outright. `browser.ts` is the named legacy entrypoint; when it is
    gone, no consumer can reach xterm through the capability at all.
    `terminalMeasure.ts` is pure policy and stays.
- `package.json` and `pnpm-lock.yaml`
  - delete `@xterm/xterm`, Fit, Unicode 11, Web Links, and WebGL addon entries.

### Control socket and CLI

- `core/backend/src/instance/protocol.rs`
  - delete `TerminalReplayFrame` and raw output or replay event variants.
- `core/backend/src/instance/control.rs`
  - delete `TERMINAL_REPLAY_FORMAT`, replay mapping, child-output mapping, and
    raw semantic-path input decoding.
- `cli/src/terminals.rs`
  - delete `write_raw_replay`, raw-output branches, and child-byte decoding.
    Retain the area-04 local semantic painter and area-02 semantic or NDJSON
    records.

### Migration and operations

- delete the sole migration switch, legacy comparison branches, and
  comparison-only telemetry after acceptance;
- register conformance and negative checks in the repository's durable test and
  operations surface; and
- update terminal architecture and operator documentation to describe the
  semantic protocol, presentation-only clients, recovery boundaries, and
  rollback truthfully.

## Work to be done

### 1. Introduce one migration switch

Define one product-level switch that selects the complete legacy or semantic
terminal implementation. Area 05 owns its configuration, diagnostics, default,
rollback semantics, and deletion from the moment it appears.

No transport, terminal tab, renderer, CLI mode, or control consumer may create a
nested feature flag. A switched implementation must be internally coherent:
semantic host, protocol, client model, and presentation cannot be mixed with a
legacy replay baseline.

### 2. Add non-authoritative comparison diagnostics

While both paths exist, capture enough information to compare:

- semantic screen, history, cursor, palette, modes, links, prompts, selection,
  and effects;
- webview presentation facts and user-visible outcomes;
- CLI painter state and interaction outcomes;
- sequence, revision, recovery, and lifecycle; and
- packaged performance and failure behavior.

xterm is a migration oracle only. A disagreement is investigated against the
host semantic contract and independent presentation fixtures; xterm does not
override host occupancy, reflow, modes, or selection.

Comparison sampling, duration, and thresholds must come from a product or
technical authority. Report observed differences even when no authorized gate
exists.

### 3. Cut over every consumer inside one gate

Move the default for:

- desktop attachment and recovery;
- webview input and presentation;
- control-socket attach and commands;
- CLI interactive presentation and NDJSON; and
- any module-facing terminal adapter.

Characterize current control and CLI compatibility before the change. If an
approved contract requires literal child-byte identity, stop for an owner
decision because it conflicts with global single-VT closure.

Do not declare success while an infrequently used consumer still publishes or
accepts the legacy union.

### 4. Delete the full legacy inventory

Delete code, types, packages, fixtures, CSS, flags, and documentation listed
above. Remove compatibility adapters rather than leaving unreachable branches.

Valid bytes remain only at explicit boundaries:

- child PTY output enters the backend actor;
- Ghostty and the backend encode input bytes sent to the child;
- a selected semantic transport may use a binary representation;
- control JSONL may base64-encode that semantic representation; and
- the CLI painter may generate local ANSI from semantic cells.

No child output or replay ANSI crosses a Shipctl client transport. No frontend
parser or Unicode width authority remains.

### 5. Install two independent conformance halves

Build a non-circular corpus:

1. fixed PTY input and host operations produce fixed semantic state and ordered
   effects through the production backend; and
2. fixed semantic state and commands produce fixed webview and CLI presentation
   facts through the production adapters.

The second half must not call Ghostty to derive its expected presentation. The
first half must not use xterm to define expected semantics.

Exercise both halves through Tauri, control, CLI, and the packaged application,
not only direct model tests.

### 6. Add provenance-aware negative gates

Fail repository checks when:

- a frontend dependency or import introduces xterm or another VT parser;
- frontend code derives cell columns with a Unicode width table or VT parser;
- a Tauri, control, CLI, or module DTO carries child output or replay ANSI;
- a webview command exposes arbitrary raw PTY input;
- legacy replay formatting or reset/replay behavior returns;
- a terminal migration flag remains after final cutover; or
- a release bundle contains the dev-only scenario entry point.

The last one is this area's own obligation, not an import from area 04. The
scenario harness that area 04 uses to reach packaged-only capabilities is a
second entry point into the terminal surface. Deleting a second VT while
shipping a second entry point is a trade, not a cutover. The gate is
`ops/check/bin/check-release-bundle.mjs`, run by `just check release-bundle`:
it builds and scans the emitted assets for the harness global, the runner, and
the scenario ids. It also asserts the markers are present in source, so a
rename fails the gate instead of silently passing it.

Do not use blanket bans on bytes, base64, or ANSI. Prove forbidden type and
payload provenance so the gate permits backend PTY boundaries, binary semantic
codecs, control encoding, and local CLI presentation.

For every new gate, make a deliberate reversible perturbation and demonstrate
that it fails. A gate that has never detected its prohibited state is not proven.

## Boundary exclusions

This area does not:

- waive an unresolved Ghostty fact, OSC 9 effect, protocol invariant, model
  continuity defect, or presentation capability;
- invent a second parser as a rollback mechanism;
- preserve a permanent consumer-specific compatibility flag;
- define new semantic meaning during cutover; or
- turn legacy telemetry into a long-lived product subsystem.

## Acceptance criteria

1. Gates 01-04 pass on their production paths before the semantic implementation
   becomes the default.
2. Webview, Tauri, control socket, CLI, recovery, input, and module adapters use
   the semantic path and one authoritative contract.
3. No Shipctl transport carries child output or replay ANSI. Captured control
   base64 decodes only to the declared semantic codec.
4. No webview API accepts arbitrary PTY bytes. Keys, text, paste, mouse, focus,
   selection, resize, and application actions use semantic commands.
5. Raw `Output`, ANSI `Replay`, `TerminalReplay`, `VtReplayEngine`, formatter
   reconstruction, and their legacy contract variants are deleted.
6. `terminalOutputQueue`'s byte role, xterm reset or write behavior, parser
   handlers, xterm imports and CSS, all five xterm packages, and lockfile entries
   are deleted.
7. `TerminalReplayFrame`, `TERMINAL_REPLAY_FORMAT`, control raw mappings, CLI
   `write_raw_replay`, and child-byte CLI branches are deleted.
8. The single migration switch and comparison-only legacy telemetry are deleted.
   Searching configuration and consumers finds no private replacement flag. A
   built release bundle contains no scenario entry point, runner, or scenario
   id, and the check that proves it has failed under a deliberate perturbation.
9. Fixed PTY traces pass host-to-semantic conformance, and independent semantic
   fixtures pass webview and CLI presentation conformance.
10. Production scenarios cover resize, theme, focus, visibility, hidden output,
    history browsing and eviction, alternate screen, links, selection, copy and
    paste, mouse modes, Unicode clusters, IME, bell, OSC 9, title, exit, injected
    gaps, recovery, surface recreation, and close or reconcile races.
11. Packaged-app and CLI/control scenarios prove the same behavior and approved
    measured constraints as the component suites.
12. Every negative gate is registered in durable repository operations and has
    failed under a deliberate reversible forbidden change.
13. Architecture and operator documentation describes one VT authority, the
    semantic protocol, the four recovery boundaries, valid byte boundaries, and
    source rollback without a permanent escape hatch.

## How to validate

Run the full repository and packaged-product gates:

```sh
just test fast
just test rust
just test full
just check all
just check release-bundle
just modularity boundaries
```

Run scoped structural checks that prove the deletion inventory, then keep them
as durable negative tests rather than one-off shell evidence. Check dependency
manifests and the lockfile, frontend imports, event and protocol variants,
Tauri DTOs, instance control mappings, CLI branches, migration configuration,
and generated artifacts.

Exercise production scenarios through:

- a real backend runtime and PTY;
- the packaged Tauri webview;
- the instance control socket;
- interactive CLI presentation and NDJSON; and
- injected sequence gaps, base mismatches, overflow, renderer failure, and
  lifecycle races.

Run each new negative gate once with a reversible prohibited import, event
variant, raw DTO, or switch and retain evidence that the gate failed for the
intended reason. Remove the perturbation and require a clean full run.

## Stop, rollback, and completion

Stop default cutover when any upstream gate is incomplete, any product client
still requires legacy payloads, a required capability is missing, or packaged
measurements violate an approved constraint. Do not convert those failures into
private switches.

Before final deletion, rollback selects the complete legacy implementation
through the one switch. After the switch and legacy code are deleted, rollback
is a source rollback of the cutover change followed by the same full conformance
run. It is not a dormant runtime path.

The terminal refactor is complete only when the semantic implementation is the
only shipped implementation and the deletion, conformance, and negative proofs
all pass. A disabled legacy path leaves the objective unmet.
