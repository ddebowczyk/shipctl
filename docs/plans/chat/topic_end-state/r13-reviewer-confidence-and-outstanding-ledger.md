# Round 13: Confidence and outstanding ledger

From: reviewer  
To: solution owner  
Round: 13 of 22  
Purpose: reopen confidence deliberately without reopening settled work

## Ownership

I acknowledge the exclusive ownership handoff. I own only canonical rounds 13,
15, 17, 19, and 21. The solution owner owns rounds 14, 16, 18, 20, and 22 and
every file under `docs/plans/top-5-end-state/`. I will report requested target
corrections rather than editing an owner file.

## Executive finding

The single-VT end state remains the right architecture and is technically
credible. Confidence is not uniform, however. The pinned Ghostty API and the
test-only compatibility corpus make host authority substantially less risky
than the browser replacement. The largest unresolved proof is that one
non-VT browser presentation and input stack can replace all product-critical
xterm responsibilities with an acceptable fallback.

The reopened audit also found one concrete boundary error in the target plans:
PTY replies are currently grouped with client occurrence effects. They are not
client effects. Ghostty produces them for the child process, and
`RuntimeActor::handle_output` writes them back through `write_response`. They
must stay ordered inside the actor-to-PTY path and must not cross the semantic
client protocol.

The earlier approval established that the five plans formed a coherent,
execution-ready decomposition. It did not prove the unimplemented renderer,
browser semantic-input adapter, transport encoding, or compatibility choices.
Those items remain gated work, not evidence that a second VT is necessary.

## Current evidence baseline

I used `ast-grep outline` before focused reads of the live terminal code and the
pinned dependency. The material evidence is:

- `core/backend/Cargo.toml` pins `libghostty-vt` to revision
  `72ac98f292879bf9f788fcbb11238c562a1eebe6`.
- The dependency exposes `Terminal`, `RenderState`, `TrackedGridRef`, selection,
  key, mouse, paste, and focus APIs. It therefore exposes far more than an
  escape parser or active-screen formatter.
- `core/backend/src/terminal/compat.rs` proves geometry, alternate screen,
  retained history, grapheme width, style and color resolution, reflow,
  cursor, semantic prompts, child-owned colors, hyperlinks, modes, ordered
  effects, input encoders, selection, and owned values after mutation.
- The same corpus proves that the current OSC 9 notification callback does not
  expose its payload.
- `core/frontend/terminal/TerminalView.tsx` still delegates terminal state,
  input escape encoding, IME/browser behavior, selection, links, scrollback,
  bell and OSC handling, Unicode width, fit, and WebGL/DOM fallback to xterm.
- `core/frontend/terminal/terminalRenderer.ts`, `terminalMeasure.ts`,
  `terminalViewport.ts`, and `terminalScrollPin.ts` are useful presentation
  seams, but no semantic painter exists yet.
- `cli/src/args.rs` and `cli/src/terminals.rs` expose intentional byte contracts:
  raw replay/output, literal UTF-8 input, base64 arbitrary-byte input, and raw
  stdin. This makes CLI/control compatibility an owner decision, not an
  implementation detail.
- `core/backend/src/terminal/replay.rs` and `runtime.rs` remain the production
  raw-byte/replay path. The semantic compatibility evidence is not yet the
  production authority path.

## Confidence by delivery area

Confidence labels describe current evidence, not acceptance thresholds.

### 01: Host semantic authority

Architecture confidence: **high**. Delivery confidence: **medium**.

`Terminal`, `RenderState`, input encoders, selection APIs, and the compatibility
corpus show that Ghostty can own terminal meaning. The remaining risk is not
basic VT coverage. It is turning test-only access into a production projector,
defining durable history/selection anchors, and closing OSC 9 without adding a
second parser.

### 02: Semantic protocol

Architecture confidence: **medium-high**. Delivery confidence: **medium**.

The existing attachment controller, generation, sequence, snapshot, and
recovery concepts provide a viable skeleton. The semantic envelope, batching,
flow control, and concrete Tauri/control encodings still require measurement.
The target must also correct the PTY-reply boundary.

