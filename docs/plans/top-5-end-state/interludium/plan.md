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
