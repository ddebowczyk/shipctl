# One semantic model has exhaustive adapters

## Outcome

Keep one Rust terminal event model as the semantic authority and add an
executable cross-language contract that detects missing variants and required
fields before an event can mutate frontend state.

Preserve current terminal-event and PTY-payload encodings. The semantic
cell-frame schema and its binary transport belong to the closure plan. A typed
write outcome required by change 05 is a separate command-response contract.

## Context and purpose

The current event taxonomy is represented in three places:

- `TerminalEvent` in `core/backend/src/terminal/types.rs`;
- `TerminalControlEvent` and `TerminalReplayFrame` in
  `core/backend/src/instance/protocol.rs`; and
- a handwritten `TerminalEvent` union in
  `core/frontend/terminal/types.ts`.

The control adapter's `terminal_event_frame` currently uses an exhaustive Rust
match, so rustc already catches a missing variant there. The unprotected gaps
are cross-language and field-level: TypeScript has no checked relationship to
the Rust declaration, and a conversion can omit a new required field from an
existing variant unless the adapter destructures and reconstructs it
explicitly.

The future semantic protocol is materially larger than today's event model.
Installing the completeness mechanism now prevents the new protocol from
creating another authority by copy-and-convention. Optimizing the current JSON
number arrays or base64 PTY path would instead harden a transport the single-VT
cutover deletes, so it is out of scope.

## Affected areas

- `core/backend/src/terminal/types.rs`
- a focused backend terminal protocol/adapter module
- `core/backend/src/terminal/commands.rs`
- `core/backend/src/instance/protocol.rs`
- `core/backend/src/instance/control.rs`
- `core/frontend/terminal/types.ts`
- a focused frontend terminal decoder/adapter
- `core/frontend/platform/tauri.ts`
- the DOM-free attachment controller from change 02
- `cli/src/terminals.rs`
- `core/frontend/terminal/terminalSessions.ts`
- module-facing terminal session adapters and their characterization tests
- `ops/test/justfile`

## Work to be done

1. Inventory the current domain variants, required fields, replay fields,
   sequence rules, descriptors, lifecycle values, and attachment bootstrap
   order. Distinguish domain meaning from Tauri and control-socket wire DTOs.
2. Keep `core/backend/src/terminal/types.rs` as the Rust domain authority. The
   public JSONL control protocol remains a stable explicit DTO, not a second
   domain model.
3. Put wire conversions at named adapter boundaries. Rust mappings must avoid
   wildcard variants and field-rest patterns so adding a domain variant or
   required field makes an adapter fail to compile until it is considered.
4. Generate or verify a checked-in structural contract artifact from the authoritative
   Rust serialization boundary. It must identify every current variant and the
   required fields and field types that a consumer relies on. Do not introduce
   another independently maintained list as the gate.
5. Assert the TypeScript wire decoder against that artifact. Unknown variants,
   missing required fields, invalid field types, and invalid sequence values
   fail closed before reaching the attachment controller, registry, or
   renderer.
6. Cover ordering and lifecycle meaning in behavioral trace fixtures rather
   than claiming they are derived from a serialization schema. Characterize
   Tauri attachment bootstrap where channel delivery can precede
   the attach invoke result. Change 02 owns the state machine; this item owns the
   decoded contract it consumes.
7. Close the transitional `u64`-to-TypeScript `number` precision gap without an
   encoding change. Because JavaScript numbers represent integers exactly only
   through `9_007_199_254_740_991`, enforce that technical boundary in both the
   Rust Tauri adapter and TypeScript decoder. Defer any sequence-representation
   change to the semantic closure protocol. The two sides cannot claim
   consecutive ordering while accepting inexact values.
8. Preserve the control socket and CLI JSONL/base64 compatibility through
   explicit adapters and fixtures. Preserve current module descriptor and
   lifecycle meaning through the commands and assistants characterization
   suites.
9. Document how the mechanism is extended: closure area 02 adds semantic
   snapshots, deltas, history windows, effects, and input DTOs to the same
   completeness gate after closure area 01 defines their schema.
10. Keep the current Tauri JSON byte arrays, ANSI replay, control-socket base64,
   and arbitrary-byte input labeled transitional. Do not add raw-PTY codecs,
   batching, fallback encodings, or a production wire cutover here.
11. Register the protocol and attachment-controller suites in the serial
    terminal lane in `ops/test/justfile` so the repository test gate executes
    them.

## Acceptance criteria

- One Rust model defines the current domain meaning; transport DTOs are explicit
  compatibility adapters rather than competing authorities.
- Adding a Rust domain variant or required field breaks an affected adapter or
  contract test until every boundary is considered.
- The checked cross-language structural artifact covers variants, required
  fields, and field types and is derived or verified from the Rust serialization
  boundary rather than maintained as an unrelated golden list.
- TypeScript rejects unsupported or malformed events before they mutate the
  controller, registry, or presentation state.
- Behavioral traces separately cover Tauri bootstrap ordering, non-zero
  consecutive sequences, descriptors, and lifecycle transitions.
- Rust and TypeScript enforce the JavaScript exact-integer boundary for the
  transitional numeric sequence. A representation change belongs to closure.
- Control-socket, CLI, and module-facing compatibility are preserved through
  named adapters and characterization tests.
- The gate can be extended with future semantic frames without replacing its
  ownership model.
- No terminal-event or PTY-payload encoding changes. Raw PTY output, ANSI
  replay, and arbitrary byte input remain temporary and receive no new
  optimization. Change 05 may type the separate write-command outcome.
- The new frontend suites are included in the repository terminal test lane.

## How to validate

Run backend adapter and control-protocol tests, the cross-language decoder
fixture, attachment bootstrap traces, and module characterization suites.
Include negative TypeScript cases for unknown variants, absent fields, and
invalid sequence values.

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal
cargo test --manifest-path core/backend/Cargo.toml instance::control
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalProtocol.test.ts \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts
pnpm exec node --test --test-concurrency=1 \
  modules/commands/frontend/tests/commandsCharacterization.test.ts \
  modules/assistants/frontend/tests/assistantsCharacterization.test.ts
just test fast
just test rust
just check all
git diff --check
```
