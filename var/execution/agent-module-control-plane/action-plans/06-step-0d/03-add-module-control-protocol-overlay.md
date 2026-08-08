# 0D.3 Add the module-control protocol overlay

## Outcome

The existing authenticated named-instance protocol has versioned `modules` and
`operations` command families with JSON request, response, event, and stream
completion frames that agents can consume without a second endpoint.

## Dependencies

- 0D.2 canonical module contracts.

## Production change

Extend the local IPC protocol and `shipctl` parser with module inspection,
diagnostic, lifecycle, and operation-status families while keeping parsing and
TOON/JSON rendering at the CLI boundary. Use canonical JSON frames on the
wire. Represent lifecycle outcomes, including enable/disable and
restart-required native changes, in fixture responses for this transport slice;
registry reconciliation and loader behavior remain later-phase work. New
Rust/Tauri registration is restart/release-bound and must be represented by an
explicit diagnostic rather than a live-loading promise.
Keep the Rust core generic and slow-changing; TypeScript module artifacts own
behavior, contributions, configuration, and diagnostics through stable core
APIs. A new native API requires a core release/restart.

## Diagnostic/observability

Return operation IDs, target and applied revisions, lifecycle transitions,
schema/protocol versions, stable diagnostic codes, redacted evidence, and
stream completion status. Distinguish unsupported runtime kinds, stale
revisions, failed transitions, and restart-required native changes.

## Mechanism integration test

Feed versioned module and operation request/response/event fixtures through the
real protocol encoder/decoder and `shipctl` renderer; consume complete JSON
frames and stream completions, compare JSON with CLI presentation, and assert
that enable/disable and restart-required outcomes are transported as data only.

## Acceptance evidence

- One authenticated local endpoint serves instance and module control.
- Frame schema and ordering are deterministic and versioned.
- Module operations are addressable and diagnostics are actionable.
- Fixture responses carry enable/disable outcomes without invoking registry
  reconciliation or Cargo-feature/Tauri/Rust recompilation.
- Fixture responses carry explicit restart/release-bound diagnostics for native
  Rust additions.

## Non-goals

- A TCP/REST service or second control endpoint.
- Registry storage or loader implementation.
- Remote-machine control.
- UI-only lifecycle dispatch.
