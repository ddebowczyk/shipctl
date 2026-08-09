# Module contracts and call-site migration

## Objective

Migrate every module and cross-capability terminal call site to the host-owned
terminal service. Remove numeric PTY IDs, spawn-time output channels, and
renderer-only owner/session maps from the shared module API. Modules continue
to own their business records and cleanup policy; core owns terminal execution,
replay, and lifecycle.

This slice assumes the backend and frontend core APIs already expose stable
`TerminalId`, typed shell/program launch, descriptors with serializable owner
metadata, detachable renderer attachments, registry reconciliation, and
idempotent close.

## Boundary decision

`modules/api/` is the shared host/module contract. It must express terminal
intent and lifecycle, not Tauri transport details.

The final boundary is:

```text
module requests launch + supplies safe owner descriptor
                |
                v
core TerminalService owns process / VT / lifecycle / subscribers
                |
                v
core projects terminal into renderer and sends owner lifecycle to module
                |
                v
module creates, adopts, updates, or cleans up its own logical record
```

A module must not receive raw terminal output merely to pass it back to core.
If a future module genuinely needs a semantic output stream, add a separate,
explicit observation capability with its own security/backpressure contract;
do not reintroduce it into launch.

## Shared backend API

Replace the current backend `TerminalAuthority` shape in
`modules/api/backend/src/lib.rs`:

```text
spawn(request, Channel<TerminalOutput>) -> u32
kill(u32)
```

with a transport-neutral capability:

```rust
trait TerminalAuthority {
    fn spawn(&self, request: ModuleTerminalSpawnRequest)
        -> Result<TerminalDescriptor, ModuleTerminalError>;
    fn get(&self, id: TerminalId)
        -> Result<Option<TerminalDescriptor>, ModuleTerminalError>;
    fn close(&self, id: TerminalId)
        -> Result<TerminalCloseResult, ModuleTerminalError>;
    fn update_metadata(&self, id: TerminalId, patch: SafeMetadataPatch)
        -> Result<TerminalDescriptor, ModuleTerminalError>;
}
```

Only include operations current modules need. Do not expose attach/write/resize
to module backends unless an actual module requirement proves them necessary.
Core frontend owns xterm input/output.

Remove `TerminalOutput` from the module backend API if it has no other real
consumer. Reuse terminal domain DTOs from the correct shared boundary without
making `modules/api` depend on Tauri.

`src-tauri/src/modules/assistants.rs` remains a thin adapter from
`TerminalAuthority` to app-managed `TerminalService`. It passes typed requests,
not a Tauri channel, and returns the same string ID/descriptor.

## Shared frontend API

In `modules/api/frontend/src/services.ts`, replace:

- `terminalId: number`;
- launch-time `onOutput` callbacks;
- managed-start callbacks that require a Tauri `Channel`;
- `ownerMetadata?: unknown`.

Define:

```ts
type TerminalId = /* shared branded string */;
type JsonValue = null | boolean | number | string | JsonValue[] |
  { [key: string]: JsonValue };

interface ModuleTerminalOwner {
  moduleId: string;
  ownerKey: string;
  moduleSessionId: string;
  ownerMetadata?: JsonValue;
  presentation?: JsonValue; // or a narrower existing presentation DTO
}

interface ModuleTerminalSessionSnapshot {
  terminalId: TerminalId;
  descriptor: TerminalDescriptor;
  owner: ModuleTerminalOwner;
}
```

Keep `moduleSessionId` distinct from `TerminalId`. A module logical session may
have records and semantics that outlive or relate to terminal execution. It can
be host-minted or provided as a stable module key, but it must be serialized in
the owner descriptor so renderer reload can reconstruct the relationship.

Validate `JsonValue` recursively at the host boundary. Owner metadata and
presentation must be redacted domain data, not arbitrary runtime objects,
callbacks, stores, provider clients, or credentials.

## Lifecycle/adoption port

Extend `ModuleTerminalSessionsPort` with explicit host projection events. Use
one vocabulary across initial reconciliation and later registry events:

- `launched(snapshot)`: a launch requested by this renderer completed;
- `adopted(snapshot)`: a host terminal already existed when the renderer/module
  runtime initialized;
- `updated(snapshot)`: descriptor, lifecycle, presentation, or agent state
  changed;
- `exited(snapshot)`: host process exited but record remains discoverable;
- `closed({ terminalId, owner })`: host record was explicitly removed.

The core reconciliation layer dispatches these events to the module identified
by `owner.moduleId`. Core treats owner metadata as opaque. The module decides
how to rebuild its maps/records and what cleanup an explicit close requires.

Make adoption idempotent by `TerminalId` plus owner key. A module receiving the
same snapshot through list reconciliation and a racing registry event must
produce one logical session.

Do not fire destructive module cleanup on:

- renderer disconnect;
- xterm unmount;
- attachment overflow/resync;
- application projection rebuild;
- natural exit, unless the module's existing semantics explicitly require
  finalization rather than retained inspection.

Explicit host close triggers cleanup once. Natural exit updates the logical
record and lets the user inspect/close it.

## Assistants backend migration

In `modules/assistants/backend/src/lib.rs`:

1. Remove `Channel<TerminalOutput>` from spawn/resume plugin commands.
2. Change `pty_id: u32` to `terminal_id: TerminalId` in
   `SpawnedAssistantSession` and all serialized results.
3. Build a `ModuleTerminalSpawnRequest` with:
   - direct `Program { program, argv }` launch;
   - cwd/environment required by the assistant;
   - redacted label/display command;
   - module owner descriptor containing the stable assistant record/session
     identity and safe presentation data.
