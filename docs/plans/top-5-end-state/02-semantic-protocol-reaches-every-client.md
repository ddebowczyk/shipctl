# Semantic protocol reaches every client

## Outcome

One versioned protocol carries Shipctl terminal meaning and commands across
every client boundary. Snapshots, deltas, history windows, occurrence effects,
lifecycle, and semantic input share one Rust domain model, lossless ordering,
and fail-closed adapters.

The webview, control socket, and CLI no longer require child PTY output or ANSI
replay to consume the semantic path. Transport representations may differ, but
their decoded meaning and recovery contract cannot.

This area consumes the production host domain from
[area 01](01-host-semantic-authority-is-production.md) and supplies decoded
state to the persistent model in
[area 03](03-client-model-owns-terminal-continuity.md). It supplies semantic CLI
data to the painter in
[area 04](04-presentation-surface-achieves-parity.md). The sole migration switch
and final legacy deletion belong to
[area 05](05-cutover-deletes-the-second-vt.md).

## Context and purpose

The current exhaustive contract validates the wrong payload for the end state:

- `TerminalEvent::Output` carries raw child bytes;
- `TerminalEvent::Replay` carries a `TerminalReplay` of reconstructed ANSI;
- Tauri serializes those bytes through `Channel<TerminalEvent>` and the
  frontend accepts `Channel<unknown>` before fail-closed decoding;
- frontend input uses `Array.from(bytes)` and Rust accepts `Vec<u8>`;
- the control protocol maps output and replay to base64 fields; and
- the CLI decodes replay and output and writes them directly to stdout.

The implemented contract enabler is valuable: `terminal/contract.rs`,
`terminalEventContract.json`, and `terminalEventDecoder.ts` exhaustively sample
and reject the legacy union. The semantic protocol must evolve that one gate
rather than create an ungated parallel envelope.

The existing attachment bootstrap also handles a real ordering hazard: channel
events can arrive before the attach invocation returns. Its pattern must be
preserved while the bootstrap boundary grows from sequence-only raw events to
sequence plus semantic state revision.

## Dependencies and gate

Area 01 must define production semantic facts, commands, revision points, and
the approved OSC 9 outcome before this area's effect and domain union freezes.
Encoding and flow-control measurement may begin against representative area-01
fixtures before that gate.

Gate 02 passes when all adapters can exchange the same semantic model and
commands without raw child output, replay ANSI, integer loss, partial mutation,
or transport-specific terminal meaning.

Area 03 can build traces against checked-in decoded fixtures in parallel, but
cannot pass until this gate is production-complete.

## Affected live modules

### Backend domain and Tauri

- `core/backend/src/terminal/types.rs`
  - evolve the legacy `TerminalEvent` and `TerminalReplay` surface into
    versioned semantic frames and commands.
- `core/backend/src/terminal/contract.rs`
  - remain the exhaustive Rust source for the checked-in cross-language
    contract and representative fixtures.
- `core/backend/src/terminal/commands.rs`
  - replace raw attach and write DTOs on the semantic path.
- `core/backend/src/terminal/runtime.rs`
  - publish domain transitions to subscriber baselines and accept semantic
    commands through the actor.

### Webview adapter

- `core/frontend/terminal/terminalEventContract.json`
- `core/frontend/terminal/terminalEventDecoder.ts`
- `core/frontend/terminal/terminalAttachmentBootstrap.ts`
- `core/frontend/terminal/terminalAttachmentController.ts`
- `core/frontend/platform/tauri.ts`

The decoder and bootstrap change here. The controller's durable model changes
in area 03.

### Control socket and CLI

- `core/backend/src/instance/protocol.rs`
  - replace `TerminalReplayFrame` and raw `TerminalControlEvent` variants with
    versioned semantic DTOs and commands.
- `core/backend/src/instance/control.rs`
  - replace `TERMINAL_REPLAY_FORMAT`, replay mapping, output mapping, and raw
    input decoding for the semantic path.
- `cli/src/terminals.rs`
  - consume and emit semantic attach, command, and NDJSON records. The local
    terminal painter remains area 04 work.

Any removable module that exposes terminal events must adapt the same exported
domain through the established terminal entrypoint. It cannot define a private
terminal event union.

## Work to be done

### 1. Define one versioned semantic envelope

Represent at least:

- complete snapshot and active-screen identity;
- base-revision delta and dirty or full invalidation;
- revisioned history-window response and eviction outcome;
- ordered occurrence effect and lifecycle transition;
- protocol capability and version negotiation; and
- semantic key, text, paste, mouse, focus, selection, application, resize, and
  presentation-setting commands.

The domain distinguishes event sequence from terminal state revision. Sequence
orders every delivered occurrence. State revision identifies the model version
to which a delta or history anchor applies. A valid delta names its base and
result revision.

Do not encode semantics in transport-only tags or let Tauri, control, and CLI
define different state unions.

### 2. Make counters lossless across languages

Choose and document a representation that round-trips the complete Rust counter
domain through JavaScript without `number` precision loss. The checked-in
fixtures must include sequence, revision, base revision, and history anchors
beyond JavaScript's safe integer range.

The TypeScript API may expose a lossless integer type or validated canonical
text, but it cannot silently clamp, round, or reset a host counter. Existing
safe-integer validation is transitional evidence, not proof for an unbounded
wire counter.

### 3. Define deterministic application and bootstrap

- A snapshot establishes one atomic sequence and state-revision boundary.
- Valid deltas apply only to their named base and produce their named result.
- Channel events that arrive before attach resolution are buffered and joined
  to the returned snapshot without a gap, duplicate, or mixed baseline.
- Duplicate, reordered, stale-base, truncated, oversized, unsupported, or
  malformed frames fail before any client-model mutation.
