# Phase 05 — Replace JSON byte arrays with versioned raw frames

## Outcome

Shipctl stops serializing output, replay, and input bytes as JSON number arrays.
A versioned attachment-frame codec preserves event ordering; the input command
uses a pure raw body with validated request metadata. Both reject malformed or
unsupported data before it reaches terminal state.

## Context

The current `Channel<TerminalEvent>` serializes `Vec<u8>` as decimal JSON
arrays, and frontend input calls `Array.from(bytes)`. Base64 would reduce the
amplification but still adds encode/decode work and would introduce a second
wire convention. Tauri v2 exposes raw response bodies and raw invoke bodies on
the supported desktop target; this phase must prove the exact generated API
shape before cutover.

Pinned Tauri 2.11.5 has an important implementation detail: raw channel bodies
under 1 KiB take a direct-execute path that constructs
`new Uint8Array([...]).buffer`; larger bodies use the fetch-based binary path.
Its source says the small-frame path is faster on macOS. Therefore the contract
is “Shipctl uses Tauri raw bodies and binary public types,” not “no framework
layer ever expands a small frame.” Benchmark real chunk sizes before adding any
batching intended to cross Tauri's internal threshold.

A JSON envelope with an out-of-band raw payload is not available as one atomic
channel message. Therefore the envelope and bytes become one binary frame.
Low-volume descriptor/control bodies may remain UTF-8 JSON inside that frame.

Herdr's capacity-one render slot is valid because each message is a derived
semantic frame that can replace an older frame. Shipctl still transports raw
PTY bytes in this phase; every byte frame is non-replaceable. Backpressure may
batch adjacent output without reordering, or abandon a stale attachment and
recover from a snapshot, but it must never overwrite an older output frame.

## Frame contract

All attachment channel messages use this fixed little-endian header:

- Offset 0: protocol version, `u16`; value `1` for the first shipped codec.
- Offset 2: event kind, `u16`; frozen by Rust/TypeScript golden fixtures.
- Offset 4: flags, `u32`; unknown mandatory flags reject the frame.
- Offset 8: sequence, `u64`; non-zero for every event kind and parsed as
  `bigint` in TypeScript. Consecutive sequence accounting never excludes a
  low-volume control frame.
- Offset 16: kind-specific payload consuming the rest of the channel message.

Version 1 kinds are:

- `Snapshot`: canonical columns/rows, descriptor revision, snapshot metadata,
  then raw replay bytes;
- `Output`: raw PTY bytes;
- `Resized`: canonical columns/rows and descriptor revision;
- `PaletteChanged`: semantic theme colors;
- `MetadataChanged` and `AgentActivityChanged`: compact low-volume payloads;
- `Exited`, `ResyncRequired`, and `Detached`: compact kind-specific control
  payloads.

Reserve bits, numeric kind values, payload layouts, and maximum decoded lengths
must be declared once in a Rust protocol module and mirrored by golden bytes in
TypeScript. Do not rely on TypeScript `number` for the `u64` sequence.

Input uses a separate raw invoke request:

```text
header: x-shipctl-terminal-id: <canonical terminal ID>
body:   raw PTY input bytes
```

The command name supplies the operation kind. The backend reads the terminal ID
through Tauri 2.11.5 `Request::headers()`, then validates the required header,
canonical terminal ID, raw body kind, and total body size before lookup or PTY
write. There is no Shipctl ID-framing parser on the input hot path.

## Hypotheses to verify

### H5.1 — Raw channel delivery

`Channel<tauri::ipc::Response>` delivers `InvokeResponseBody::Raw` to the app
callback as `ArrayBuffer` or `Uint8Array`. Test payloads below, at, and above the
pinned 1 KiB internal threshold. Falsifier: the public callback receives JSON.

### H5.2 — Raw invoke input

A Tauri command can accept `tauri::ipc::Request<'_>` and read
`InvokeBody::Raw` without ordinary JSON arguments, and a custom invoke header
arrives through `Request::headers()`. Invoke with `Uint8Array`, a canonical ID
header, and round-trip binary data. Falsifier: the command cannot expose both
the raw body and header.

### H5.3 — Bootstrap ordering

One raw channel preserves snapshot-before-live order even if frames arrive
before attach resolves. Delay the response while publishing live frames.
Falsifier: callback delivery reorders channel messages.

### H5.4 — Hot-path improvement

Raw frames reduce size, allocation, and decode work against the Phase 01
corpus. Repeat the release benchmark. Falsifier: raw framing regresses the
measured supported hot path.

### H5.5 — Slow-consumer recovery

A full subscriber queue stops the stale attachment and produces one recovery
boundary without silently replacing raw output or delaying reliable exit/resync
control. Falsifier: any byte frame disappears without a detected gap, control
is starved behind output, or repeated overflow creates a recovery loop.

