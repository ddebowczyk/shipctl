# Attachments, replay, and flow control

## Objective

Replace the single spawn-time Tauri output channel and renderer ACK coupling
with detachable per-terminal subscribers. Every attachment starts from an
authoritative host VT replay and then receives ordered live events without a
gap. A failed or slow subscriber is isolated and can recover by reattaching;
the PTY continues to drain independently.

This slice assumes the host-owned `TerminalService`, `TerminalRecord`, ordered
`TerminalRuntime`, opaque `TerminalId`, and continuous VT adapter described in
the runtime plan already exist.

## Required invariants

1. Spawning a terminal requires no subscriber and no Tauri `Channel`.
2. A terminal remains alive with zero subscribers.
3. An attachment is disposable and independently identified.
4. Replay capture and subscriber registration occur in one terminal-runtime
   order; output cannot land between them.
5. Replay is delivered before any live event from that attachment.
6. Each live event has a strictly increasing terminal sequence.
7. Subscriber I/O never runs while holding the VT parser, record, or registry
   lock.
8. A slow subscriber cannot block the PTY reader/runtime or another subscriber.
9. Overflow is explicit. The subscriber receives `resync_required` when
   deliverable, is detached, and can attach again from a fresh replay.
10. Detach never means close.

## Attachment protocol

Define a transport-neutral service API. The Tauri and control-socket adapters
convert it to their wire formats.

Conceptually:

```rust
struct TerminalAttachment {
    attachment_id: TerminalAttachmentId,
    terminal_id: TerminalId,
    descriptor: TerminalDescriptor,
    replay: TerminalReplay,
    sequence_boundary: u64,
    receiver: TerminalEventReceiver,
}

enum TerminalEvent {
    Output { sequence: u64, bytes: Arc<[u8]> },
    Resized { sequence: u64, replay: TerminalReplay },
    MetadataChanged { sequence: u64, descriptor: TerminalDescriptor },
    LifecycleChanged { sequence: u64, descriptor: TerminalDescriptor },
    AgentActivityChanged { sequence: u64, activity: AgentActivity },
    ResyncRequired { sequence: u64, reason: ... },
    Detached { sequence: u64, reason: ... },
}
```

`TerminalReplay` contains canonical rows/columns, replay bytes or the selected
snapshot representation, terminal revision, and any parser defaults required
to make it self-contained. Do not include historical raw output and call it a
screen.

Output bytes must be byte arrays inside Rust. Tauri may serialize them as its
supported byte representation; JSON control frames use base64. Do not decode
PTY output as UTF-8 in the host.

## Atomic attach algorithm

Implement attach as one command handled by the ordered terminal runtime:

1. Validate that the record exists. Exited records may still attach to their
   final replay; input/resize remain disabled.
2. Allocate an attachment ID and its independent bounded mailbox.
3. At one runtime turn, after all previously dequeued PTY output is parsed:
   capture the descriptor/revision, canonical geometry, VT replay, and current
   output sequence.
4. Register the mailbox before the runtime accepts the next output item.
5. Return replay plus `sequence_boundary` to the caller.
6. Publish every later live event with sequence greater than the boundary.

An actor message gives the same guarantee as cmux's replay-and-tap registration
under one terminal lock, while avoiding a large replay serialization under a
global registry lock.

If replay construction itself is expensive, the runtime may snapshot an
immutable parser state or replay bytes in-order and finish transport encoding
outside the actor. The live mailbox must already be registered at the captured
boundary, and its technical capacity must cover output arriving during
encoding. Derive that capacity from measured replay time/output load and the
transport contract; otherwise perform the complete capture in the runtime
turn.

## Publication path

The runtime performs this order for PTY bytes:

1. assign the next output sequence;
2. feed the bytes to the continuous VT parser;
3. collect and write any parser-generated PTY response in order;
4. update output/activity revision;
5. enqueue an immutable event into each subscriber mailbox;
6. release runtime state and wake subscriber workers;
7. subscriber workers perform Tauri/socket sends independently.

Do not call a Tauri `Channel::send` or socket write from the parser/runtime
critical section.

Adjacent output may be coalesced within one subscriber mailbox only when the
result preserves byte order and event-boundary semantics. Never coalesce across
resize/replay, lifecycle, metadata, color/theme, or resync boundaries.

## Backpressure and overflow

The current code protects xterm with backend high/low watermarks and frontend
pending-output limits. Preserve the safety outcome, not the spawn-channel
protocol.

Use independent bounded subscriber mailboxes. Establish capacities through a
documented derivation using:

- the current backend high/low watermark behavior;
- `terminalOutputQueue.ts`'s current xterm write behavior and pending-output
  protection;
- the maximum replay/control frame established by the VT/control proof;
- measured output during existing assistant workloads;
- memory multiplication across simultaneously attached terminals.

Do not copy Fut's or cmux's queue constants, and do not convert a character
limit into a byte limit without measuring the encoding difference.

When a mailbox cannot accept the next non-droppable event:

1. mark only that attachment overflowed;
2. enqueue `resync_required` if the mailbox can still deliver a terminal
   control event, otherwise close it with an inspectable overflow reason;
3. remove it from publication;
4. clear its queued output and release memory;
5. leave the terminal and all other subscribers running.

The renderer responds by disabling input for that mirror, detaching it, and
reattaching for a fresh replay. Do not attempt to guess which raw bytes were
lost.

The PTY reader must continue draining even with no subscribers or only slow
subscribers. The continuous parser is the durable in-process state.

## Tauri attachment adapter

Replace `spawnPty(..., onMessage)` with separate calls in
`core/frontend/platform/tauri.ts`:

