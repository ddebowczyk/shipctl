# Round 06 — reviewer five-area challenge

- From: independent reviewer
- To: sol
- Round: 06 of 12
- Type: necessity, boundary, and sufficiency challenge
- Evidence boundary: canonical rounds 01-05, the original closure set, and the
  already-audited live code

## File ownership handoff

The ownership handoff is accepted:

- sol exclusively owns every file under `docs/plans/top-5-end-state/` and
  canonical rounds 01, 03, 05, 07, 09, and 11;
- the independent reviewer exclusively owns canonical rounds 02, 04, 06, 08,
  10, and 12; and
- either reviewer reports a correction to the owner instead of editing the
  owner's file.

This round edits only this reviewer-owned file.

## Verdict

All five areas pass the necessity test. Deleting any one leaves either a second
VT authority, a raw child-output boundary, no durable frontend model, no viable
replacement surface, or a permanent dual-path migration.

The decomposition is sufficient with three required boundary corrections:

1. Area 04 must own all Shipctl presentation adapters, including the CLI's
   semantic-state-to-local-terminal painter. Area 02 owns the CLI protocol and
   command adapter, but must not own rendering.
2. Unicode column occupancy is exclusively host meaning. Area 04 owns pixel and
   glyph measurement inside host-supplied cell spans, never a competing width
   table, reflow rule, or cursor calculation.
3. Area 05 owns the only migration switch from the moment shadow comparison
   starts, even if that work overlaps areas 02-04. No earlier area may create a
   private or consumer-specific switch.

The known OSC 9 gap remains a hard stop before area 02 can freeze the semantic
effect protocol.

## Area-by-area challenge

### 01 — host semantic authority is necessary and bounded

**Necessary:** Without a production owned projection and host input encoders,
xterm must continue to derive usable cell meaning and terminal modes. Areas
02-05 cannot manufacture semantics that area 01 does not expose.

**Current grounding:** Extend `core/backend/src/terminal/compat.rs` into the
production terminal domain used by `runtime.rs`. Replace the formatter role of
`replay.rs`; evolve the raw `Output` and `Replay` values in `types.rs`; preserve
the measured policy in `retention.rs` and `service.rs`.

**Boundary:** Area 01 owns cells, history, wrap, cursor, mode, color, link,
prompt, selection, effects, and terminal-aware input encoding. It does not own
wire baselines, TypeScript state, pixel layout, or transport batching.

**Stop condition:** Stop before area 02 freezes schemas if a required semantic
fact, effect, selection operation, or input mode cannot be represented by an
owned host value. Return the falsifying fixture and dependency options to the
owner. Do not preserve xterm as an exception.

**Accepted:** Area 01 is one delivery area and its production projection is
separate from area 02's subscriber delta contract.

### 02 — one semantic protocol is necessary and bounded

**Necessary:** Host-only semantics do not remove the second authority while
Tauri, the control socket, or the CLI still carry child PTY bytes or replay
ANSI. All clients need one ordered meaning with exhaustive adapters.

**Current grounding:** Replace the legacy union in
`core/backend/src/terminal/types.rs`; extend the fail-closed pattern in
`terminal/contract.rs`, `terminalEventContract.json`, and
`terminalEventDecoder.ts`; replace the adapters in `terminal/commands.rs`,
`frontend/platform/tauri.ts`, `instance/protocol.rs`, `instance/control.rs`, and
the CLI attachment protocol.

**Boundary:** Area 02 owns versioned snapshots, deltas, history windows,
effects, commands, sequence and base revision, encoding, flow control, and
transport-specific DTOs. It does not own terminal semantics, client model
mutation, or presentation.

**Stop condition:** Stop before area 03 adopts the protocol if snapshot plus
delta cannot reconstruct the same model, if recovery mixes a semantic baseline
with raw live output, if measured transport behavior cannot meet an approved
product constraint, or if any adapter cannot express the domain exhaustively.
Limits and batching remain derived from technical contracts and measurements.

**Required correction:** The CLI presentation prototype named by the original
closure contract cannot live here as rendering work. Area 02 must deliver the
semantic CLI/control protocol and fixtures; area 04 must prove the local
terminal painter before area 05 cutover.

### 03 — the canonical client model is necessary and bounded

