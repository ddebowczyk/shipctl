# Semantic protocol reaches every client

## Outcome

One versioned semantic contract carries the area 01 domain to every Shipctl
client. Tauri, the instance control socket, and the CLI each get an adapter, and
no adapter carries child PTY bytes or host-formatted ANSI. A client that cannot
decode a frame fails before it mutates a model. A new domain fact fails the
build until every adapter and the TypeScript decoder handle it.

This area owns the wire and the gate. It does not own the domain, which is area
01's, and it does not own the client model, which is area 03's.

## Context and purpose

The cross-language gate already exists and already works. It is the one asset
this area extends rather than invents.

**Built.** `core/backend/src/terminal/contract.rs` (311 lines) generates
`core/frontend/terminal/terminalEventContract.json` from the Rust types, and the
drift test at `contract.rs:297-305` fails when the generated artifact and the
committed one differ. `SHIPCTL_WRITE_TERMINAL_CONTRACT` regenerates it
deliberately. On the other side, `decodeTerminalEvent`
(`core/frontend/terminal/terminalEventDecoder.ts:95`) validates against that
artifact and is called from production, not only tests:
`terminalAttachmentBootstrap.ts:32` is the live call site. `u64` values are
already handled explicitly rather than assumed safe
(`terminalEventDecoder.ts:16`).

**Wrong at the moment.** What the gate carries is the defect. The seven
`TerminalEvent` variants at `core/backend/src/terminal/types.rs:238-268` include
`Output { sequence, revision, data: Arc<[u8]> }` and `Replay { sequence, replay
}`, and `TerminalReplay` at `:270-277` is `{ revision, columns, rows, bytes }`.
The gate is therefore an exhaustively verified contract for shipping raw bytes.

The same shape repeats on every other adapter, which is why this is one area and
not three:

- **Control socket.** `TerminalControlEvent`
  (`core/backend/src/instance/protocol.rs:346`) carries `Output { …,
  data_base64: String }` and `Replay { …, replay: TerminalReplayFrame }`.
  Base64 of the same bytes is the same authority in a different encoding.
- **Tauri.** `attachTerminal` (`core/frontend/platform/tauri.ts:215-233`) wires
  `channel.onmessage = bootstrap.deliver` at `:226`. Input goes the other way
  through `writeTerminal` (`:241-244`), which still does `Array.from(bytes)` —
  a JSON numeric array per keystroke.
- **CLI.** `cli/src/terminals.rs:319-328` is `write_raw_replay`, and `:335-336`
  routes both `Output` and `Replay` into it. The `args.raw` branches at `:257`,
  `:265-266`, `:286-287` and `:292` print the child's bytes to the caller's
  terminal.

Three transports, one authority, and it is the wrong one. Extending the gate to
carry semantic frames is what makes the deletions in area 05 mechanical instead
of exploratory.

## Dependencies

- **Blocked by.** Area 01. The domain types must exist and their revision rules
  must be stated before a wire format can carry them. This area may start
  fixture and harness work against draft types, but no encoding is selected
  before the domain stabilises.
- **Blocks.** Area 03, which decodes these frames, and area 05, which deletes
  the paths this area replaces.
- **Not blocked by.** The OSC 9 payload gap. The envelope reserves the effect;
  the register in area 04 owns the row.

## Affected areas

- `core/backend/src/terminal/contract.rs` — extended with the domain types.
- `core/backend/src/terminal/types.rs` — the event envelope beside `:238`.
- `core/backend/src/instance/protocol.rs` — the control adapter at `:346`.
- `core/frontend/terminal/terminalEventDecoder.ts` — fail-closed decoding.
- `core/frontend/platform/tauri.ts` — frame delivery and input submission.
- `cli/src/terminals.rs` — the presentation adapter that replaces raw output.

## Work to be done

1. **Carry the domain through `contract.rs` and nowhere else.** Every semantic
   frame, effect, and input command appears in
   `core/frontend/terminal/terminalEventContract.json` because it was generated
   from Rust. A second hand-maintained envelope is the defect class this gate
   was built to close, and adding one silently reopens it.
2. **State the envelope fields once.** Protocol version, frame kind, terminal
   ID, attachment identity, consecutive stream sequence, resulting revision,
   and — for any frame that depends on prior client state — the base revision it
   applies to. Terminal ID is sufficient identity under the current
   non-reused-UUID contract; do not add an incarnation field without a
   terminal-survival requirement that reuses an ID across host processes.
3. **Make the frame kinds explicit and few.** A complete snapshot that replaces
   the client model atomically; a delta that declares base and resulting
   revision; a history window response that names its source revision and
   retained bounds; and ordered effects. A structural change that invalidates
   the baseline produces a complete frame, not an ambiguous partial delta.
   Effects are never collapsed into the latest screen: a bell that happened
   twice happened twice.
4. **Represent input as semantic commands.** Key, composed text, paste, mouse,
   resize proposal, selection gesture, viewport request, and application preset.
   Text and paste preserve exact UTF-8. Keyboard and mouse encoding modes are
   resolved by the host, because the host is the VT. The view never submits an
   arbitrary PTY write, which is what `writeTerminal` (`tauri.ts:241-244`)
   accepts today.
