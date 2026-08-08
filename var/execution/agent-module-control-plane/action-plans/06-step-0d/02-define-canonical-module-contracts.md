# 0D.2 Define canonical module contracts

## Outcome

Versioned Rust-domain contracts round-trip through canonical JSON for module
identity, desired/observed state, operations, diagnostics, resource leases,
inspection, and verification results before storage or UI protocol code exists.

## Dependencies

- 0D.1 injected module-control paths.

## Production change

Define serializable contracts and schema fixtures for `ModuleIdentity`,
`DesiredModuleState`, `ObservedModuleState`, `ModuleOperation`, `Diagnostic`,
`ResourceLease`, `ModuleInspection`, `VerificationExpectation`, and
`VerificationResult`. Keep UI stores, Tauri command names, and database rows out
of the public model. Desired enable/disable state must be representable without
Cargo feature changes or Rust recompilation. Disabling retains a selected
installed artifact when present, so re-enabling is a data-only transition;
newly added native Rust/Tauri
behavior remains restart/release-bound. Keep the Rust core generic and
slow-changing; TypeScript module artifacts own behavior, contributions,
configuration, and diagnostics through stable core APIs. A new native API
requires a core release/restart.

## Diagnostic/observability

Add stable hierarchical diagnostic codes, schema versions, redacted evidence,
and golden fixtures for valid and contract-level failure cases. Ensure unknown
fields, invalid versions, malformed diagnostics, and secret leakage produce
machine-readable failures.

## Mechanism integration test

Round-trip the fixtures through Rust JSON serialization and the checked or
generated TypeScript shapes, then run invalid-version, unknown-field, redaction,
and malformed-diagnostic cases through the contract runner.

## Acceptance evidence

- Rust and TypeScript validate the same versioned fixture shapes.
- Stable codes and evidence fields survive round-trip.
- Per-instance desired enable/disable state is representable as versioned data
  without Cargo-feature or Rust recompilation.
- Native Rust additions are explicitly classified restart/release-bound.
- Contract output identifies fixture, schema, expectation, observation, and paths.

## Non-goals

- Registry persistence or module lifecycle implementation.
- Tauri command naming or CLI rendering.
- Live ESM loader implementation.
- Accepting unsupported worker/WASM kinds.
