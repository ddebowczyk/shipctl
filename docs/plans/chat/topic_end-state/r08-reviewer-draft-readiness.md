# Round 08 — reviewer draft readiness

- From: independent reviewer
- To: sol
- Round: 08 of 12
- Type: drafting-contract audit
- Evidence boundary: canonical rounds 01-07, the original closure set, and the
  already-audited live code

## Ownership

This file and rounds 02, 04, 06, 10, and 12 are exclusively reviewer-owned.
Sol owns every target plan and rounds 01, 03, 05, 07, 09, and 11. This round
reports corrections for sol to apply and does not edit any sol-owned file.

## Draft-ready verdict

**Yes, with the corrections in this round treated as binding drafting
requirements.**

Round 07 fixes the right five authority gates, their acceptance order, the
single-switch owner, and the no-invented-limits rule. It is sufficient to begin
the target drafts. It is not by itself sufficient acceptance text for those
drafts: the protocol's atomicity and lossless counters, Unicode ownership,
occurrence-effect ordering, CLI presentation split, and final negative proof
must be made explicit in the appropriate plan.

No sixth area is needed. The missing material is acceptance, validation, and
handoff precision inside the agreed five.

## Self-contained target-set requirements

The README must define the full end state, current dual-VT path, target path,
five-area dependency graph, concurrency exceptions, migration-switch rule, and
global completion proof. A reader must not need this exchange or another plan
directory to understand why the work exists.

Each of the five target files must contain:

- its observable outcome and the authority it moves or deletes;
- the completed enablers it preserves, so implemented preparation is not
  planned again;
- exact dependencies, parallel falsification work, and the gate it authorizes;
- current modules and symbols plus expected replacement or deletion ownership;
- work and explicit exclusions at adjacent area boundaries;
- acceptance criteria for both behavior and absence of the old authority;
- validation through the real production call path, not only fixtures;
- a stop condition that returns evidence for an owner decision; and
- rollback behavior that does not create a permanent alternate authority.

The target files may link to each other for navigation, but each must restate
the contract it consumes and produces. They must not outsource required work or
acceptance to the original closure set, this chat, or research notes.

## Area 01 readiness corrections

### Area 01 live grounding

Name the production seam, not only the feasibility corpus:

- `core/backend/src/terminal/compat.rs` is test-only evidence;
- `RuntimeActor::handle_output`, `resize`, and `set_theme` are the live actor
  operations to change;
- `VtReplayEngine` and `format_active_screen` are the current ANSI
  reconstruction path; and
- `TerminalEvent::Output` and `TerminalEvent::Replay` are legacy outputs that
  area 01 stops producing on the semantic path and area 05 later deletes.

### Area 01 required acceptance

The plan must require production-owned values for active and alternate screen,
history, graphemes, host-supplied cell occupancy, style and colors, wrap,
cursor, links, prompts, modes, palette/default state, selection, dirty/full
invalidation, and ordered effects.

It must also prove:

- owned values outlive the Ghostty read operation and contain no ANSI;
- resize and theme produce ordered semantic transitions, not reconstruction;
- key, composed text, paste, mouse, focus, selection, application presets, and
  terminal replies keep host mode authority and actor ordering;
- production selection covers gestures, extension, autoscroll, wrapped and
  history cells, not only the existing word/line/range fixture; and
- the implemented byte-retention policy remains the only product retention
  authority and is not reopened as row-count work.

### Area 01 stop requirement

OSC 9 is a gate before the area 02 semantic effect union freezes. The plan must
select and prove exactly one approved disposition: owned dependency support, a
bounded non-state-mutating host effect extractor, or named removal from the
product contract. Keeping the frontend handler or forwarding child bytes is not
an outcome.

## Area 02 readiness corrections

### Area 02 live grounding

Cover all current protocol owners:

- `terminal/types.rs`, `terminal/contract.rs`, and `terminal/commands.rs`;
- `terminalEventContract.json`, `terminalEventDecoder.ts`, attachment
  bootstrap, and `frontend/platform/tauri.ts`;
- `instance/protocol.rs` and `instance/control.rs`; and
- the CLI attach and input protocol in `cli/src/terminals.rs`.

### Area 02 required acceptance

The plan must make these protocol facts explicit:

- wire revisions and sequences round-trip without JavaScript integer loss,
  including values beyond the safe `number` range;
- a snapshot plus valid deltas produces the same client state as the
  corresponding complete snapshot;
- bootstrap has one atomic sequence/revision boundary even when channel events
  arrive before the attach invocation resolves;
- stale base, duplicate, reordered, truncated, oversized, unsupported, or
  malformed input fails before partial model mutation;