**Necessary:** Removing xterm's parser without replacing its durable browser
buffer would move terminal authority into React or the new renderer. A
renderer-independent model is the only stable recipient for semantic frames.

**Current grounding:** Evolve `TerminalAttachmentController` and its bootstrap
and trace tests. Replace byte/replay ports and `terminalOutputQueue` with atomic
model application and history-window behavior. Keep descriptor membership in
`TerminalClientRuntime`; uncouple attachment lifetime from the visibility
effect in `TerminalView.tsx`.

**Boundary:** Area 03 owns decoded-state application, revision checks, viewport
intent, projected selection, history cache/window state, effect delivery, and
recovery. The host remains the authority for selection meaning and input modes;
the surface remains the authority for pixels and browser events.

**Stop condition:** Stop before area 04 integration if deterministic traces
cannot preserve state through hidden output, reordered or stale deltas,
history eviction, resize, and the four approved recovery boundaries without
consulting xterm or the DOM.

**Accepted:** Extend the existing controller seam; do not add a parallel model
manager or let `TerminalClientRuntime` become a second attachment state machine.

### 04 — presentation parity is necessary, with broadened scope

**Necessary:** xterm cannot be deleted until every product capability it
currently supplies is either implemented by presentation over semantic state
or removed from the product contract by an explicit owner decision.

**Current grounding:** Replace `TerminalView.tsx`, `terminalMeasure.ts`,
`terminalRenderer.ts`, `terminalRendererAddons.ts`, `terminalViewport.ts`,
`terminalTheme.ts`, `terminalCache.ts`, and xterm-dependent queue behavior.
Remove reliance on the five xterm packages after area 05 cutover. Add the CLI
local presentation adapter beside `cli/src/terminals.rs`.

**Boundary:** Area 04 owns drawing, pixel geometry, font metrics, browser and
local-terminal interaction, IME, accessibility, links, clipboard integration,
and presentation failure fallback. It consumes host cell spans and semantic
commands. It does not parse child output, choose terminal modes, own history,
or reconstruct canonical state from locally generated presentation sequences.

**Stop condition:** Stop area 05 cutover if the capability register contains an
unimplemented and unapproved requirement, if the surface needs a frontend
width or VT parser, or if measured packaged-app behavior violates an approved
constraint. A named product-contract change can remove a capability; silence
cannot.

**Required correction:** Describe area 04 as all Shipctl-owned presentation,
not only the browser surface. The CLI adapter may generate ANSI locally to
paint semantic cells in the caller's terminal. That external terminal renders
the generated output, but neither it nor Shipctl receives the child PTY stream
or becomes canonical state.

### 05 — global cutover and deletion are necessary and bounded

**Necessary:** Areas 01-04 are additive migration. Until the raw/replay path,
xterm, and the migration switch are deleted, Shipctl still ships two VT
authorities and can regress to the old path.

**Current grounding:** Delete legacy variants and formatter code in backend
terminal modules, raw/replay mappings in the control protocol and CLI, xterm
frontend modules and packages, the byte queue, and the visibility-coupled
attachment path. Add negative gates under the repository's operations test
surface and exercise the packaged application.

**Boundary:** Area 05 owns switch creation, default selection, rollback,
coordinated consumer cutover, legacy deletion, and permanent conformance. It
does not waive missing semantics or presentation capabilities.

**Stop condition:** Do not switch the default until areas 01-04 pass their exit
conditions for the production path. Do not claim closure until the switch is
gone and negative checks prove that no Shipctl adapter transports child output
or replay ANSI and no frontend parser remains.

**Accepted with timing clarification:** Area 05 may begin the one switch and
shadow-comparison instrumentation while upstream delivery is in progress. It
cannot select the semantic path as default until the dependency gates pass, and
the switch cannot survive final acceptance.

## Unicode width risk

The current view activates xterm's Unicode 11 addon, while the compatibility
fixture proves that Ghostty exposes grapheme text plus wide and spacer-tail
cells. The target must make the ownership rule stronger than “the values
usually agree”:

- the semantic frame carries the exact cell occupancy already decided by the
  host, including wide leads and continuation/spacer cells;
- cursor, selection, hit testing, wrap, and reflow use host columns;
- the frontend may measure fonts only to size the cell grid and place glyphs
  inside the supplied span;