### 03: Persistent client model

Architecture confidence: **medium-high**. Delivery confidence: **medium**.

A DOM-free attachment seam already exists, so moving durable semantic state out
of xterm is incremental. What is not yet proved is atomic snapshot/delta/history
application, anchor invalidation, hidden-tab continuity, and renderer
recreation without terminal reconstruction.

### 04: Semantic presentation and input

Architecture confidence: **medium-low**. Delivery confidence: **low**.

This is the decisive confidence gap. No primary painter or independent fallback
has been selected or packaged. The current xterm integration supplies more
than glyph painting: browser/IME input, selection, hyperlinks, scrolling,
Unicode width behavior, transparency, fitting, and WebGL/DOM fallback. The
plans correctly make a spike and parity register a stop condition, but the
evidence does not exist yet.

### 05: Cutover and deletion

Architecture confidence: **high**. Delivery confidence: **conditional**.

Deleting xterm and all client VT byte paths is the correct completion proof.
Confidence is conditional on the prior four areas and on explicit closure of
the CLI/control compatibility decision. The cutover itself introduces no new
architecture.

## Outstanding claims that pass MSW

Each item below is necessary because deleting it would leave the single-VT
contract unmet or unproven.

### O1: Correct the PTY-reply boundary

Class: architecture correction.

`VtReplayEngine::feed` collects `on_pty_write` bytes and
`RuntimeActor::handle_output` writes them to the child with `write_response`.
The README and areas 01 and 02 currently list a terminal reply among client
occurrence effects. Correct them so replies remain actor-internal ordered PTY
work. Closure evidence is a protocol inventory showing no reply payload on the
Tauri, control-socket, or CLI client streams.

### O2: Close the OSC 9 notification gap

Class: dependency capability and owner decision.

`the_desktop_notification_payload_is_not_exposed` proves that the pinned
binding reports the command but not its payload. Closure requires exactly one
approved route: extend the binding, use a bounded non-state extractor, or
remove the product behavior. Any extractor must not become another terminal
state authority.

### O3: Prove stable host-issued history and selection anchors

Class: architecture feasibility.

Ghostty's `Terminal::track_grid_ref` and `TrackedGridRef` can follow cells over
scrolling, pruning, resize, and reflow, and can report invalidation. That makes
the design credible but does not define a serializable client identity. Closure
requires a host-issued anchor contract and tests across reflow, history
eviction, reset, and primary/alternate-screen transitions.

### O4: Prove semantic browser input, including IME

Class: architecture feasibility.

The Rust compatibility corpus proves mode-aware key, mouse, paste, and focus
encoders. The browser currently provides only xterm's already-encoded
`term.onData` stream. Closure requires a packaged browser spike that converts
key identity, modifiers, text composition, IME, paste, mouse, and focus into
semantic commands while the host alone emits escape bytes.

### O5: Select and prove the presentation surface and fallback

Class: architecture feasibility plus implementation measurement.

No live semantic painter exists. Closure requires a packaged spike and
capability register for the chosen primary and independent fallback paths. It
must exercise host-rendered grapheme spans, colors and attributes, cursor,
history and scrolling, selection, links, transparency, fonts, resize,
renderer failure, and the accepted notification/bell/clipboard effects. Its
performance claims must come from packaged builds on the supported webview,
not from invented limits.

### O6: Resolve CLI and control-socket byte compatibility

Class: product owner decision.

The live CLI promises raw terminal output and arbitrary child input bytes. A
semantic-only client contract cannot silently preserve those exact promises.
Closure requires either an approved semantic replacement and breaking-change
contract, or a finding that literal client-to-child byte identity is mandatory.
The latter blocks the proposed semantic-only client boundary and must return to
the owner; it must not be hidden behind a compatibility byte tunnel.

### O7: Select semantic transport encoding and flow control from evidence

Class: implementation measurement.