- Recovery returns a based semantic snapshot or declared history result; it
  never joins raw live output to a semantic baseline.

Snapshots plus valid deltas must reconstruct the same client state as the
corresponding complete snapshot. Check this as a model equivalence property,
not only by comparing serialized bytes.

### 4. Preserve effects and history semantics

Occurrence effects such as bell, notification, clipboard, reply, and exit have
identity and ordering independent of screen coalescing. A later screen delta
cannot replace or erase an earlier occurrence.

History windows define:

- stable anchor meaning within a state revision;
- requested direction or range;
- returned revision and boundaries;
- eviction and unavailable outcomes;
- resize or active-screen invalidation; and
- the outcome when state changes while a request is in flight.

Clients cannot fill unavailable history with blank rows or combine rows from
different revisions.

### 5. Evolve the exhaustive contract gate

Use the existing Rust-to-checked-in-artifact-to-TypeScript pattern for every
semantic variant and field. Require:

- exhaustive Rust representative samples;
- generated or deterministically checked contract data;
- exhaustive decoding and adaptation at every consumer;
- fail-closed handling of unknown versions, variants, fields, and invalid
  invariants; and
- golden fixtures shared by Tauri, control, CLI, bootstrap, and model tests.

A second hand-maintained event schema, even temporarily, fails this area.

### 6. Select transport representation from evidence

Measure candidate Tauri representations through the packaged webview path,
including raw binary payloads and any structured alternative. Measure
serialization, copies, decode cost, sustained output, recovery, and backpressure
using representative semantic frames.

Select frame sizing, batching, flow control, and queue-overflow behavior from
technical contracts, product requirements, and those measurements. Do not copy
the current raw byte queue limits into the semantic protocol by habit.

The selected Tauri output must land in a fail-closed semantic decoder. The
webview input API accepts typed semantic commands, not arbitrary byte arrays.

### 7. Adapt the control socket and CLI

The control socket may keep JSONL. It may base64-encode a selected binary
semantic codec, but type and fixture tests must prove that the decoded payload
is semantic state, never child output or replay ANSI.

Define CLI records for semantic attach state, deltas, history, effects,
lifecycle, errors, and command outcomes. Define version negotiation and error
behavior for both interactive and NDJSON consumers. Area 04 decides how an
interactive CLI paints those records locally; this area supplies the records
without child-byte identity.

## Boundary exclusions

This area does not:

- define terminal parsing, width, modes, selection meaning, or input encoding;
- mutate the renderer-independent browser model beyond decoder/bootstrap test
  doubles;
- render webview cells or local CLI output;
- select the product default or create a transport-specific migration flag; or
- delete legacy events before all clients can cut over.

Area 05 owns the sole switch from its introduction through deletion.

## Acceptance criteria

1. One authoritative contract exhaustively represents semantic snapshots,
   deltas, history, effects, lifecycle, capabilities, and commands for Rust,
   TypeScript, Tauri, control, CLI, and module adapters.
2. Counter fixtures beyond JavaScript's safe integer range round-trip exactly
   through every adapter and preserve comparison and ordering behavior.
3. Snapshot plus valid deltas yields the same model as the corresponding full
   snapshot for active screen, alternate screen, history, cursor, modes,
   palette, links, prompts, selection, and effects.
4. Bootstrap tests inject events before attach resolution and prove one atomic
   sequence and revision boundary without loss or duplication.
5. Stale base, duplicate, reordered, truncated, oversized, unsupported, and
   malformed frames are rejected before partial model mutation.
6. History tests prove stable anchors, eviction, resize invalidation, active
   screen changes, and declared in-flight behavior.
7. Interleaved occurrence effects retain identity and order through batching,
   coalescing, adapter conversion, gap recovery, and reconnect.
8. The semantic webview command surface exposes no arbitrary raw PTY write.
   Host input commands remain exhaustive and typed.
9. Tauri packaged-path measurements justify the selected encoding, framing,
   batching, and flow-control rules. Every applied limit cites its authority.
10. Control and CLI fixtures prove semantic payload provenance. Base64, when
    used, cannot decode to child output or replay ANSI.
11. A semantic client can attach and recover through Tauri, control, and CLI
    without receiving child output or replay ANSI.
12. A deliberate new Rust variant or adapter omission fails the contract or
    exhaustiveness gate in every language boundary.

## How to validate

Run contract, decoder, bootstrap, adapter, and production-path suites, followed
by repository gates:

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::contract
cargo test --manifest-path core/backend/Cargo.toml instance::
pnpm exec node --test \
  core/frontend/terminal/tests/terminalEventDecoder.test.ts \
  core/frontend/terminal/tests/terminalAttachmentBootstrap.test.ts
just test fast
just test rust
just check all
just modularity boundaries
```

Add golden round trips for Rust domain to each transport DTO and back to decoded
semantic state. Exercise bootstrap races, gaps, overflow, recovery, unsupported
versions, large counter values, history eviction, and interleaved effects.

Benchmark the packaged Tauri path and the control/CLI paths with representative
snapshots, sparse deltas, dense output, and history windows. Report all observed
costs. Turn a measurement into a gate only when the plan records its product or
technical authority.

## Stop and rollback

Stop before area 03 adoption if any adapter cannot express the area-01 domain
exhaustively, snapshot and delta are not model-equivalent, bootstrap cannot be
atomic, counters cannot be lossless, or measured transport behavior violates an
approved constraint.

Stop for an owner decision if an approved CLI or control contract requires
literal child-byte identity. That contract conflicts with global single-VT
closure and cannot be hidden behind a permanent compatibility mode.

Before area-05 cutover, semantic and legacy adapters may coexist under the one
area-05 switch. Rollback selects the legacy adapter through that switch; no
transport owns a private fallback or terminal model.
