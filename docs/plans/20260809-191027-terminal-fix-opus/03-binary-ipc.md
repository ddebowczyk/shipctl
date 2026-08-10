# Phase 03 — Binary IPC for replay and input (D2)

## Objective

Stop encoding terminal bytes as JSON number arrays in both directions.

## Context

Renderer → host, `core/frontend/platform/tauri.ts:244-247`:

```ts
export function writeTerminal(
  terminalId: TerminalId,
  data: string | Uint8Array,
): Promise<void> {
  const bytes =
    typeof data === "string" ? terminalInputEncoder.encode(data) : data;
  return invoke("write_terminal", { terminalId, data: Array.from(bytes) });
}
```

Host → renderer: `TerminalEvent::Replay { replay }` and
`TerminalEvent::Output { data }` cross a `Channel<TerminalEvent>`
(`core/backend/src/terminal/commands.rs:88`) whose blanket `IpcResponse` impl
serialises through JSON. A measured replay of ~51 KB of escape sequences at
120×30 with ~595 rows of history becomes roughly **172 KB** on the wire as a
number array, and today that is published on every resize tick, tab switch and
theme change.

Tauri v2 supports a raw path: `InvokeResponseBody::Raw` arrives in JS as an
`ArrayBuffer`, with `MAX_RAW_DIRECT_EXECUTE_THRESHOLD = 1024` selecting the
fetch-based route above that size. This is a platform contract, not a value
this plan chooses.

**Two corrections to the naive version of this change**, both verified against
the pinned `tauri 2.11.5` (`core/backend/Cargo.toml:19`):

1. *A JSON envelope with a raw payload beside it is not one atomic channel
   message.* Keeping `{sequence, kind, geometry}` as JSON while sending bytes
   raw would split one event into two deliveries with no ordering guarantee.
   The envelope and the bytes must be **one binary frame**: a fixed header
   (version, kind, flags, sequence) followed by the payload. Low-volume
   control bodies may stay UTF-8 JSON *inside* that frame.
2. *Below 1 KiB, raw bodies are still expanded to a JSON array.*
   `tauri-2.11.5/src/ipc/channel.rs:163-165` takes a direct-execute path that
   evaluates `new Uint8Array({bytes_as_json_array}).buffer`. So keystrokes and
   short output chunks gain no encoding win from raw framing — the win is on
   replay and burst output. State this plainly rather than claiming a
   latency improvement the mechanism does not deliver, and do not add batching
   purely to cross that threshold.

**Every frame kind keeps its sequence.** `TerminalEvent` today carries
`sequence` on *all* seven variants, control frames included —
`MetadataChanged`, `Exited`, `ResyncRequired` and `Detached`
(`core/backend/src/terminal/types.rs:238-268`). A codec that sequences only
snapshot, output, resize and palette would silently narrow the existing total
order and break gap detection for anything that counts consecutive sequences.
If some kind is genuinely outside the order, that is a contract change with
its own justification and test — not a side effect of designing a header.

**A note on what *not* to import from comparable protocols.** herdr frames the
same kind of traffic as a u32 little-endian length prefix plus a bincode
payload, and adds a `PROTOCOL_VERSION` handshake that refuses older *and* newer
peers, a `MAX_FRAME_SIZE`, and a larger separate cap for graphics
(`src/protocol/wire.rs:16-31,910-1021`). The framing choice corroborates this
phase. The handshake and the caps do not transfer: herdr's peers are separately
updatable binaries meeting over a socket, possibly across ssh, while shipctl's
are one app bundle's backend and its own webview, shipped and versioned
together. A header version field with an unknown-version negative fixture
already covers what shipctl can actually encounter. Do not add a frame-size cap
here on the strength of the comparison — a cap needs an authority, and a
same-bundle IPC path supplies none.

One more constraint the frame design must respect: the sequence is a `u64`.
Above `2^53 - 1` a JavaScript `number` loses precision and gap detection
breaks silently — decode it as `bigint`, and encode any `u64` in a JSON
receipt as a decimal string.

## Hypotheses to verify