4. Delegate to `TerminalAuthority::spawn`.
5. Store or return the terminal ID alongside the assistant record using the
   module's existing persistence/record mechanisms.
6. Close through `TerminalAuthority::close` and make duplicate cleanup safe.

The assistant backend does not subscribe to raw output. Existing assistant
state capture that uses files/timers/provider records remains module-owned and
must be validated independently.

Preserve all current provider-specific launch/resume argv and environment
behavior, but pass argv directly. Add tests proving spaces/quotes are not
reinterpreted by a shell.

## Assistants frontend migration

In `modules/assistants/frontend/src/client.ts` and `src/runtime.ts`:

- remove Tauri `Channel` construction and `onOutput` forwarding;
- consume `terminalId: TerminalId` from plugin results;
- let core's registry event/reconciliation create and attach the xterm view;
- implement `launched/adopted/updated/exited/closed` handlers that upsert the
  assistant's logical session by stable terminal/owner identity;
- prevent the same record from being registered once by the immediate command
  result and again by the registry event;
- preserve assistant cleanup ownership on explicit close.

If command results need immediate selection, return the descriptor/terminal ID
to core and route it through the same reconciliation action used by registry
events. Do not create a parallel tab/session insertion path.

## Commands module migration

`modules/commands/frontend/src/runtime.ts` currently tracks terminal ownership in
renderer memory and creates sequence-based owner keys. That cannot survive a
renderer restart.

Replace it with stable, serializable owner data:

- derive or mint an owner key from the command invocation's durable identity
  according to existing command semantics;
- store the command/module session identity in the host terminal owner
  descriptor;
- on `adopted`, reconstruct the commands runtime's owner maps from that
  descriptor;
- on repeated adoption, update the existing entry;
- on exit, mark the command terminal exited without losing its inspectable
  record;
- on explicit close, run cleanup exactly once and remove the owner mapping.

Do not use a renderer incrementing `ownerSequence` as the only identity. If the
command capability has no durable invocation ID today, mint a UUID at launch
and place it in owner metadata; the host then carries it through renderer
reload.

## Core terminal owner

Blank shells and core-created terminals use a core owner descriptor rather than
pretending to be a module:

```text
owner.kind = core
owner.capability = terminal
```

Module-owned descriptors use:

```text
owner.kind = module
owner.module_id
owner.owner_key
owner.module_session_id
owner.metadata/presentation
```

Use tagged Rust/TypeScript enums so exhaustive handling prevents a module owner
from falling through the core path.

## Metadata updates

Modules may update safe label/presentation/owner state without respawning. Route
updates through `TerminalService::update_metadata` so record revision and
registry events remain authoritative.

Use a typed patch that permits only explicitly public fields. Never accept a
generic object merge into the complete record; it could overwrite lifecycle,
terminal ID, cwd, or secret launch state.

## Call-site inventory and deletion checklist

Use `rg` and `ast-grep outline` before editing each area, then remove all final
matches for:

- `PtyOutput`/`TerminalOutput` module pass-through DTOs;
- `Channel<...TerminalOutput...>` and `on_data` in terminal spawn paths;
- `onOutput` in module terminal launch/start signatures;
- `terminalId: number`, `ptyId`, and `pty_id` at module/core boundaries;
- `ModuleManagedTerminalStartResult.terminalId: number`;
- renderer session/owner sequence counters used as stable identity;
- module clients that call terminal output handlers directly.

Do not globally delete unrelated uses of Tauri `Channel`; target terminal output
paths only.

## Tests

### Contract tests

- Backend and frontend module API serialize the same string `TerminalId` and
  owner descriptor.
- `JsonValue` accepts valid nested data and rejects non-serializable values.
- Descriptor serialization redacts argv/environment secret sentinels.
- No module contract depends on a Tauri type.

### Assistants tests

- Spawn and resume return stable terminal IDs without channel arguments.
- Every provider preserves exact direct argv/environment semantics.
- Immediate launch plus registry event creates one assistant session.
- Renderer reload/adoption rebuilds the same assistant session and view.
- Natural exit marks the record; explicit close performs cleanup once.
- Attachment failure does not invoke assistant cleanup.

### Commands tests

- Stable owner key survives renderer runtime reconstruction.
- Repeated adoption is idempotent.
- Exit and explicit close have distinct effects.
- Command-owned presentation metadata round-trips through the descriptor.

### Boundary tests

- Removing/disabling assistants or commands module leaves core terminal
  capability functional.
- Core does not import module internals; modules use exported
  `@shipctl/core/<capability>` and `modules/api` contracts.
- `just modularity boundaries` passes.

## Acceptance criteria

This slice is complete when:

- module APIs contain no numeric PTY identity or terminal output channel;
- assistants and commands use direct typed launch requests;
- renderer reconciliation can adopt core, assistant, and command terminals;
- module logical session IDs remain distinct and rediscoverable through safe
  owner descriptors;
- natural exit and explicit close dispatch different module events;
- every cleanup path is idempotent and owned by the module;
- no module output pass-through or renderer-only stable-ID counter remains;
- module boundary and behavior tests pass.

## Files expected to change

- `modules/api/backend/src/lib.rs`
- `modules/api/frontend/src/services.ts`
- `modules/assistants/backend/src/lib.rs`
- `modules/assistants/frontend/src/client.ts`
- `modules/assistants/frontend/src/runtime.ts`
- `modules/commands/frontend/src/runtime.ts`
- `src-tauri/src/modules/assistants.rs`
- core terminal/module adapter code and relevant tests

Keep removable feature behavior inside its module. Core stores and transports
the opaque owner descriptor but does not interpret assistant or command
business state.
