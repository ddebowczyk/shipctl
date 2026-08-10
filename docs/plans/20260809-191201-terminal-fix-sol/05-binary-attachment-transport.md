# Phase 05 — Replace JSON byte arrays with versioned raw frames

## Outcome

Shipctl stops serializing output, replay, and input bytes as JSON number arrays.
One versioned frame codec preserves event ordering and rejects malformed or
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

## Frame contract

All attachment channel messages use this fixed little-endian header:

- Offset 0: protocol version, `u16`; value `1` for the first shipped codec.
- Offset 2: event kind, `u16`; frozen by Rust/TypeScript golden fixtures.
- Offset 4: flags, `u32`; unknown mandatory flags reject the frame.
- Offset 8: sequence, `u64`; non-zero for snapshot/output/resize/palette and
  parsed as `bigint` in TypeScript.
- Offset 16: kind-specific payload consuming the rest of the channel message.

Version 1 kinds are:

- `Snapshot`: canonical columns/rows, descriptor revision, snapshot metadata,
  then raw replay bytes;
- `Output`: raw PTY bytes;
- `Resized`: canonical columns/rows and descriptor revision;
- `PaletteChanged`: semantic theme colors;
- `Descriptor`: UTF-8 JSON for the low-volume descriptor;
- `Exited`, `ResyncRequired`, and `Detached`: compact kind-specific control
  payloads.

Reserve bits, numeric kind values, payload layouts, and maximum decoded lengths
must be declared once in a Rust protocol module and mirrored by golden bytes in
TypeScript. Do not rely on TypeScript `number` for the `u64` sequence.

Input uses a separate raw invoke frame:

```text
u16 version
u16 kind (Write = 1)
u32 UTF-8 terminal-id length
terminal-id bytes
raw PTY input bytes
```

The backend validates version, kind, ID length, canonical terminal ID, and
total body size before lookup or PTY write.

## Hypotheses to verify

### H5.1 — Raw channel delivery

`Channel<tauri::ipc::Response>` delivers `InvokeResponseBody::Raw` to the app
callback as `ArrayBuffer` or `Uint8Array`. Test payloads below, at, and above the
pinned 1 KiB internal threshold. Falsifier: the public callback receives JSON.

### H5.2 — Raw invoke input

A Tauri command can accept `tauri::ipc::Request<'_>` and read
`InvokeBody::Raw` without ordinary JSON arguments. Invoke with `Uint8Array` and
round-trip binary data. Falsifier: the command cannot expose the raw body.

### H5.3 — Bootstrap ordering

One raw channel preserves snapshot-before-live order even if frames arrive
before attach resolves. Delay the response while publishing live frames.
Falsifier: callback delivery reorders channel messages.

### H5.4 — Hot-path improvement

Raw frames reduce size, allocation, and decode work against the Phase 01
corpus. Repeat the release benchmark. Falsifier: raw framing regresses the
measured supported hot path.

## Tasks

1. Build a temporary raw round-trip probe in the existing Tauri integration
   test surface. Resolve H5.1 and H5.2 before changing production types. Pin
   tests to public behavior, but record the current 1 KiB internal fast path so
   a Tauri upgrade triggers a benchmark review.
2. Add backend `terminal/protocol.rs` with checked encoders/decoders and no
   unchecked indexing or integer truncation. Add matching frontend
   `terminalProtocol.ts` using `DataView` and `Uint8Array` slices.
3. Check in Rust-authored golden frames for every kind, including zero-length
   output and maximum valid geometry. Decode them in TypeScript; encode the
   same semantic fixtures in TypeScript and decode them in Rust.
4. Add negative fixtures for short headers, unknown version/kind, unsupported
   flags, invalid UTF-8 control data, invalid terminal ID, impossible geometry,
   truncated payload, oversized input, and a sequence above JavaScript's safe
   integer range.
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
9. Replace `writeTerminal(terminalId, Array.from(bytes))` with the raw input
   frame and a backend raw-body decoder. Preserve the existing lifecycle and
   terminal-ownership checks after decoding.
10. Run the Phase 01 corpus in release mode and record current JSON versus raw
    encoded size, encode/decode time, peak allocation, sustained bursts, and
    the real distribution of channel frame sizes.
11. If measurements show a material benefit, batch only consecutive output
    frames and flush before resize/palette/snapshot/control frames. Derive the
    byte/time flush policy from the benchmark and interactive-latency fixture;
    do not pad frames or batch solely to defeat Tauri's measured optimization.
12. Delete JSON byte-array payload types and conversions after every attachment
    and write caller uses the codec; retain no base64 compatibility path.

## Acceptance criteria

- Rust and TypeScript decode one frozen byte layout for every protocol kind.
- A sequence above `2^53 - 1` round-trips exactly and participates correctly in
  duplicate/gap detection.
- Snapshot is observed before all live frames for an attachment, including
  when the channel fires before the invoke promise resolves.
- Malformed/unsupported frames produce one controlled protocol error and
  recovery/disconnect action; they never partially mutate terminal state.
- Output/replay types contain `Uint8Array`, not `readonly number[]`, and the
  input path contains no `Array.from(bytes)` or base64 conversion.
- Phase 01's release-mode corpus shows no regression in sustained throughput,
  interactive latency, or peak allocation and records the raw-frame result
  rather than asserting an invented percentage.
- Any batching preserves event boundaries and is justified by measured results;
  absent that evidence, Tauri's current small-frame optimization remains.
- Existing attach, gap, overflow, resize, exit, and input tests pass through
  the new codec.

## Validation

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::protocol
pnpm exec node --test \
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
