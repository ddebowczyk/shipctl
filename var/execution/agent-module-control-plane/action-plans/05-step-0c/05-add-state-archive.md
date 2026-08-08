# Add coherent instance state save and restore

## Outcome

An agent can save a coherent, inspectable instance-state archive and start a
new named instance from it without copying runtime identity, credentials, or
live processes.

## Depends on

- Injected instance paths and durable-source inventory.
- Authenticated local instance control.
- Named-instance agent CLI.

## Production change

Add coordinated snapshot providers for host configuration, UI preferences,
assistant continuity, and usage storage; define the archive manifest and
digests; save running instances through local control; and restore through
validated staging before normal startup.

## Diagnostic or observability change

Add offline archive inspect and verify commands, per-source inclusion and
classification records, cryptographic digests, capture provenance, and a
canonical restorable-state fingerprint that excludes new runtime identity.

## Mechanism-level integration test

Populate all durable providers in a running instance, mutate SQLite while
saving, inspect and verify the archive offline, restore into a new empty root,
start under a new name, and compare canonical fingerprints and source
accounting through public CLI operations.

## Acceptance evidence

- Save publishes no archive after any partial provider failure.
- Every known durable source is included or explicitly classified as excluded.
- SQLite capture is coherent while the source instance remains running.
- Restore rejects unsafe entries, digest failures, incompatible schemas, and
  non-empty targets without leaving partial state.
- Restored data has the same canonical fingerprint but a new runtime identity.
- Credentials, IPC artifacts, locks, PTYs, and repository contents are absent.

## Non-goals

- Secret migration.
- Archiving arbitrary repository content.
- Preserving process or socket identity.
- Pushing commits to a remote.