5. **Select the encoding from measurement, in the packaged app.** Prototype the
   schema with the smallest stable candidates that have maintained Rust and
   TypeScript implementations. Measure encoded size, allocation, encode and
   decode time, main-thread work, interaction latency, sustained output,
   recovery time, and malformed-input rejection. Select one codec from that
   evidence and freeze golden fixtures. Use `Channel<InvokeResponseBody>` with
   `InvokeResponseBody::Raw` for binary delivery, and verify the actual
   JavaScript value and cost on both the small-body path and the larger
   fetch-backed path of the pinned Tauri version.
6. **Do not import a limit that has no authority here.** Comparable
   multiplexers ship a protocol version handshake and hard frame caps because
   their peers are separately installed binaries that can disagree about
   version. Shipctl's frontend, backend and CLI ship in one bundle. A cap needs
   an authority, and a same-bundle IPC path supplies none. Every mailbox depth,
   frame size, batching interval and coalescing rule in this area is derived
   from the measurements in item 5 or from a stated product requirement, and the
   plan records which. Nothing is carried over from the current raw-byte budget
   merely because it already exists.
7. **Keep the control socket's framing and change only its meaning.** JSONL and
   base64 for binary payloads may stay inside the explicit control adapter. What
   may not stay is the meaning: `Output` and `Replay` at `protocol.rs:346` stop
   carrying child bytes and carry semantic frames, and the adapter passes the
   same exhaustive coverage and golden fixtures as the Tauri path.
8. **Prototype the CLI presentation adapter and prove it before area 05
   commits.** `shipctl terminals attach` consumes semantic frames and paints
   authoritative cells to the caller's terminal. The external terminal
   necessarily interprets the paint sequences the CLI generates locally; that is
   presentation. What ends is reconstruction: the CLI never reparses the child
   PTY stream, and no adapter transports child bytes. Characterise interactive
   behaviour, cursor, alternate screen, resize, scrollback, signals and job
   control, and both raw and NDJSON output modes. If the compatibility contract
   cannot be met, stop with evidence for an owner decision rather than leaving
   raw output undocumented under a single-VT claim.
9. **Decode fail-closed, before any model mutation.** Lengths, dimensions, table
   indices, revisions and allocation bounds are checked first. A malformed or
   unsupported frame is rejected whole. `terminalEventDecoder.ts` already
   represents `u64` without loss (`:16`); the same discipline extends to every
   new numeric field.
10. **Prove atomic bootstrap inside the runtime actor.** Capture the
    sequence and revision boundary, register the subscriber, enqueue its
    complete snapshot, then release later events. Delivery that begins before
    the attach invoke resolves stays ordered. This is a transport obligation
    because the ordering is established at the point of subscription.

## Acceptance criteria

1. Adding a semantic frame field in Rust without regenerating the artifact fails
   `contract.rs:297-305`. Removing one fails it too. Both directions are proven
   by doing them.
2. **The gate is seen failing once, deliberately.** Perturb the semantic
   envelope — change one field name in the Rust type — confirm the drift test
   fails and names the field, then revert. A gate never observed failing has not
   been shown to work. This criterion is not satisfied by a passing run.
3. A frontend build that ignores a new frame kind does not compile, or fails the
   decoder's exhaustiveness test. Silent tolerance of an unknown kind is a
   failure, not forward compatibility.
4. A malformed frame is rejected with no partial mutation of any client
   structure, proven by a test that asserts model identity is unchanged after a
   rejected frame.
5. The codec selection is recorded with its measurements, its method, and the
   candidates rejected. Every numeric limit in the shipped protocol cites either
   one of those measurements or a stated product requirement. A limit with no
   cited authority is a review failure.
6. The control socket carries semantic frames and passes the same golden
   fixtures as the Tauri adapter, asserted against the fixtures rather than
   against the other adapter's implementation.
7. The CLI adapter paints a characterisation session correctly from semantic
   frames alone, with `write_raw_replay` unreachable from the semantic path.
8. Sequence numbers are consecutive across frames and effects in a run that
   interleaves both, and every delta is applied against its declared base
   revision.

## How to validate

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::contract
cargo test --manifest-path core/backend/Cargo.toml terminal::
node --test --test-concurrency=1 core/frontend/terminal/tests
just check all
just test rust
just test fast
```

Measurement runs are release-mode and in the packaged macOS application, not in
`vite dev`. The recorded method is part of the deliverable, because area 05
repeats these measurements and needs to compare against something reproducible.

## Exit and rollback

The semantic protocol is additive until area 03 consumes it. Both authorities
exist briefly, and only one is authoritative: the legacy `Output` and `Replay`
variants keep working, untouched, until area 05 deletes them as a unit. Rolling
back this area is deleting new code, never restoring deleted code.

The stop condition is item 8. If no adapter over semantic frames can serve the
CLI's current contract, this area returns falsifying evidence to the owner and
single-VT closure is re-opened. It is not closed by a decision-register waiver
while a Shipctl adapter still transports PTY bytes.
