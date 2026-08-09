# Contracts and semantics

## Public concepts

`MessageTypeId`
: Stable, capability-owned identifier plus schema version.

`DirectedChannel`
: One logical destination with one active owner. Sending preserves acceptance
  order within that channel.

`BroadcastTopic`
: Zero or more current subscribers. Publishing is best effort and does not wait
  for subscriber work to finish.

`CapabilityPort`
: Explicit request/response API. Internally it may use `mpsc` plus `oneshot`,
  but it remains distinct from broadcast messaging.

`MessageRouteSnapshot`
: Immutable set of active contracts, owners, subscribers, and grants for one
  instance generation.

## Message contract

Each message type declares:

- stable identifier and schema version;
- JSON Schema Draft 2020-12 payload schema;
- required maximum encoded payload size;
- fields that must be redacted from diagnostics;
- compatibility metadata for consumers.

Schemas are shipped inside the module artifact. Resolution is local and
deterministic; runtime validation never fetches remote references. The host
validates schemas before route publication and validates payloads before
delivery. Use a toolchain-compatible version of the
[`jsonschema` crate](https://docs.rs/jsonschema/latest/jsonschema/) and compile
validators once per accepted artifact.

## Route contract

Each directed channel declares its message type, single owner, required
non-zero bounded capacity, and whether the core scheduler may send to it.
Directed senders wait for bounded capacity or observe cancellation; messages
are not silently dropped.

Each broadcast topic declares its message type and required non-zero retained
capacity. A lagging subscriber receives a structured lag diagnostic and then
continues from the oldest retained message, matching
[Tokio broadcast semantics](https://docs.rs/tokio/latest/tokio/sync/broadcast/).

There is no invented global capacity. Module contracts must state payload and
queue bounds, and preflight rejects missing or invalid values. Later evidence
may justify instance policy overrides, but it must not create implicit defaults.

## Delivery semantics

- A successful directed receipt means the payload was validated, authorized,
  and accepted by the active channel queue. It does not mean handler success.
- A publish receipt reports the route generation and subscriber count at
  publication. It does not imply every subscriber processed the event.
- Ordering is defined only within one directed channel. Cross-channel and
  cross-topic ordering is undefined.
- Messages are process-local and disappear on crash or restart.
- There is no replay, transaction spanning handlers, or exactly-once delivery.
- Handler failures are isolated and become current diagnostics, not new bus
  messages by default.

These semantics keep durable business operations in the existing operation
model while allowing transient runtime coordination to remain cheap.

## Authority and extensibility

Modules may provision new message types, channels, topics, and capability
ports. A module manifest declares what it provides, handles, publishes, and
subscribes to. The supervisor binds the actual module identity and grants;
module JavaScript cannot assert a different identity at call time.

Core-native resources remain fail-closed behind explicit grants. Installing a
schema does not grant terminal access, filesystem access, or authority to send
on an existing channel.

## Atomic route snapshots

The bus accepts a prepared registration set outside the active snapshot. After
validation passes, it publishes one new immutable route snapshot. Each
concurrent send or publish observes either the complete old snapshot or the
complete new snapshot. A route-generation conflict leaves the accepted snapshot
unchanged.

The bus exposes bridge and runtime lease observations for already active or
withdrawn registrations. Live module enable, replacement, disable, remove,
withdrawal-before-drain, and activation draining are Phase 4 module-control
acceptance in `shep-btu.10`; they are not message-bus lifecycle operations.
