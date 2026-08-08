# Add the transactional module registry core

## Outcome

`shipctl-core` owns a small, storage-independent `ModuleRegistry` that
persists one coherent per-instance registry revision in the injected
`module-registry.sqlite3` path and can be reopened without Tauri or a webview.

## Dependencies

- Step 0D's injected module-control paths and canonical Rust contracts.
- No live runtime, Tauri command, frontend store, or module loader.

## Production change

Add a generic registry service and repository boundary under
`core/backend/src/module_control/`. The SQLite implementation owns immutable
artifact/provenance records, per-instance desired selections and configuration
revisions, the monotonically increasing registry revision, idempotent request
records with transition history, and last-reported observations. Keep database
rows private; map through the Step 0D contracts/read models at the boundary.

Open writable registries with transactional schema initialization and
migrations. A migration updates the recorded schema version only in the same
transaction as its changes; an error rolls it back and leaves the last readable
schema available for diagnosis. A committed request either advances one whole
revision or leaves the prior revision unchanged; replaying its request ID
returns the original operation and never creates a second revision. Provide a
read-only open path that never creates, migrates, or mutates the database.

The registry accepts inventory and desired-state data but contains no module
behavior, contribution execution, Cargo-feature selection, or Tauri-specific
knowledge. Runtime toggles remain desired-state data; new Rust/Tauri APIs stay
restart/release-bound.

## Diagnostic/observability

Provide stable, redacted diagnostics for absent/unreadable registries, schema
version or migration failures, integrity failures, discontinuous revisions,
missing artifact references, and inconsistent operation journals. Read models
identify the resolved registry path and recorded revision without exposing
secrets or raw database internals.

## Mechanism-level integration test

Use isolated state roots to create a real SQLite registry, commit artifact,
desired-state, operation, and observation data, reopen it through the
repository boundary, and compare the same revision and records. Inject
deterministic failures at write and migration transaction tripwires, reopen
after each failure, and prove that the reader observes the old complete
revision or the new complete revision, never a mixture.

## Acceptance evidence

- The registry database is derived only from the injected instance path.
- Reopen preserves committed records and the exact registry revision.
- Duplicate request IDs return the original operation without advancing the
  revision.
- Failed writes and migrations leave a readable, coherent prior schema/state.
- Read-only opening performs no schema or data write.
- Core tests cover revision continuity, artifact-reference integrity, journal
  consistency, migration rollback, and transaction interruption.

## Non-goals

- Seeding the current bundled/static module inventory.
- Any `shipctl` parser or output rendering.
- Running-instance control, runtime reconciliation, or artifact execution.
- Cargo-feature changes or Rust rebuilds as enable/disable behavior.
