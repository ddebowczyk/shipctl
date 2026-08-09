# Terminal control socket and CLI

## Objective

Expose terminal list, get, attach, write, and close through Shipctl's existing
authenticated instance control socket and the `shipctl` CLI. A long-lived
terminal attachment must not block inspect, diagnose, write, close, shutdown,
or another attachment.

This slice assumes `TerminalService` already owns stable `TerminalId` values,
descriptors, exact replay, detachable subscribers, lifecycle, and idempotent
close. The control layer is an adapter; it must not become a second terminal
registry.

## Current integration points

Backend control code is under `core/backend/src/instance/`:

- `protocol.rs` defines `ControlOperation`, response results, events, and
  `CONTROL_FRAME_SCHEMA_VERSION`.
- `control.rs` defines `ControlHandler`, `InstanceDirectory`, socket connection
  handling, framing, and client requests.
- `core/backend/src/build_info.rs` defines `CONTROL_PROTOCOL_VERSION`.
- `src-tauri/src/lifecycle.rs` implements the Tauri host control handler and
  already uses terminal activity for shutdown blocking.

CLI integration points are:

- `cli/src/args.rs` for typed clap commands;
- `cli/src/lib.rs` for dispatch;
- `cli/src/instances.rs` for instance-directory/control calls;
- `cli/src/output.rs` for finite TOON/JSON output and structured errors.

The current server accepts and handles a connection synchronously. That is
adequate for one request/response but incompatible with an attachment that can
remain open indefinitely.

## Protocol model

Add a terminal operation family rather than five unrelated top-level variants:

```rust
ControlOperation::Terminals(TerminalControlOperation)

enum TerminalControlOperation {
    List,
    Get { terminal_id },
    Attach { terminal_id },
    Write { terminal_id, data_base64 },
    Close { terminal_id },
    // Added by the lifecycle slice:
    Report { terminal_id, report },
}
```

Use the same opaque string `TerminalId` as Tauri and TypeScript. Reject malformed
UUIDs at the protocol boundary with the existing structured error mechanism.
Do not accept numeric compatibility IDs.

Finite responses:

- `List` returns descriptors in deterministic creation order and a count.
- `Get` returns one complete redacted descriptor or typed `not_found`.
- `Write` returns terminal ID and accepted byte count after the runtime accepts
  the command. It rejects exited/closing terminals with a typed lifecycle
  error.
- `Close` returns terminal ID, `existed`, and final/known exit information.
  Repeating close is a successful no-op.

Do not expose argv, environment, shell source, tokens, or module secrets in any
response.

## Attach stream contract

An attach connection performs the normal authenticated hello/request exchange.
After the accepted response, the server keeps that connection open and emits
JSONL event frames.

The first stream frame is an attachment state frame containing:

- terminal ID and attachment ID;
- descriptor and record revision;
- canonical rows/columns;
- replay bytes encoded as base64, or the selected snapshot DTO;
- the live sequence boundary;
- an explicit replay format/version.

Later frames are typed terminal events:

- output bytes with terminal sequence and base64 data;
- resize with new authoritative replay;
- metadata/lifecycle/agent updates;
- resync-required/overflow;
- exit;
- detached/completed.

Every frame carries the control frame schema version and enough identity to
reject a stale or cross-terminal event. Live output sequences must be greater
than the initial boundary and contiguous unless a `resync_required` event
explicitly terminates that stream.

Client disconnect drops only the socket subscriber. Terminal close is never
implicit.

## Control protocol versioning

Adding a terminal operation and stream event family is a control-protocol
change. Update together:

- `CONTROL_FRAME_SCHEMA_VERSION` in `instance/protocol.rs`;
- `CONTROL_PROTOCOL_VERSION` in `build_info.rs`;
- build identity/compatibility comments and fixtures;
- hello/capability negotiation and tests;
- CLI compatibility error output.

Use the next version according to the repository's existing exact-version
policy. Do not update only one constant or silently let an old client decode a
new stream.

If the protocol advertises capabilities, include terminal list/get/attach/
write/close explicitly so a client can reject an unsupported operation before
opening a stream.

## Concurrent server connections

Refactor the listener so accepting new clients is independent from processing
an existing connection:

1. The listener continues accepting while the instance is published.
2. Each authenticated connection runs in an owned worker/task.
3. Connection workers share a thread-safe handler/service reference, not a
   mutable socket-global request loop.
4. An attach worker owns its terminal subscription and socket writer until
   client disconnect, terminal exit/detach, overflow, or application shutdown.
5. Worker cleanup unregisters the attachment and releases all queued frames.
6. Server shutdown stops accepting, signals workers, closes attachments, joins
   workers, then withdraws the instance descriptor according to the existing
   shutdown contract.

Do not hold the instance-directory lock, control listener lock, terminal
registry lock, or handler lock while waiting for a stream event or socket
write.

Preserve existing shutdown commit semantics. If current code couples descriptor
withdrawal to the synchronous request loop, extract a server coordinator that
owns acceptance state and worker join state. Add a test that shutdown through
one connection succeeds while another connection is attached.

## Stream writer and backpressure

Give each control connection a dedicated writer queue or writer task. Reads and
writes must not share a blocking loop: a full client receive buffer must not
prevent detach/close requests from being read where bidirectional behavior is
supported.

Apply the terminal subscriber's established bounded mailbox and the control
transport's established frame bound. Do not create a second unbounded JSON
queue. If transport writing falls behind:

- mark only that attachment overflowed;
- try to send one terminal stream error/resync event;
- close the stream and detach;
- leave the terminal running.

Derive any socket writer queue limit from the terminal event/replay maximum and
the existing control frame limit. Document the multiplication used to bound
per-connection and process-wide retained memory.

