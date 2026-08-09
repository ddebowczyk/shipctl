# Execution order

## M1 — freeze contracts

Implement identifiers, envelopes, contracts, receipts, diagnostics, schemas,
and shared Rust/TypeScript goldens. Prove strict validation and no secret
leakage before introducing routing.

**Exit:** both languages consume the same fixtures and every invalid fixture
returns its specified stable code.

## M2 — build the instance runtime

Implement route snapshots, bounded Tokio primitives, registrations, grants,
delivery receipts, cancellation, and in-memory observations. Integrate the
service into `InstanceContext` ownership without exposing Tauri commands yet.

**Exit:** Rust runtime tests prove delivery, isolation, backpressure, failure
containment, and atomic route replacement with no persistent writes.

## M3 — add the Tauri bridge and module API

Implement the platform transport, ordered webview channel, activation-scoped
module facade, and declarative handlers. Wire construction only in
`src-tauri/src/lib.rs`.

**Exit:** a frontend fixture receives directed and broadcast messages through
the packaged bridge, and bridge reconnection does not replace backend routes.

## M4 — prove immutable route snapshots

Prove immutable route snapshots, route-generation conflict containment, and
bridge/runtime lease observations for already active registrations. The bus
must not expose a mixed route snapshot while a prepared route generation is
accepted or rejected.

**Exit:** focused route and bridge tests prove coherent snapshots, unchanged
accepted state after a generation conflict, and inspectable lease observations
without public module mutation.

Live module enable, replacement, disable, remove, activation draining, and the
A/B/C lifecycle acceptance are Phase 4 module-control work in `shep-btu.10`.

## M5 — expose inspection and migrate callers

Add control-protocol and CLI inspection, runtime snapshot integration, and
focused `just` verification. Migrate existing direct Tauri event listeners that
represent module communication. Do not move PTY bytes onto the bus.

**Exit:** CLI evidence explains every active route and grant, two instances are
isolated, and the full application passes without event persistence or rebuild.

### M5c — prove the packaged bus-only workflow

The packaged message-bus gate proves runtime delivery, authorization, bounded
behavior, bridge lifecycle, inspection, diagnosis, named-instance isolation,
and unchanged host-binary and durable-state digests. It exercises only active
fixture registrations, not add/replace/disable/re-enable/remove lifecycle
operations. The A/B/C packaged lifecycle matrix is Phase 4 and Phase 5
module-control acceptance in `shep-btu.10` and `shep-btu.11`.

## Dependency for scheduler work

Scheduler contract work may begin after M1. Scheduler runtime work begins after
M2 and targets only endpoints explicitly marked as scheduler-allowed. Its live
module-delivery proof depends on the Phase 4 provider runtime in `shep-btu.10`
and the relevant Phase 5 lifecycle surface, not on M4 or M5c.