- `spawnTerminal(request): Promise<TerminalDescriptor>`
- `attachTerminal(id, onEvent): Promise<TerminalAttachmentInfo>`
- `detachTerminal(attachmentId): Promise<void>`
- `writeTerminal(id, bytes): Promise<void>`
- `resizeTerminal(id, size): Promise<void>`
- `closeTerminal(id): Promise<CloseResult>`
- `listTerminals()` and `getTerminal(id)`

The Rust Tauri command for attach may receive a new `Channel<TerminalEventDto>`
as the transport sink. That channel belongs to the attachment adapter, not to
the PTY runtime or spawn request.

The adapter worker owns the channel and attachment receiver. If
`Channel::send` fails, it unregisters/drops the attachment and exits. It never
calls terminal close.

Make detach idempotent. Dropping the frontend listener, explicit detach, and a
failed channel may race; all must converge on one removal.

## Remove ACK coupling

The final API must delete `ack_pty_output` and the backend `OutputFlow` state
that treats one renderer as the process's output consumer.

Refactor `terminalOutputQueue.ts` so it remains an xterm write scheduler, not a
PTY backpressure authority:

- queue replay/live writes per `TerminalId`;
- expose completion of replay application;
- apply the existing safe write chunking behavior;
- detect its local pending-output overflow;
- request detach/reattach on overflow;
- never send byte ACKs to the backend.

The service-level bounded mailbox prevents a Tauri sink from accumulating
without bound. The renderer queue prevents xterm work from accumulating
without bound. Both recover by exact replay.

Delete old ACK constants only after replacement tests prove the same bounded
memory outcome. Preserve useful measured values if still justified, but move
them beside the layer they actually bound.

## Resize and geometry authority

Shipctl does not need cmux's multi-view geometry arbitration in this refactor.
Use this explicit policy:

- the mounted Shipctl xterm view is the canonical resize authority;
- control-socket attachments are read-only observers;
- `write` is an explicit command and does not confer resize ownership;
- if no renderer view is mounted, canonical geometry remains frozen at its
  last accepted size;
- a newly mounted view reports its fit after it has applied the host replay;
- the runtime serializes resize with PTY output and publishes a complete
  resize/replay event so every mirror resets consistently.

The VT proof makes the final point mandatory, not an optimization. Ghostty and
xterm differ at an exact reflow wrap boundary when each resizes independently.
The host therefore changes canonical geometry first and every subscriber must
reset xterm, resize it, and apply the accompanying host replay before accepting
later events or input. Configure xterm with `reflowCursorLine: true`, but do not
use independent xterm reflow as the source of truth.

Associate resize authority with an attachment generation so a late resize from
an old renderer cannot override a newer attachment. On detach, release that
authority. If Shipctl later supports simultaneous views of the same terminal,
geometry arbitration requires a separate product contract.

## Initial output and spawn races

Do not restore a spawn-time channel merely to catch earliest output. Continuous
VT state solves the race:

1. `spawnTerminal` creates the runtime and returns a descriptor.
2. The frontend calls `attachTerminal`.
3. The attachment replay includes all state parsed before the atomic boundary.
4. Later output arrives as live events.

For a program that exits before attach, the retained exited record supplies its
final replay and exit status. This is a required test.

## Lifecycle event ordering

On natural exit:

1. drain and parse all PTY bytes already accepted;
2. wait/reap the child;
3. capture final replay/revision;
4. update the record to exited;
5. publish any final output/resize state;
6. publish one lifecycle-exited event;
7. close attachment streams only after queued final events can be consumed, or
   include the final replay in the exit event if transport closure cannot
   guarantee draining.

New attachments to an exited record receive final replay and exited descriptor
without a live output tap.

## Tests

### Atomicity

- Pause output exactly at attach; assert replay plus live bytes matches one
  uninterrupted stream with no gap or duplication.
- Attach while resize races output; assert the client receives one coherent
  replay/sequence order.
- Spawn a short-lived command that exits before attach; assert final content
  and exit are recoverable.

### Isolation

- Attach two subscribers; fail one sink and prove the other keeps receiving.
- Fill one subscriber mailbox and prove PTY draining, parser revision, and a
  fast subscriber continue.
- Drop every subscriber and prove the child remains running and later replay is
  current.
- Race explicit detach, channel failure, and terminal exit; assert one cleanup
  and no panic/leak.

### Renderer queue

- Replay is written before live events even when Tauri delivers them quickly.
- Local queue overflow disables input and reattaches from fresh replay.
- Removed ACK calls do not reappear through another name.
- Unmount detaches but does not close.

### Lifecycle

- Final output precedes exit.
- Exited attach is read-only and returns final state.
- A late event from a prior attachment generation is ignored.

## Acceptance criteria

This slice is complete when:

- spawn accepts no output channel;
- the runtime stores no Tauri type;
- multiple attachments work independently;
- replay and live registration are one ordered operation;
- dead/slow sinks detach without killing or blocking terminals;
- xterm queue recovery uses replay and backend ACK flow control is deleted;
- mounted renderer attachments alone own resize generation;
- no old `on_data`/`onOutput` path remains in core terminal code;
- concurrency and overflow tests prove bounded, self-healing behavior.

## Files expected to change

- `core/backend/src/terminal/runtime.rs`
- `core/backend/src/terminal/record.rs`
- `core/backend/src/terminal/service.rs`
- `core/backend/src/terminal/commands.rs`
- `core/frontend/platform/tauri.ts`
- `core/frontend/platform/types.ts`
- `core/frontend/terminal/terminalOutputQueue.ts`
- backend and frontend terminal tests

Module output-channel call sites are removed in the dedicated module migration
slice after this core attachment API is stable.