## ControlHandler and InstanceDirectory API

Add one terminal-oriented handler method or a small typed group, for example:

```rust
trait ControlHandler {
    // existing methods
    fn terminal_request(&self, request: TerminalControlRequest)
        -> Result<TerminalControlResponse>;
    fn terminal_attach(&self, id: TerminalId)
        -> Result<TerminalControlAttachment>;
}
```

`TauriControlHandler` delegates directly to app-managed `TerminalService`.
`InstanceDirectory` provides finite request helpers and an attachment client
that yields decoded event frames. Neither reconstructs terminal state.

Avoid passing Tauri `Channel` types into instance-control code. The shared
service attachment receiver is transport-neutral.

## CLI command design

Add a `terminals` command group:

```text
shipctl terminals list
shipctl terminals get <terminal-id>
shipctl terminals attach <terminal-id> [--raw]
shipctl terminals write <terminal-id> (--data <text> | --base64 <data> | --stdin)
shipctl terminals close <terminal-id>
```

The lifecycle slice later adds:

```text
shipctl terminals report <idle|working|blocked|completed> [--terminal-id <id>]
```

### Finite output

List/get/write/close use the existing output layer:

- default TOON and optional JSON stay machine-readable;
- stdout contains only the result document;
- diagnostics/progress go to stderr;
- errors retain the repository's structured error contract;
- an empty list returns a definitive empty collection and count;
- list shows compact fields; get shows the full redacted descriptor;
- do not paginate or truncate unless measured transport/product requirements
  establish a limit.

### Attach output

Streaming output needs an explicit record-boundary contract. Implement two
modes:

- default event mode emits NDJSON: one complete typed attachment/event record
  per line, including base64 bytes. Document that streaming commands use
  NDJSON because a finite TOON document has no safe open-ended record boundary.
- `--raw` resets/replays and writes terminal bytes to stdout for human terminal
  observation. Lifecycle/errors go to stderr. It does not enter a local input
  loop; `terminals write` remains the explicit mutation path.

Do not mix progress prose with either stdout mode. Do not silently choose raw
mode based on whether stdout is a TTY; agents must receive deterministic output
from the same argv.

If retaining global `--output` is mandatory, accept `--output json` for event
mode and return a structured usage error for TOON attach until a repository-wide
streaming TOON framing contract exists. Do not invent an ambiguous delimiter.

### Write input

Require exactly one of:

- `--data` for literal UTF-8 bytes;
- `--base64` for arbitrary bytes;
- `--stdin` to read bytes to EOF.

Never prompt. Never interpret shell escapes. Return accepted byte count. Reject
multiple sources, missing sources, invalid base64, and exited terminals before
printing success.

### Instance selection

Use the existing instance selection flags and directory lookup. Inside a
terminal process, the injected instance/terminal environment may supply
defaults only where the command contract says so. `list` is instance-scoped;
`get/attach/write/close` still validate that the ID belongs to that instance.

## Security

- Reuse the existing local control authentication/hello before terminal data is
  disclosed or input is accepted.
- Treat PTY output as potentially sensitive. Do not add terminal data to logs.
- Never serialize control credentials into child-visible descriptor metadata.
- Validate base64/frame sizes before allocation using the control protocol's
  authoritative bound.
- Keep socket paths/permissions and instance descriptor ownership unchanged.
- Ensure an attachment from one instance cannot address another instance's
  terminal ID.

## Tests

### Protocol tests

- Round-trip every terminal request, finite response, and event frame.
- Reject numeric/malformed IDs, unknown operations, bad base64, oversize frames,
  and incompatible versions.
- Prove descriptors redact secret argv/environment sentinels.
- Prove the initial attach frame precedes all live events and sequences are
  contiguous.

### Server concurrency tests

- Keep attach A open; perform inspect/list/get/write on connection B.
- Close a terminal through B; A receives final lifecycle/detach and exits.
- Shut down through B while A is idle; listener and worker join cleanly.
- Disconnect A without close; terminal remains running and a later attach
  succeeds.
- Stall A's reader until overflow; B and the terminal remain responsive.

### CLI tests

- Golden TOON/JSON for empty and populated list, get, write, and idempotent
  close.
- NDJSON attach has one decodable event per line and no prose on stdout.
- Raw attach writes replay before live bytes and sends errors to stderr.
- `write` preserves literal and base64 bytes and enforces one input source.
- The CLI reports protocol mismatch and terminal lifecycle errors with stable
  codes.

### Existing contract gate

Extend the repository's `just instance-control contract` coverage to include
terminal operations and an attach concurrency scenario. Keep existing inspect,
shutdown, module, operation, and message cases passing.

## Acceptance criteria

This slice is complete when:

- list/get/attach/write/close are versioned operations on the existing socket;
- `TauriControlHandler` delegates to the same `TerminalService` used by Tauri;
- live attach does not block later connections or shutdown;
- socket/client failure detaches only its subscriber;
- CLI finite commands use structured output and attach has deterministic NDJSON
  or explicit raw mode;
- write is non-interactive and byte-safe;
- version/capability/security tests pass;
- no terminal state is duplicated inside control or CLI layers.

## Files expected to change

- `core/backend/src/instance/protocol.rs`
- `core/backend/src/instance/control.rs`
- `core/backend/src/build_info.rs`
- `src-tauri/src/lifecycle.rs`
- `cli/src/args.rs`
- `cli/src/lib.rs`
- `cli/src/instances.rs` and/or a focused `cli/src/terminals.rs`
- `cli/src/output.rs` only for the explicit streaming output contract
- instance-control, protocol, and CLI tests