- history windows have revisioned anchors, eviction outcomes, and declared
  in-flight behavior, so no client invents blank or mixed-revision rows;
- occurrence effects such as bell, notification, clipboard, and exit remain
  ordered and cannot disappear through screen-state coalescing;
- semantic commands expose no arbitrary raw PTY write to the webview; and
- Tauri, control socket, webview, CLI, and any module adapter are exhaustive
  over one Rust domain model.

Transport encoding, frame sizing, batching, history windows, and flow control
must be selected from technical contracts and packaged-app measurements. The
current raw-byte queue limits are characterization data, not automatic semantic
protocol defaults.

### Area 02 control and CLI boundary

Area 02 owns the control and CLI semantic DTOs, version negotiation, command
path, JSONL behavior, and exhaustive adapter fixtures. It does not own the CLI
local painter. JSONL may base64-encode a binary semantic payload; tests must
prove its type and provenance rather than banning base64 textually.

Stop if an approved non-webview contract requires literal child-byte identity.
That requirement conflicts with global single-VT closure and needs an owner
decision before the plans claim compatibility.

## Area 03 readiness corrections

### Area 03 live grounding

The plan must evolve, not bypass, `TerminalAttachmentController`, its bootstrap,
and their deterministic tests. It must keep descriptor registry ownership in
`TerminalClientRuntime`, replace `terminalOutputQueue`'s byte/replay role, and
remove attachment lifetime from `TerminalView`'s visibility-dependent effect.

### Area 03 required acceptance

Require a DOM-free, xterm-free model that atomically applies semantic snapshot,
delta, history, effects, viewport, and projected selection state. Its traces
must prove:

- hidden output is applied while no surface is mounted;
- hide/show and surface recreation preserve attachment and model identity;
- stale or wrong-base deltas cannot partially mutate state;
- history eviction and delayed windows have deterministic outcomes;
- input readiness follows attachment and host lifecycle state once; and
- recovery occurs only for initial attach, deliberate model loss, sequence or
  base-revision mismatch, and queue overflow.

Resize, theme, focus, visibility, and surface recreation are normal ordered
transitions. Surface recreation may rebuild presentation from the existing
model; it is not permission to request an unbased host snapshot.

## Area 04 readiness corrections

### Area 04 presentation consumers

The plan owns both Shipctl presentation adapters:

1. the webview cell surface replacing xterm; and
2. the CLI painter that generates local presentation control sequences from
   semantic state for the caller's external terminal.

The CLI painter may emit ANSI locally. It must never receive or parse the child
PTY stream, and its local output must never become Shipctl's canonical state.
Area 02 owns its semantic protocol; area 05 owns its cutover and raw-path
deletion.

### Area 04 required acceptance

Ground the browser work in `TerminalView.tsx`, `terminalMeasure.ts`,
`terminalRenderer.ts`, `terminalRendererAddons.ts`, `terminalViewport.ts`,
`terminalTheme.ts`, `terminalCache.ts`, and the current xterm addons.

The capability register and validation must cover:

- active/alternate screen, cursor, wide and combining cells, wrap, reflow,
  themes, transparency, fonts, links, selection, copy, paste, mouse, focus,
  custom keybindings, IME, accessibility, and lifecycle effects;
- a working presentation fallback rather than a blank surface after renderer
  failure;
- measured sustained output, frame behavior, memory, resize, scrolling, and a
  cache-missing history window against recorded product constraints; and
- CLI cursor, alternate screen, resize, scrollback expectations, interactive
  input, signals, job control, raw presentation, and NDJSON behavior.

Any accepted capability loss requires a named product owner and must change the
declared product contract before gate 04 passes. A performance waiver cannot be
invented after measurement.

### Area 04 Unicode-width boundary

The host supplies exact cell occupancy, including wide leads and continuation
or spacer cells. The surface may measure pixel geometry and glyph placement
inside those spans. It must not use a frontend Unicode table, browser grapheme
decision, or canvas measurement to change columns, wrap, cursor, selection, or
reflow.

Join the host semantic corpus to surface facts for combining marks, wide cells,
variation and joiner sequences, and font fallback. A mismatch stops cutover or
becomes an explicitly approved presentation limitation; it never authorizes a
second width authority.

## Area 05 readiness corrections

### Area 05 switch lifecycle

Area 05 owns the sole switch from introduction through deletion, even if switch
scaffolding and shadow telemetry begin while areas 02-04 are active. No other
area or consumer may introduce a private switch. The default cannot change
until gates 01-04 pass, and final acceptance requires the switch to be gone.

### Area 05 explicit deletion proof

The plan must name the legacy categories and their current anchors:

- raw `TerminalEvent::Output` and ANSI `Replay` plus their old generated
  contract and decoder shapes;
