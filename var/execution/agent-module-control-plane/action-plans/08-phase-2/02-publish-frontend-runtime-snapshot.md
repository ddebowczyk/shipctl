# Publish the frontend runtime snapshot

## Outcome

The frontend host publishes the modules and contributions it actually composed;
online inspection joins that observation with authoritative registry identity,
digest, instance, and revision facts.

## Dependencies

- Live registry control service.
- Existing frontend module composition and Tauri IPC boundary.

## Production change

Add a host-owned TypeScript snapshot builder and one narrow Tauri command. Rust
validates and enriches frontend-reported contribution facts from the static
inventory; frontend input cannot override identity, digest, grants, or owner.

## Diagnostic/observability

Report snapshot publication time/revision, active contribution IDs and kinds,
missing/stale snapshots, identity mismatches, and registry lag.

## Mechanism-level integration test

Use the actual static module profile to publish a snapshot, inspect it through
the local control service, and prove desired and observed revisions remain
separate. Invalid ownership and identity input must be rejected.

## Acceptance evidence

- Online inspection includes desired state, observed lifecycle, contributions,
  grants, leases, and provenance-aware diagnostics.
- A module cannot self-assert a different owner or artifact.
- Stopping the host leaves the registry readable and makes runtime unavailable.

## Non-goals

- Dynamic artifact activation or frontend contribution detach.
