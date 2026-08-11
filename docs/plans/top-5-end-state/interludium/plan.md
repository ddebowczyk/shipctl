# Semantic transport performance interlude

## Decision

Continue the single-VT architecture, but stop treating the current per-cell
JSON stream as a shippable protocol.

Ghostty remains the sole terminal authority. The current byte renderer remains
only as a temporary rollback path until the compact, consumer-driven semantic
path is proven in the packaged application.

## Execution order

### 1. Freeze destructive cutover

Do not start area 05 deletion. Keep the byte renderer as a temporary rollback
path. Do not add new features to it.

### 2. Do not freeze the current `Screen` event contract

The cell-per-object JSON form is transitional. Do not optimize its mailbox
size, add compression, or tune publication intervals.

### 3. Correct the performance evidence

Extend the probe to measure a complete run-based event:

- event envelope;
- row metadata;
- cursor, modes, colors, damage, and effects;
- all host-defined cell and grapheme boundaries;
- encode, transfer, decode, model commit, and paint work; and
- queued bytes and copies per attachment.

Change the performance note to call the existing run numbers "viewport-run
payload," not complete frame size.

### 4. Define the compact semantic wire contract in area 02

Start with complete snapshots. Each row carries metadata and styled runs. Each
run must preserve individual host cells, for example with `glyphs: string[]`.
Joined text alone is invalid.

Keep these concerns separate:

- replaceable screen state;
- reliable ordered effects and lifecycle;
- attachment-specific selection overlay;
- history responses; and
- control and recovery.

Do not bake attachment selection into the shared canonical screen.

### 5. Make publication consumer-driven

Remove projection and serialization from the unconditional per-PTY-read path.

The actor must:

- always feed Ghostty and send parser replies immediately;
- mark semantic state dirty;
- retain ordered occurrence effects;
- project when a client grants credit or pulls;
- allow one replaceable screen transaction in flight per attachment;
- send the newest state after the previous transaction commits; and
- encode one immutable result and fan it out where attachments share the same
  state.

A successful Tauri channel send is not an acknowledgement. Add an explicit
client commit acknowledgement or pull request.

### 6. Adapt the client without redesigning its model yet

Decode runs at the protocol boundary and expand them into the existing cell
model. This keeps the current model, painter, hit testing, and selection tests
useful.

The client grants the next credit only after complete validation and atomic
model commit. Hidden surfaces stop screen credits and request current state when
needed. Required effects continue independently.

### 7. Prove the complete vertical slice in the packaged application

Exercise this path:

```text
PTY -> Ghostty -> compact snapshot -> Tauri -> decoder
    -> existing client model -> semantic painter
```

Record the observed:

- payload bytes;
- projections and encodes per PTY workload;
- IPC transfer and decode time;
- queued state and effect data;
- model commit and paint time;
- visible and hidden terminals;
- one and multiple attachments; and
- slow-client recovery.

### 8. Then compare compact JSON with raw binary

Use the same semantic schema and workloads. Choose binary only if the packaged
evidence shows a material benefit. Binary is an encoding decision, not an
architectural decision.

### 9. Only then unblock area 05

Delete the byte path only after compact transport, consumer pacing, effect
reliability, recovery, and packaged measurements all pass.

## Explicit non-goals

Do not:

- invent a frame rate, timer, byte budget, or performance threshold;
- implement structural scroll deltas yet;
- create a custom shared-memory or WebSocket transport;
- compress the current large JSON cell objects;
- make the frontend recover grapheme boundaries;
- let screen coalescing drop bells, notifications, clipboard events, or exits;
  or
- preserve raw PTY streaming as the permanent fallback.

Structural deltas can follow later if complete run snapshots plus consumer
pacing remain too expensive. They are not required to remove the present
amplification.

## Completion proof

This intervention is complete when:

- rapid PTY output does not cause one full screen projection per read;
- an attachment cannot accumulate a queue of full screen snapshots;
- intermediate screen states can be replaced without losing ordered
  occurrences;
- one complete compact frame round-trips every semantic fact and host cell
  boundary;
- malformed data leaves the client model unchanged;
- multiple attachments do not cause repeated deep cloning and encoding of the
  same canonical state;
- packaged-application evidence exists for compact JSON and, if tested, raw
  binary; and
- area 05 remains blocked until these proofs pass.

This sequence fixes representation and demand first. It preserves the existing
model and painter. It postpones binary codecs and sophisticated deltas until
evidence requires them.

## Execution result — 2026-08-11

This interlude is implemented and proved for compact JSON. The exact packaged
transcript is filed at
`research/notes/terminal-compact-json-packaged-profile-20260811-1349.md`.

- The complete run wire contract preserves host cell boundaries and all screen
  facts, and the decoder rejects malformed frames before model mutation.
- Publication is credit-driven. A rapid 2,000-line run produced 69 PTY reads,
  71 screen changes, and 51 projections and encodes.
- One attachment held at most one screen transaction. Three later screen
  changes did not change its queued transaction count or bytes, and recovery
  resumed two sequences ahead.
- Hidden output produced five screen changes with no projection, encode, model
  commit, or paint after the protocol-derived one outstanding credit was
  consumed.
- Two attachments shared one projection and one 3,694-byte JSON encoding.
- The mounted workload encoded 205,134 screen bytes in total and observed a
  15,143-byte peak screen queue. This removes the former 185–956 KB-per-frame
  amplification as the reason to consider binary.

Raw binary is postponed. Compact JSON has not shown a material wire problem.
The mounted run did sample one 770 ms frame gap that its decode, model-commit,
and paint timers do not explain. A long-task or event-dispatch profile is the
next performance investigation; it is separate from the completed compact-wire
intervention and must not become an invented frame threshold.

Area 05 remains blocked. GPU-loss recovery skipped on the mounted canvas, and
other area-04 manual proofs remain open. The byte rollback path must stay until
those blockers close.
