# Runtime message bus

## Goal

Give every named Shipctl instance an in-memory, inspectable message fabric for
coordination between the host and capability modules. Modules can add new
typed channels and topics without adding Rust commands or rebuilding the host.

The bus is a foundation used by live module reconciliation. It is not an event
store, RPC framework, terminal transport, or cross-process broker.

## Required outcomes

- One `RuntimeMessageBus` is owned by each running instance.
- Modules declare typed channels, topics, handlers, and subscriptions.
- Prepared registrations publish through a complete immutable route snapshot.
- The bus detects route-generation conflicts without exposing a mixed
  snapshot.
- Live module enable, replace, disable, and remove are module-control
  operations; Phase 4 owns their reconciliation with bus routes.
- Rust validates every message at the trust boundary and enforces grants.
- Module code uses `@shipctl/module-api`; it never imports Tauri directly.
- Agents can inspect contracts, routes, health, and delivery diagnostics without
  exposing payload history.
- Delivery does not write messages or routine events to SQLite or other files.
- The same compiled host proves route changes; no source copy or rebuild is
  part of runtime verification.

## Documents

1. [Contracts and semantics](./01-contracts-and-semantics.md)
2. [Rust runtime](./02-rust-runtime.md)
3. [Frontend and module API](./03-frontend-and-module-api.md)
4. [Inspection and verification](./04-inspection-and-verification.md)
5. [Execution order](./05-execution-order.md)

## Boundary decisions

- Directed commands use Tokio `mpsc`; request results use `oneshot`.
- Broadcast notifications use Tokio `broadcast`.
- Current route and configuration snapshots use Tokio `watch`.
- Tauri commands and `Channel`s are the conventional Rust-to-webview bridge.
  The bus adds only module-domain routing, ownership, and validation above that
  transport; it is not a competing renderer IPC stack. Small shell/UI lifecycle
  notifications may still use ordinary Tauri events.
- PTY bytes remain on dedicated streaming channels. The bus carries only
  lifecycle, availability, and control messages about terminals.
- Generic request/response capability APIs remain explicit ports. They are not
  disguised as pub/sub.
- No external broker, persisted event journal, automatic replay, or
  exactly-once claim is introduced.

These choices follow the documented semantics of
[Tokio synchronization primitives](https://docs.rs/tokio/latest/tokio/sync/)
and Tauri's IPC conventions: commands for narrow host calls, channels for
ordered bridge delivery, and events for lightweight UI notification. The
domain bus is needed only for dynamic capability routes, schema/version
validation, grants, activation ownership, and inspection—facts that Tauri
transport cannot infer. Tauri recommends channels for ordered streaming data
in its [IPC guidance](https://v2.tauri.app/develop/calling-frontend/).

## Relationship to the module-control plan

This work supplies the message-contract and route-snapshot foundation used by
Phase 3 and Phase 4. The bus owns immutable registrations, route publication,
route-generation conflict containment, and bridge/runtime lease observation.
`shep-btu.10` Phase 4 owns live module enable, replacement, disable, remove,
withdrawal-before-drain, and supervisor reconciliation. `shep-btu.11` Phase 5
owns the public generic lifecycle matrix. Phase 6 migrates existing modules
away from direct Tauri listeners and browser timers.

The scheduler plan depends on the accepted message contracts and Rust runtime.
It does not create a parallel delivery mechanism.