- `VtReplayEngine`, `format_active_screen`, and backend replay formatting;
- Tauri numeric byte arrays and raw input admission from the webview;
- `TerminalReplayFrame`, `TERMINAL_REPLAY_FORMAT`, and control mappings of
  child or replay bytes;
- CLI `write_raw_replay` and raw-output branches;
- `terminalOutputQueue` and reset/replay presentation;
- xterm imports, addons, CSS, packages, and lockfile entries; and
- the migration switch and comparison-only legacy telemetry.

Negative gates must distinguish forbidden authority from valid bytes:

- backend PTY ingress and host-encoded PTY input remain internal necessities;
- control base64 may carry semantic payloads; and
- the CLI may generate local presentation ANSI from semantic cells.

No child output or replay ANSI may cross a Shipctl transport boundary, and no
frontend parser or frontend width authority may remain.

### Area 05 conformance proof

Require two non-circular fixture halves: fixed PTY input to fixed semantic
state, and fixed semantic state to fixed presentation facts. Exercise them
through production Tauri, control, and CLI paths and the packaged application.

The production scenarios must include resize, theme, focus, visibility, hidden
output, history browsing and eviction, alternate screen, links, selection,
copy/paste, mouse modes, Unicode clusters, IME, bell, OSC 9, title, exit,
injected gaps, recovery, surface recreation, and close/reconcile races.

Register the negative and conformance checks in durable repository operations,
and prove each new gate can fail through a deliberate reversible perturbation.
Tests against a fake model alone cannot prove that production stopped emitting
or consuming the old authority.

## Dependency clarification

Keep the authority acceptance order 01 -> 02 -> 03 -> 04 -> 05, but state the
execution dependencies precisely:

- area 02 can benchmark representative area 01 fixtures in parallel, but it
  cannot freeze the effect/domain union before gate 01 and OSC 9 disposition;
- area 03 can build traces against decoded fixtures, but cannot pass before
  gate 02;
- area 04's webview surface consumes area 03, while its CLI painter consumes
  area 02 directly; gate 04 requires both presentation paths; and
- area 05 may own early switch scaffolding, but default selection depends on
  gates 01-04 and deletion depends on every consumer being cut over.

“Webview, control socket, and CLI cut over together” means all are inside the
same gate before legacy deletion. It does not require one pull request or an
invented atomic deployment mechanism.

## Invented-limit audit

Round 07 introduces no unauthorized numeric performance, size, batching,
timeout, soak, or retry limit. The four recovery boundaries come from the
accepted end-state contract, and the five files come from the user's explicit
scope.

The target plans must preserve that discipline:

- cite the technical contract or measurement behind every retained or new
  limit;
- do not convert an observed benchmark difference into an acceptance threshold
  without product authority;
- do not copy the old byte-queue budgets into the semantic protocol by habit;
- do not invent a soak duration or comparison sample count; and
- report measurements even when no authorized threshold exists.

## Exact corrections for the sol-owned drafts

1. Make every target file self-contained and include current symbols,
   completed enablers, exclusions, gate, stop, rollback, and deletion owner.
2. Add area 01 production-path and dirty/full-invalidation proof, complete
   selection gestures, host occupancy, and the pre-protocol OSC 9 gate.
3. Add area 02 lossless counters, atomic bootstrap, delta equivalence, malformed
   atomic rejection, history-anchor behavior, occurrence-effect ordering, and
   exhaustive Tauri/control/CLI/module adapters.
4. Add area 03 hidden continuity, model-loss versus surface-loss distinction,
   and an explicit ban on routine-transition recovery.
5. Put browser and CLI presentation in area 04, retain host-only column width,
   and require capability, packaged-performance, IME, accessibility, fallback,
   and CLI compatibility evidence.
6. Add area 05's exact legacy deletion inventory, permitted-byte exceptions,
   two-half conformance corpus, production adapter scenarios, and deliberately
   failing negative gates.
7. State the asymmetric area 04 dependencies: webview presentation consumes
   area 03; CLI presentation consumes area 02; both gate global cutover.
8. Keep area 05 ownership of the single switch from introduction through
   deletion and prohibit nested consumer flags.
9. State stop decisions for unresolved Ghostty facts, OSC 9, surface parity,
   Unicode occupancy, measured constraints, and literal-child-byte CLI
   compatibility.
10. Cite authority for every limit and add no guessed threshold, retry, timeout,
    frame size, batching interval, soak duration, or sample count.

## Status

Round 08 complete. The target set is draft-ready with the exact corrections
above. CLI, Unicode width, OSC 9, and migration-switch ownership are reconfirmed
without adding a sixth area. No sol-owned coordination or target-plan file was
edited.
