# One terminal protocol, one encoding

## Context and purpose

One terminal event protocol exists in three hand-maintained copies:

- `core/backend/src/terminal/types.rs:238-267` — `TerminalEvent`, with
  `data: Arc<[u8]>`;
- `core/backend/src/instance/protocol.rs:346-389` — `TerminalControlEvent`,
  the same seven variants again, with `data_base64: String`;
- `core/frontend/terminal/types.ts:142-172` — a TypeScript mirror, with
  `readonly data: readonly number[]`.

The replay payload is duplicated the same way: `TerminalReplay`
(`types.rs:272-280`) and `TerminalReplayFrame` (`protocol.rs:318-324`).

Two problems follow.

**Drift.** Adding a variant or a field means three edits in three files in two
languages. No test fails if an author makes two of the three. `rg` finds no
test that references `TerminalEvent` in `core/frontend/terminal/tests/` or
`cli/tests/`.

**Encoding.** The Tauri path sends PTY bytes as a JSON array of decimal
numbers. `attach_terminal` uses `Channel<TerminalEvent>`
(`terminal/commands.rs:88`), serde_json expands `Arc<[u8]>`, and the renderer
receives `number[]`. Each byte costs two to four ASCII digits plus a comma:
about four times the payload, plus a JSON parse, on the highest-volume path
in the application. Input has the same shape — `tauri.ts:246` calls
`Array.from(bytes)`. The control socket already uses base64 for the identical
stream, so the slower encoding sits on the hot path while the faster one
serves the CLI.

Note what is already correct: every variant on all three surfaces carries a
`sequence`. Gap detection covers control events, not only output. Do not
rebuild that.

Both plans depend on this surface. Ordered resize and palette markers add
variants; binary transport replaces the payload. Fix the surface once, before
either plan writes to it.

## Work to be done

1. Make the Rust `TerminalEvent` the single source of truth. Derive the
   control-socket form from it instead of declaring the variants a second
   time. Keep the base64 field for the socket if the JSON control protocol
   requires text, but derive it — do not restate the variant list.
2. Collapse `TerminalReplayFrame` into `TerminalReplay` plus a transport-level
   encoding choice.
3. Replace the JSON number arrays on the Tauri path with raw binary channel
   frames for output and replay. Send input as a raw invoke body with the
   terminal ID in a validated request header.
4. Remove `readonly number[]` from the public TypeScript surface and
   `Array.from(bytes)` from `tauri.ts`. The renderer receives `Uint8Array`.
5. Add a contract test that fails when the surfaces drift: enumerate the Rust
   variants and assert the TypeScript union and the control-socket form carry
   the same variant names and the same required fields.
6. Confirm the raw-body behavior of the pinned Tauri version before relying on
   it. The opus plan reports that Tauri expands small raw bodies back to a
   JSON array below 1 KiB (`tauri-2.11.5/src/ipc/channel.rs:163-165`). Verify
   this against the version in `Cargo.lock` and record the result. If it
   holds, the frame format must not depend on payload size.

## Acceptance criteria

- The seven event variants and their fields are declared once in Rust.
- A drift test fails if a variant is added to Rust and not to the TypeScript
  union or the control-socket form.
- `rg 'readonly number\[\]' core/frontend/terminal/types.ts` returns nothing.
- `rg 'Array.from\(bytes\)' core/frontend/platform/tauri.ts` returns nothing.
- Output and replay cross the Tauri boundary as raw frames. A recorded
  measurement shows the bytes on the wire for a fixed 64 KiB output burst
  before and after, taken with the same method.
- The small-payload behavior of the pinned Tauri version is recorded in this
  document with the version number and the observed result.
- `shipctl terminals attach` still streams correctly. The CLI path keeps
  base64 and stays compatible.
- Sequence coverage is unchanged. Every variant still carries a non-zero
  consecutive `sequence`.

## How to validate

```sh
just check all
just test rust
just test fast
just test full
```

Protocol round-trip, in Rust tests beside the types, matching the existing
`#[cfg(test)] mod tests` in `types.rs:373` and `service.rs:470`:

- encode then decode every variant; assert field-for-field equality;
- assert a binary output frame survives a byte sequence containing `0x00`,
  invalid UTF-8, and a 64 KiB run.

End to end:

```sh
shipctl terminals attach <id>   # streams and decodes
```

In the application, run a command with large output, such as `find /usr`, and
confirm the terminal keeps up. Compare renderer CPU against the pre-change
build with the same command.
