# Connect the live registry to the named-instance endpoint

## Outcome

The existing owner-only named-instance socket serves real registry-backed
module inspection and diagnostics. The protocol performs an explicit hello,
records caller metadata, and rejects lifecycle mutation during Phase 2.

## Dependencies

- Step 0 named-instance discovery and authenticated local socket.
- Phase 1 per-instance module registry.

## Production change

Add the smallest generic module-control service above `ModuleRegistry`. Attach
it to `TauriControlHandler`; do not add TCP, REST, a second registry, or module
behavior to Rust. Add instance diagnose and module-control status to the Clap
CLI and versioned local frames.

## Diagnostic/observability

Report descriptor, endpoint, hello/protocol/build, registry revision and
integrity, observed snapshot availability, and revision lag with stable codes.

## Mechanism-level integration test

Exercise the real socket with an isolated registry. Prove inspect/diagnose join
durable facts, unsupported mutation is structured, and request/event/completion
framing remains ordered.

## Acceptance evidence

- The production Tauri handler answers registry-backed module commands.
- Instance diagnosis distinguishes transport, registry, snapshot, and lag.
- Lifecycle commands return `module.control.mutation_unavailable`.
- No TCP listener or build-time module toggle is introduced.

## Non-goals

- Runtime reconciliation, artifact installation, or live enable/disable.