## Tasks

1. Build a temporary raw round-trip probe in the existing Tauri integration
   test surface. Resolve H5.1 and H5.2 before changing production types. Pin
   tests to public behavior, but record the current 1 KiB internal fast path so
   a Tauri upgrade triggers a benchmark review.
2. Add backend `terminal/protocol.rs` with checked encoders/decoders and no
   unchecked indexing or integer truncation. Add matching frontend
   `terminalProtocol.ts` using `DataView` and `Uint8Array` slices.
3. Check in Rust-authored golden frames for every kind, including zero-length
   output, maximum valid geometry, and consecutive heterogeneous control
   events. Decode them in TypeScript; encode the same semantic fixtures in
   TypeScript and decode them in Rust.
4. Add channel negative fixtures for short headers, unknown version/kind,
   unsupported flags, invalid UTF-8 control data, impossible geometry,
   truncated payload, and a sequence above JavaScript's safe integer range. Add
   input-request fixtures for missing/duplicate/invalid terminal-ID header,
   non-raw body, and oversized body; do not add dead version/kind/ID-length
   parser fixtures.
5. Change attachment delivery to a raw-response channel. In one host-actor
   turn, capture snapshot boundary `N`, register the subscriber, and enqueue
   `Snapshot` before releasing live frames. Messages delivered before the
   invoke resolves remain buffered and are consumed in channel order.
6. Make the attach invoke return only low-volume receipt data. Encode any `u64`
   value in that JSON receipt as a decimal string; do not return replay bytes.
7. Translate backend events to frames at the channel boundary. Keep domain
   events typed internally; do not spread wire-layout concerns into runtime
   logic.
8. Change the controller and output queue to accept `Uint8Array` views without
   expanding them into JavaScript arrays. Document where unavoidable copies
   occur and prove that a buffer is not reused before xterm consumes it.
9. Replace `writeTerminal(terminalId, Array.from(bytes))` with a raw invoke whose
   body is exactly the PTY bytes and whose namespaced header carries the
   canonical terminal ID. Preserve lifecycle and terminal-ownership checks
   after header/body validation.
10. Run the Phase 01 corpus in release mode and record current JSON versus raw
    encoded size, encode/decode time, peak allocation, sustained bursts, and
    the real distribution of channel frame sizes.
11. If measurements show a material benefit, batch only consecutive output
    frames and flush before resize/palette/snapshot/control frames. Derive the
    byte/time flush policy from the benchmark and interactive-latency fixture;
    do not pad frames or batch solely to defeat Tauri's measured optimization.
12. Delete JSON byte-array payload types and conversions after every attachment
    and write caller uses the codec; retain no base64 compatibility path.
13. Add a saturated-consumer fixture with output around resize/palette/exit.
    Prove raw frames are never overwritten, reliable control remains observable,
    and one overflow produces one stale-generation shutdown plus one snapshot
    recovery. Do not import Herdr's replaceable-frame queue until payloads are
    semantic derived state rather than PTY bytes.

## Acceptance criteria

- Rust and TypeScript decode one frozen byte layout for every protocol kind.
- A sequence above `2^53 - 1` round-trips exactly and participates correctly in
  duplicate/gap detection.
- Snapshot, output, resize, palette, metadata, activity, exit, resync, and
  detach frames all carry non-zero consecutive sequences. Dropping any one kind
  triggers the same gap rule.
- Snapshot is observed before all live frames for an attachment, including
  when the channel fires before the invoke promise resolves.
- Malformed/unsupported frames produce one controlled protocol error and
  recovery/disconnect action; they never partially mutate terminal state.
- Output/replay types contain `Uint8Array`, not `readonly number[]`. The input
  body is pure PTY bytes, its terminal ID is a validated request header, and the
  path contains no `Array.from(bytes)`, base64, or ID-framing parser.
- Phase 01's release-mode corpus shows no regression in sustained throughput,
  interactive latency, or peak allocation and records the raw-frame result
  rather than asserting an invented percentage.
- Any batching preserves event boundaries and is justified by measured results;
  absent that evidence, Tauri's current small-frame optimization remains.
- Existing attach, gap, overflow, resize, exit, and input tests pass through
  the new codec.
- Slow-consumer tests prove that raw output is either delivered in order or
  invalidates the attachment for one explicit recovery; it is never treated as
  capacity-one replaceable render state.

## Validation

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::protocol
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalProtocol.test.ts \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts
just test fast
just test rust
just check all
git diff --check
```

## Exit and rollback

Keep one atomic cutover commit that can restore the previous channel codec if a
supported Tauri target fails H5.1 or H5.2. Do not ship a mixed mode in which
live output is raw but recovery replay remains a large JSON byte array.
