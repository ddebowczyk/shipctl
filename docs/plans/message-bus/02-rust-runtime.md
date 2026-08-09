# Rust runtime

## Placement

Add one backend capability at `core/backend/src/message_bus/`:

- `contracts.rs` — wire types, identifiers, schema descriptors, and receipts;
- `routes.rs` — prepared registrations and immutable route snapshots;
- `runtime.rs` — Tokio channels, routing, shutdown, and delivery accounting;
- `diagnostics.rs` — stable diagnostic codes and redacted observations;
- `commands.rs` — thin Tauri wrappers only;
- `mod.rs` — narrow public exports.

`src-tauri/src/lib.rs` constructs and manages the service beside the other
per-instance services and registers the commands. No routing behavior belongs
in the Tauri shell.

## Runtime ownership

Construct `RuntimeMessageBus` from `InstanceContext`. It carries the instance
incarnation only on observations; it does not create durable desired state.
There is no process-global singleton and no cross-instance route registry.

The service owns:

- a `watch` sender for the current `MessageRouteSnapshot`;
- bounded `mpsc` queues for directed channel owners;
- `broadcast` senders for topics;
- `oneshot` replies for explicit capability-port requests;
- cancellation and owner-registration handles;
- in-memory counters and the most recent redacted failure per endpoint.

Add a direct Tokio dependency with only the features actually used by this
capability. Add `test-util` only for tests that pause and advance time.

## Registration mechanics

These are bus-local operations on prepared registrations. `shep-btu.10` owns
the live module lifecycle decision that prepares, publishes, or withdraws them.

1. Compile and validate a module's schemas.
2. Resolve declared dependencies and effective grants.
3. Allocate queues and create an owner-bound `PreparedRegistration`.
4. Start handlers while their routes remain hidden.
5. Publish one complete route snapshot when its caller accepts the prepared
   registration.
6. On withdrawal, publish the replacement snapshot before cancelling handlers.
7. Dispose registrations idempotently after in-flight leases drain.

Failure before publication leaves the active snapshot untouched. The
module-control supervisor owns any lifecycle reconciliation after withdrawal;
the bus reports its observable registration and lease state.

## Tauri bridge

Frontend-to-Rust calls use narrow Tauri commands for send, publish, bridge
open, and inspection. Rust-to-frontend delivery uses one ordered Tauri
`Channel<HostMessageFrame>` per webview bridge rather than dynamically named
Tauri events. Frames contain route generation, endpoint identity, message type,
payload, and correlation data required by explicit capability-port replies.

This deliberately follows Tauri's transport conventions: commands and channels
cross the native/webview boundary, while ordinary Tauri events remain available
for lightweight shell/UI notification. `RuntimeMessageBus` is the dynamic
capability-routing layer above that bridge; it does not replace Tauri IPC.

Bridge closure cancels only frontend-owned registrations. Backend-owned
channels remain available. Reopening the webview obtains the current route
snapshot and a new bridge; the bus never depends on a webview-created identity
for durable process ownership.

## Error model

Use stable codes for at least these conditions:

- unknown message contract;
- incompatible message version;
- invalid or oversized payload;
- unauthorized sender;
- no active channel owner;
- duplicate channel owner;
- subscriber lag;
- handler unavailable or failed;
- route generation changed during preparation;
- bridge closed.

Errors include endpoint, message type, route generation, and redacted context.
Payloads and secret-marked fields are never copied into routine diagnostics.

## Explicit non-goals

- no SQL or filesystem writes on send, publish, receive, or handler completion;
- no payload history in diagnostic memory;
- no automatic retries or invented timeouts;
- no network listener or broker protocol;
- no terminal byte transport;
- no module-specific Rust command added for a TypeScript-only module.
