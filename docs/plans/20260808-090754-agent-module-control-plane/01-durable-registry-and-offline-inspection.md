# Phase 1 — durable registry and offline inspection

## Outcome

Create one crash-safe source of installed and desired module truth. Agents can
inspect and verify that truth even when no Shipctl webview is running. Runtime
observation remains explicitly unavailable until Phase 2.

## Work package 1.1 — transactional registry

Add a `ModuleRegistry` service in `core/backend` backed by a dedicated SQLite
database under the injected module state root. Its transaction boundary owns:

- immutable artifact records and provenance;
- desired module selections and configuration revisions;
- one monotonically increasing registry revision;
- idempotent operation requests and transition history; and
- last reported observations by instance and revision.

Do not put module desired state into frontend stores or ask the CLI to edit the
database. Store access stays behind a repository interface so corruption and
recovery behavior can be tested without Tauri.

Database initialization and schema migration are atomic. A failed migration
must preserve the previous readable schema and return a diagnostic rather than
creating a partially upgraded registry.

## Work package 1.2 — inventory bundled modules honestly

Seed the registry from the current manifests, build features, and static
composition inventory. Mark each current feature as `static-builtin` with its
actual build provenance and restart-bound lifecycle; do not claim that it is a
live-loadable artifact before Phase 6 migrates it.

At this phase, seeding records inspection metadata only. Existing static
composition still runs the application until each module enters the supervisor.
Phase 6 replaces each static inventory entry with a bundled immutable artifact
of the same module id and removes its composition special case.

Each source is explicit:

- `bundled`: shipped with this Shipctl build;
- `user`: installed into the user artifact store;
- `development`: produced by the Phase 7 watcher.

Source affects trust and replacement policy, never identity. Artifact identity
includes the content digest; a static build record uses the Shipctl build
identity until an artifact digest exists.

## Work package 1.3 — offline CLI read surface

Deliver the first agent-facing commands:

```text
shipctl modules list --offline
shipctl modules inspect <module-id> --offline
shipctl modules diagnose [<module-id>] --offline
shipctl modules verify <module-id> --expect <expectation.json> --offline
```

The CLI reads through the registry service in read-only offline mode. It emits
TOON by default and JSON with `--output json`. Successful structured data goes
to stdout; structured errors go to stderr. Commands never prompt.

`inspect` is factual and side-effect free. `diagnose` runs explicit checks.
`verify` compares facts to caller-supplied expectations and exits non-zero when
they do not match.

The offline response must say `runtimeAvailable: false`. It must never infer an
active runtime from desired state or stale observations.

## Diagnostic and verification mechanism

Offline diagnostics cover:

- database schema and integrity;
- registry revision continuity;
- artifact record and provenance completeness;
- desired references that point to missing digests;
- operation-journal consistency; and
- unavailable runtime observation as information, not a false failure.

Provide a read-model fixture generator. Integration tests create a registry,
commit revisions, crash at transaction tripwires, reopen it, and make assertions
through the compiled CLI's JSON output.

## Exit proof

- Reopening the same isolated root returns the same revision and records.
- An interrupted write exposes either the old or new complete revision, never a
  mixture.
- Replaying a request id returns its existing operation and does not create a
  second revision.
- A bad schema migration preserves the last valid readable state.
- `inspect`, `diagnose`, and `verify` distinguish desired, last observed, and
  unavailable live state.
- Golden CLI outputs validate against the Step 0D module contracts.
- Existing repository gates remain green.

## Primary implementation areas

- `core/backend/src/module_control/` for service, repository, and read model;
- `src-tauri/src/main.rs` for thin app-versus-CLI dispatch;
- `src-tauri/src/` for CLI adapter and rendering; and
- `ops/module-control/` for isolated registry and compiled-binary tests.
