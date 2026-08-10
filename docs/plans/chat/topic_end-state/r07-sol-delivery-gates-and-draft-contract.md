# Round 07 — sol delivery gates and draft contract

- From: sol
- To: independent reviewer
- Round: 07 of 12
- Type: correction acceptance, sequencing, and drafting contract
- Evidence boundary: canonical rounds 01-06, the original closure set, and the
  live-code audit

## Ownership

This file is exclusively owned by sol. The independent reviewer owns rounds
02, 04, 06, 08, 10, and 12. Sol owns every target plan and rounds 01, 03, 05,
07, 09, and 11. Corrections cross the boundary as review findings, never as
concurrent edits.

## Round 06 corrections accepted

All five corrections are accepted and become requirements for the target set:

1. Area 02 owns the CLI semantic protocol, area 04 owns its local painter and
   parity evidence, and area 05 owns coordinated cutover and deletion.
2. Host-supplied cell occupancy is the sole Unicode column-width authority.
   The presentation surface measures pixels but cannot change spans, wrap,
   cursor columns, selection columns, or reflow.
3. OSC 9 must receive one explicit disposition before the semantic effect
   protocol freezes. Child bytes cannot be forwarded to preserve the xterm
   handler.
4. Area 05 owns the sole migration switch from introduction through deletion.
   No transport or presentation area may create a private switch.
5. The control socket may base64-encode semantic data. Its types and negative
   checks must prohibit child output and replay ANSI, not the encoding itself.

## Delivery sequence

The target plans describe authority gates, not five large pull requests. Work
may be sliced within an area while preserving these gates:

```text
01 semantic facts and commands are authoritative in production
  -> 02 all clients can exchange only those facts and commands
  -> 03 the browser can preserve them without a terminal widget
  -> 04 every product surface can present and interact with them
  -> 05 the product selects that path and deletes every legacy authority
```

Early falsification work is intentionally concurrent:

- Area 01 starts with the unresolved OSC 9 decision and production ownership
  of the feasibility fixtures.
- Area 02 measures candidate encodings and flow control against the semantic
  fixture corpus before choosing either.
- Area 04 begins the capability register, Unicode rendering spike, IME and
  accessibility probes, and CLI painter spike while areas 01-03 progress.
- Area 05 introduces the one migration switch and comparison telemetry when
  both paths exist, but cannot change the default before areas 01-04 pass.

No parallel activity changes the acceptance dependency.

## Area gates

### Gate 01 — semantic authority

Production code exposes owned cells, history, cursor, modes, colors, links,
prompts, ordered effects, and selection operations from Ghostty. It accepts
semantic input operations and uses Ghostty's active modes to encode PTY input.
Routine resize and theme changes publish semantic transitions, not ANSI
reconstruction. OSC 9 has an approved and tested disposition.

### Gate 02 — protocol equivalence

One versioned contract covers snapshots, deltas, history windows, effects, and
commands. State revision and base revision make application deterministic.
Tauri, control-socket, webview, and CLI adapters handle the same domain
exhaustively and fail closed. A semantic baseline plus deltas reconstructs the
same model without raw output or replay bytes. Encoding and flow-control choices
cite measurements or technical contracts.

### Gate 03 — continuity

The existing DOM-free attachment controller owns a renderer-independent model,
applies semantic frames atomically, and remains attached while its surface is
hidden or recreated. Deterministic traces prove history, viewport intent,
selection projection, effects, resize, stale deltas, and exactly the four
accepted recovery boundaries without xterm or a DOM.

### Gate 04 — presentation parity

The webview surface and CLI painter consume semantic state only. The accepted
capability register covers rendering, host-defined cell spans, links, selection,
clipboard, keyboard, mouse, paste, focus, IME, accessibility, lifecycle,
failure behavior, and measured performance. Any removed capability has an
explicit product-owner decision. xterm may compare results but cannot supply a
target-path fact.

### Gate 05 — deletion

The one switch changes default only after gates 01-04. Webview, control socket,
CLI, and recovery then cut over together. The legacy event variants, ANSI
formatter and replay, raw adapters, byte queue, xterm modules and packages, and
the switch are deleted. Negative checks and packaged-product scenarios prove
that a frontend VT parser and transported child output cannot return.

## Rollback boundary

Before gate 05 changes the default, rollback means selecting the unchanged
legacy implementation through the single switch. After final acceptance,
rollback cannot mean restoring dual authority through a permanent flag. It is
a source rollback of the cutover change, with the same conformance gates rerun.
The target plans must not promise a long-lived escape hatch that contradicts
the end state.

## Draft contract

The README and five target files must be self-contained and must not rely on
other plan or research directories. Each plan will contain:

- the authority outcome and why it is necessary;
- the implemented enablers it extends and does not redo;
- dependencies and the gate it authorizes;
- current modules and symbols in scope, grounded in the live audit;
- bounded work, with exclusions that protect adjacent owners;
- acceptance criteria that prove behavior and authority movement;
- validation commands or scenarios proportionate to the claim; and
- stop, rollback, and deletion conditions where applicable.

Tests cannot establish closure by themselves if their production call path is
absent. Counts, limits, performance thresholds, batching, and protocol sizes
must come from an authoritative contract or recorded measurement rather than
the plan author's preference.

## Status

Round 07 complete. All round 06 corrections are incorporated, the five gates
and rollback boundary are fixed, and the target drafting contract is ready for
independent review in round 08.
