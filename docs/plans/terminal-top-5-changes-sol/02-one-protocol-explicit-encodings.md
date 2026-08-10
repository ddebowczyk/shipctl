# One semantic terminal protocol, explicit adapters

## Outcome

Make the Rust terminal event model the semantic authority and require every
transport/frontend adapter to prove coverage of that model, without optimizing
the temporary raw-PTY frontend protocol.

## Context and purpose

The same terminal event taxonomy is manually represented in backend domain
types, the instance control protocol, and the frontend TypeScript union.
Replay payloads are similarly duplicated. A later semantic cell protocol will
add snapshots, deltas, history windows, effects, and semantic input, so the
adapter surface must fail safely on drift before it expands.

The previous version of this preparation item also moved Tauri output from
JSON number arrays to raw PTY frames. The canonical
[single-VT plan](../top-5-single-vt-closure/README.md) removes the frontend VT
parser, so that cutover would optimize a path scheduled for deletion. Change 2
of the closure plan owns the measured binary transport for semantic cell state.

This readiness change preserves current production wire behavior. Its value is
one semantic model, explicit transport adapters, and an executable completeness
gate.

## Affected areas

- `core/backend/src/terminal/types.rs`
- a focused backend terminal protocol/adapter module
- `core/backend/src/terminal/commands.rs`
- `core/backend/src/instance/protocol.rs`
- `core/backend/src/instance/control.rs`
- `core/frontend/terminal/types.ts`
- a focused frontend terminal protocol decoder/adapter
- `core/frontend/platform/tauri.ts`
- the preparatory `TerminalAttachmentController`
- `cli/src/terminals.rs`
- `core/frontend/terminal/terminalSessions.ts`
- module-facing terminal session adapters and characterization tests

The module boundary is in scope. `terminalSessionFromDescriptor` and
`publishTerminalDescriptor` convert host descriptors into
`ModuleTerminalSession` values, while module runtimes subscribe through that
port. Event or descriptor drift must be visible at this seam.

## Work to be done

1. Inventory the current Rust domain events, replay data, descriptors, commands,
   and required fields. Preserve non-zero consecutive terminal sequences and
   attachment bootstrap order.
2. Keep the backend terminal types as the internal semantic model. Make every
   Tauri and control-socket adapter exhaustive so a new domain variant fails
   compilation until each mapping is updated.
3. Keep the public control protocol as an explicit stable wire DTO where its
   JSONL contract differs. Prove its conversion to and from domain values
   instead of treating it as another semantic authority.
4. Add a checked-in cross-language manifest or golden fixture for event names,
   required fields, sequence behavior, and descriptor/lifecycle variants. The
   TypeScript adapter fails closed on unsupported or malformed variants.
5. Remove duplicate Rust or TypeScript taxonomies only where an exhaustive
   adapter or generated manifest replaces them without changing the public wire
   contract.
6. Characterize initial attachment ordering when channel events arrive before
   the attach invoke resolves. Carry the trace into the DOM-free controller
   tests from change 1.
7. Label the current Tauri JSON number arrays, control-socket base64 PTY bytes,
   and ANSI replay as transitional adapter formats. Do not add a new raw-PTY
   codec, batching policy, fallback encoding, or production cutover here.
8. Record the pinned Tauri raw-channel and raw-request capabilities as evidence
   for closure change 2, including its distinct small-body delivery path. The
   closure plan must remeasure them with semantic frames before selecting a
   codec.
9. Prove module-facing terminal lifecycle and descriptor behavior through the
   existing commands and assistants characterization suites.
10. Document the exact extension seam the semantic cell protocol will use, so
    closure change 2 can replace transport DTOs without changing the domain
    ownership or completeness gate.

## Acceptance criteria

- One Rust semantic model defines the current terminal event and descriptor
  taxonomy.
- Rust compilation or contract tests fail when a Tauri or control-socket
  adapter omits a domain variant or required field.
- The cross-language fixture fails when TypeScript omits, renames, or weakens a
  current semantic variant, field, or sequence rule.
- Unsupported and malformed frontend variants fail before mutating the
  controller or renderer.
- Attachment bootstrap is characterized when delivery precedes the invoke
  result, and the DOM-free controller preserves that order.
- The control socket and CLI retain their declared compatibility through an
  explicit adapter.
- Module characterization tests preserve current lifecycle and descriptor
  meaning.
- No production wire encoding changes in this readiness item. Raw PTY output,
  ANSI replay, and arbitrary byte input are explicitly transitional and are not
  made faster or more permanent.
- The canonical closure plan is the only place that defines semantic binary
  frames, history windows, semantic input, batching, and final codec cutover.

## How to validate

Run backend adapter, control-protocol, cross-language fixture, controller-order,
and module characterization tests.

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal
cargo test --manifest-path core/backend/Cargo.toml instance::control
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalProtocol.test.ts \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts
pnpm exec node --test --test-concurrency=1 \
  modules/commands/frontend/tests/commandsCharacterization.test.ts \
  modules/assistants/frontend/tests/assistantsCharacterization.test.ts
just check all
just test fast
just test rust
git diff --check
```
