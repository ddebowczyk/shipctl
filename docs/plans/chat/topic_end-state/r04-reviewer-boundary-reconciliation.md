# Round 04 — reviewer boundary reconciliation

- From: independent reviewer
- To: sol
- Round: 04 of 12
- Type: boundary decision
- Evidence boundary: canonical rounds 01-03, the original closure set, and the
  already-audited live code

## Decision

Adopt the five implementation seams proposed in round 02, with one ownership
correction: area 02 owns protocol capability and version negotiation, while
area 05 owns the product migration switch, cutover, and removal of that switch.

The areas form a delivery chain:

```text
01 host semantics
  -> 02 semantic protocol and adapters
  -> 03 canonical client model
  -> 04 presentation-only surface
  -> 05 global cutover and deletion
```

This chain maps to five independently provable authority boundaries. No area is
a phase label or a collection of whichever tasks remain at that point.

## Reconciled area boundaries

### 01 — host semantic authority becomes production

Area 01 owns terminal meaning inside the backend:

- the production projection from Ghostty into Shipctl-owned cells, rows,
  cursor, history, modes, colors, links, prompt metadata, and dirty regions;
- ordered semantic effects, including the explicit disposition of OSC 9;
- canonical selection meaning and selection operations; and
- mode-aware key, paste, mouse, and focus encoding before bytes reach the PTY.

Its public result is an owned in-process domain model plus semantic commands and
effects. It does not own subscriber baselines, serialization, transport
encoding, frontend state, browser gestures, or rendering.

Area 01 is complete only when production runtime behavior can be exercised
without formatting Ghostty state back into ANSI and without asking xterm to
interpret input modes.

### 02 — semantic protocol replaces raw VT at every adapter

Area 02 owns the boundary between the host domain and every client:

- versioned snapshot, delta, history-window, effect, and command schemas;
- state revision, base revision, ordering, capability negotiation, and recovery
  semantics;
- fail-closed Rust and TypeScript adapters derived from one authoritative
  contract;
- Tauri, control-socket, and CLI representations; and
- measured selection of the transport encoding and its flow-control behavior.

It translates area 01 domain values but does not define terminal meaning. It
does not own the renderer-independent client model or presentation. It may
provide both legacy and semantic protocol implementations for migration, but
it does not choose which implementation is the product default and does not
remove the legacy path. Those decisions belong to area 05.

Area 02 is complete only when no semantic client needs child PTY bytes or ANSI
replay and all adapters prove the same ordering and recovery contract.

### 03 — attachment owns the canonical client model

Area 03 owns renderer-independent client continuity:

- application of semantic snapshots, deltas, history windows, and effects;
- sequence and base-revision validation;
- viewport intent and projected selection state;
- explicit history requests and bounded recovery; and
- an attachment lifetime independent from surface visibility or DOM lifetime.

It evolves the existing `TerminalAttachmentController` seam rather than
creating a parallel protocol state machine. The model may expose selected cells
for presentation, but canonical selection meaning remains in area 01. The
surface sends gestures as semantic operations and renders the resulting model.

Area 03 does not measure glyphs, draw cells, interpret ANSI, encode VT input, or
choose the product migration path.

### 04 — presentation-only surface reaches capability parity

Area 04 owns browser presentation and user interaction:

- cell geometry, glyph measurement, drawing, damage consumption, and viewport
  composition;
- pointer, keyboard, IME, focus, paste, and accessibility integration;
- translation of browser events into the semantic commands accepted by areas
  01-03;
- rendering of selection, cursor, links, themes, fonts, wide cells, and
  grapheme clusters; and
- the capability register, conformance fixtures, and performance evidence that
  prove the replacement is acceptable.

It never parses child output, derives terminal modes, owns history, or decides
selection semantics. Capability discovery starts while area 01 is being built
because it can falsify the proposed surface early, but the register and its
acceptance evidence remain deliverables of area 04.

Area 04 is complete only when the new surface has parity without xterm acting
as a parser, model, input encoder, selection authority, or measurement oracle.

### 05 — global cutover removes duplicate authority permanently

Area 05 owns the product transition and deletion boundary:

- the explicit migration switch and the criteria for changing its default;
- side-by-side diagnostics needed to prove semantic-path parity;
- coordinated cutover of the webview, control socket, CLI, and recovery paths;
- removal of `Output`, ANSI `Replay`, `VtReplayEngine`, the byte output queue,
  xterm packages and adapters, raw/base64 terminal streams, and the switch
  itself; and
- negative dependency checks plus packaged-app conformance and rollback
  evidence.

Area 05 does not invent missing semantics or accept surface capability debt.
Areas 01-04 must already satisfy their contracts before the legacy path can be
deleted.

## Resolution of the three round 02 decisions

### Decision 1 — accept with one boundary correction

**Accept** the five implementation seams as the canonical decomposition.

**Correct** area 02 by moving ownership of the product migration switch to
area 05. Area 02 still owns protocol version and capability negotiation and may
host both adapter implementations. Area 05 alone owns default selection,
cutover, rollback, and final switch deletion.

### Decision 2 — accept

**Accept** the split between host projection and wire contracts.

Area 01 owns the semantic read model and domain operations. Area 02 owns
snapshot/delta/history serialization, subscriber baselines, revisions, and
transport recovery. A delta is not merely a host projection optimization; its
meaning depends on a client baseline and therefore belongs to the protocol
boundary.

### Decision 3 — accept

**Accept** immediate capability-register work as a subtrack of area 04, not a
standalone top-five area.

The register starts early because an unavailable accessibility, IME, glyph, or
input capability can invalidate the surface design. It stays in area 04 because
its purpose is to define and prove presentation parity, not to create another
architectural authority.

## Reconciled completed-versus-remaining status

The enablers should be extended in their assigned areas:

- `compat.rs` seeds area 01's production semantics but remains test-only;
- `retention.rs` is completed policy work that area 01 preserves;
- `contract.rs` and `terminalEventDecoder.ts` seed area 02's fail-closed
  semantic contract but currently describe raw output and replay;
- `TerminalAttachmentController` seeds area 03 but still exposes byte/replay
  ports;
- `TerminalClientRuntime` preserves the single registry writer and typed
  lifecycle outcomes; and
- the current xterm view, output queue, control adapter, and CLI raw mode are
  legacy paths to replace and delete across areas 04 and 05.

No completed enabler establishes a competing ownership model, so none needs to
be redone. None closes the production single-VT authority boundary either.

## Status

Round 04 complete. The three round 02 decisions are resolved, the five area
boundaries are mutually exclusive at the authority level, and the only change
from round 02 is the migration-switch ownership correction. No target plan was
created or edited.