**H3.1 — a `Channel<T>` payload can carry raw binary in this Tauri version.**
Method: minimal probe — a command returning `InvokeResponseBody::Raw` over a
channel, asserted in the renderer as an `ArrayBuffer` of the expected length.
Falsifier: the channel encoding forces JSON regardless, in which case replay
delivery moves to a separate `invoke` returning raw bytes while events keep
carrying only the sequence number.

**H3.2 — the ~172 KB figure reproduces on the current build.**
Method: instrument one replay publish; record serialized byte length against
`replay.bytes.len()`.
Falsifier: the ratio is near 1:1, meaning the encoding is already binary and
D2 is stale — report and close the phase.

**H3.3 — input latency is affected, or it is not.**
Keystroke payloads are a few bytes; the number-array overhead there is real
but small. Measure before claiming a latency benefit. If unmeasurable, the
justification for the input side is correctness and consistency only, and the
phase should say so rather than assert a performance win.

## Tasks

1. Land the H3.1 probe first; it decides the shape of everything below.
2. Host → renderer: define one versioned frame codec in a Rust protocol module
   with a mirrored TypeScript decoder, and carry envelope plus payload in a
   single raw channel message. Check in Rust-authored golden frames decoded by
   TypeScript and vice versa, plus negative fixtures (short header, unknown
   version or kind, truncated payload, sequence beyond `2^53 - 1`). A
   malformed frame must produce one controlled error and never partially
   mutate terminal state.
3. Renderer: accept `ArrayBuffer`/`Uint8Array` in
   `writeTerminalOutput(terminalId, data)`. The queue in
   `core/frontend/terminal/terminalOutputQueue.ts:109-126` already accepts
   `readonly number[] | Uint8Array` and copies with `.slice()` — the
   `Uint8Array` branch becomes the only live one.
4. Renderer → host: send a binary body from `writeTerminal`, dropping
   `Array.from(bytes)`. Carry the terminal id in a **request header**, not in
   a length-prefixed field inside the body: `tauri::ipc::Request::headers()`
   exists in the pinned 2.11.5 (`src/ipc/mod.rs:160`) and JS `invoke` accepts
   headers, so the raw body stays pure PTY bytes. This removes an id-framing
   parser, its negative fixtures, and canonical-id validation inside a binary
   frame.
5. Backend: accept the binary argument in `write_terminal` without changing
   its semantics or its error contract.
6. Make the host attach explicitly atomic and assert it. In **one** actor
   turn: capture the snapshot boundary `N`, register the subscriber, and
   enqueue the snapshot frame — then release live frames, all strictly above
   `N`. `runtime.rs::attach` appears to satisfy this today only because the
   actor loop serialises commands against `handle_output`; that is an
   unstated invariant holding up the entire ordering contract, so name it and
   test it rather than inheriting it. The renderer's `activate()` buffering
   (`tauri.ts:228-235`) is the second half of the same guarantee and must keep
   working under the new codec.

## Acceptance criteria

- No `Array.from(bytes)` on any terminal data path.
- Replay bytes on the wire are within a small constant factor of
  `replay.bytes.len()`; the measured factor is recorded in the commit message
  or a test comment.
- Rust and TypeScript decode one frozen layout per frame kind, and a sequence
  above `2^53 - 1` round-trips exactly and still participates in gap
  detection.
- Every variant that carries a sequence today still carries one, and gap
  detection counts exactly the same set of frames as before the codec change.
- The snapshot frame is observed before every live frame for an attachment,
  including when the channel fires before the attach invoke resolves.
- The host-side attach is one atomic actor operation (see below), asserted by
  a test that publishes output concurrently with an attach.
- `terminalOutputQueue` behaviour is unchanged: the existing overflow and
  chunking tests (`core/frontend/terminal/tests/terminalOutputQueue.test.ts`)
  pass untouched.
- No base64. It was considered and rejected: raw bodies are supported, and
  base64 would reintroduce a 33% expansion for no benefit.

## Validation

```sh
just check all
just test fast     # includes core/frontend/terminal/tests/terminalOutputQueue.test.ts
just test rust
```

Add a test asserting `writeTerminalOutput` handles an `ArrayBuffer`-backed
`Uint8Array` identically to the number-array form it accepts today, so the
migration is covered from both sides.

## Out of scope

Changing the replay's *content* or *frequency*. This phase makes the existing
payload cheap to move; phases 06-09 make it rarer and smaller.