The semantic types do not by themselves prove a viable hot path. Closure
requires Tauri and control-socket measurements using representative semantic
snapshots, deltas, history pages, and occurrence effects, followed by one
shared fail-closed codec contract, explicit ordering, and observable
backpressure/recovery behavior. No numeric threshold is accepted without an
authoritative product requirement or measurement-derived constraint.

### O8: Prove the production authority and persistent model together

Class: implementation and integration proof.

`compat.rs` is test-only while production still emits raw output and replay.
Closure requires a production trace in which one actor mutation projects an
ordered semantic update, the client atomically applies it while visible or
hidden, renderer recreation consumes that model, and recovery uses a semantic
snapshot without replaying VT bytes in a client.

### O9: Prove cutover by conformance and deletion

Class: completion proof.

Closure requires the shared conformance corpus to pass through Tauri and the
control/CLI paths, including history, Unicode, input modes, effects, resize,
disconnect, and recovery. It then requires deletion evidence for xterm,
`Terminal.write` byte ingestion, replay text, raw client output variants, and
every alternate client parser path. A feature switch is temporary rollback
plumbing only and cannot count as completion.

## Architectural uncertainty versus deferred choice

The architecture is uncertain only where an interface may fail to represent a
required product behavior:

- stable host-issued anchors;
- raw browser events and IME mapped to semantic host input;
- a non-VT painter and independent fallback that meet the accepted capability
  register.

The following are not arguments for a second VT. They are deliberate decisions
or measurements:

- how OSC 9 is recovered or retired;
- whether CLI/control raw-byte compatibility is broken;
- which Tauri and control encoding, batch shape, and flow policy measurements
  support;
- which painter wins the packaged webview comparison.

The PTY-reply issue is neither uncertainty nor choice. It is a target-document
boundary error with a clear correction.

## Evidence the remaining nine rounds must obtain

This is an evidence queue, not a demand to manufacture one topic per round.
Rounds may close several items at once and must stop revisiting a closed item.

1. A corrected authority map that keeps PTY replies inside the actor-to-child
   path and identifies every client-visible effect.
2. A host capability packet covering the selected OSC 9 disposition, production
   semantic projection, effect ordering, and tracked-anchor lifecycle.
3. A packaged browser-input spike proving semantic keyboard, composition/IME,
   paste, mouse, and focus events through the host encoders.
4. A packaged primary/fallback presentation spike and capability register that
   makes an explicit go/no-go decision on removing xterm.
5. An owner-recorded CLI/control compatibility decision plus an end-to-end
   semantic CLI presentation and input proof consistent with it.
6. Packaged transport measurements that select the shared codec, batching, and
   backpressure/recovery policy without unauthoritative limits.
7. An end-to-end state trace proving visible/hidden updates, history paging,
   selection-anchor invalidation, renderer recreation, and semantic recovery.
8. Corrected execution plans whose acceptance criteria and validation commands
   encode the decisions above without weakening deletion gates.
9. A final fixed-point audit: shared conformance passes, the second VT and byte
   tunnels are deleted, and no remaining claim is necessary to prove the
   accepted end state.

## Claims rejected by MSW

- Vendoring Ghostty now is rejected; the revision is pinned, and ownership is
  needed only if the selected gap closure requires a maintained patch.
- Reopening scrollback retention is rejected; that enabler is already complete.
- Keeping xterm as a permanent fallback is rejected; it preserves a second VT.
- Adding unrequested search or screen-reader features is rejected; capability
  parity is limited to accepted product behavior.
- Adding another parser for OSC 9 is rejected unless it is demonstrably bounded
  to extraction and cannot hold terminal state.

## Round-13 verdict

Continue toward the single-VT end state, but do not describe implementation
confidence as high. Areas 01 through 03 have credible APIs and seams; area 04
needs executable evidence before irreversible cutover. The solution owner must
correct O1 in the target documents. The collaboration should then spend its
remaining rounds closing O2 through O8 and use O9 as the final proof, without
inventing additional concerns merely to consume rounds.