- no frontend `wcwidth`, Unicode-version table, canvas text width, or browser
  grapheme result may alter column occupancy; and
- conformance joins the host projection fixture to surface facts for combining
  marks, wide cells, variation and joiner sequences, and fallback fonts.

If the surface cannot paint a host cluster without changing its column span,
that is a presentation failure or an approved product limitation. It is not
permission to reintroduce a frontend terminal-width authority.

## OSC 9 risk

OSC 9 is current product behavior: `TerminalView.tsx` parses it and raises a
desktop notification. The pinned parser recognizes the command but exposes no
safe payload callback, as the compatibility fixture proves.

Area 01 must close this before the semantic effect union is frozen by one of the
originally authorized outcomes:

1. extend the owned Ghostty dependency/binding to expose the ordered payload;
2. approve a bounded host-side effect decoder that consumes ordered ingress,
   cannot mutate VT state, and has no general screen or mode parser; or
3. explicitly remove OSC 9 notifications from the product contract with a
   named owner decision.

The second option is not a VT authority if it remains a single-purpose effect
extractor, but its scope must be enforced by its API and falsification tests.
Leaving the xterm handler or forwarding PTY bytes to recover the payload fails
the end state.

## Control socket and CLI scope

The control socket is in scope even when the desktop path is green. It may keep
JSONL and may base64-encode a selected binary semantic codec, but base64 must
contain semantic frames, never child PTY bytes or replay ANSI. Therefore the
negative proof must trace payload origin and types; a blanket ban on the word
`base64` would reject a valid transport adapter.

The CLI divides across the established boundaries:

- area 02 owns semantic attach and command DTOs, version negotiation, exhaustive
  event handling, JSONL behavior, and transport fixtures;
- area 04 owns the local presentation adapter that paints semantic cells and
  captures interaction without parsing child output; and
- area 05 cuts over `--raw` and NDJSON behavior together, deletes
  `write_raw_replay` and raw-output branches, and removes the compatibility
  switch.

Before cutover, characterize cursor, alternate screen, resize, scrollback,
signals, job control, interactive input, raw presentation, and NDJSON. If the
approved CLI contract requires literal child byte identity, stop for an owner
decision: that contract conflicts with global single-VT closure.

## Sequencing and stop-gate audit

The authority dependency remains 01 -> 02 -> 03 -> 04 -> 05, with feasibility
work allowed in parallel. The gates are:

1. Area 01 host semantics and the OSC 9 disposition authorize protocol freeze.
2. Area 02 equivalence, recovery, adapter completeness, and packaged transport
   evidence authorize client-model adoption.
3. Area 03 DOM-free state traces authorize presentation integration.
4. Area 04 webview and CLI presentation parity authorize the default cutover.
5. Area 05 deletion and negative conformance authorize completion.

The capability register, Unicode rendering spike, transport measurement, and
CLI presentation spike should start early because they can stop investment.
They do not weaken the acceptance order. No downstream green result can waive
an upstream authority failure.

## Accepted decisions and required corrections

Accepted:

- all five files and authority areas selected in round 05 are necessary;
- projection stays in area 01 and subscriber delta semantics stay in area 02;
- the existing contract, controller, registry, and retention enablers are
  extended rather than redone;
- one migration switch is owned and deleted by area 05; and
- control socket and CLI closure are mandatory, not optional compatibility
  follow-up.

Corrections for the sol-owned target plans:

1. Put the CLI protocol in area 02, its local painter and parity evidence in
   area 04, and its coordinated cutover and raw-path deletion in area 05.
2. Make host-supplied cell occupancy the only Unicode width authority and ban
   frontend column-width decisions explicitly.
3. Make OSC 9 a gate before semantic protocol freeze, with only the three
   recorded outcomes above.
4. State that area 05 owns the sole switch from its introduction, not only at
   final cutover.
5. Permit base64 only as a control-socket encoding of semantic data; prohibit
   child bytes and replay ANSI by type and provenance.

## Status

Round 06 complete. All five areas survive the necessity challenge. The required
corrections tighten presentation ownership, Unicode-width authority, OSC 9,
migration timing, and control/CLI closure without adding a sixth area. No
sol-owned coordination or target-plan file was edited.
