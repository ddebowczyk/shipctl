# Step 0B — saved instance state specification

## Outcome

Let an agent save the restorable state of a running named instance to one file,
inspect and verify that file without starting a UI, and load it into a new named
instance with a different state root.

## Command contract

```text
shipctl state save --instance <name-or-id> --to <file>
shipctl state inspect <file>
shipctl state verify <file>
shipctl ui start --name <name> --state-root <path> --load-state <file>
```

Save is requested through the running instance so every provider can produce a
coherent view. Inspect and verify operate offline. Load completes before any
application manager or webview initializes, and the instance publishes ready
only after restore succeeds.

## Archive and provider contract

A saved state is a versioned `.shipctl-state` archive with a canonical
`manifest.json` and provider-owned payloads. It creates a new instance profile;
it does not preserve a runtime UUID or reconnect live resources.

Every durable state owner registers a snapshot provider and classifies each
owned entry as portable, reference-only, secret, or live-only. One provider may
emit more than one classification; for example, host configuration can contain
portable preferences and repository-path references. Save fails if a durable
source under the state root is unclassified. The manifest records every
included and excluded provider, schema version, entry classification, payload
digest, source build, source state fingerprint, and redaction decision.

Step 0 must round-trip all current portable instance-owned sources, including:

- host global configuration, registered repositories, groups, and settings;
- instance-owned UI persistence moved out of shared browser local storage;
- restorable assistant-session metadata; and
- usage storage through a coherent database snapshot, not copied live files.

Repository contents, repo-local workspace files, credentials, caches, process
ids, sockets, webview channels, and live PTYs are not copied. References and
live-resource exclusions are recorded so `state inspect` cannot imply a more
complete restore than occurred.

## Snapshot consistency and fingerprint

The running instance coordinates save across all providers. It enters a
durable-write barrier, asks every provider to prepare and capture its coherent
view, builds and verifies the archive, and releases the barrier. A provider
failure aborts the archive; an earlier provider result never becomes an
independently valid partial snapshot. Live resources may continue running, but
their durable metadata cannot advance through the barrier unnoticed.

The restorable-state fingerprint is computed from a canonically ordered set of
provider id, provider schema, entry classification, and verified payload
digest. It excludes runtime UUID, instance name, roots, endpoints, capture time,
source build provenance, and live-only or secret exclusions. Restore recomputes
the same fingerprint from the promoted provider state, which is why a new
instance can prove equivalent restorable state while retaining new runtime
identity and provenance.

## Restore safety

Loading validates the manifest, provider schemas, archive paths, and payload
digests before writing. Absolute paths, parent traversal, undeclared entries,
duplicate entries, and links outside a provider payload are rejected.

Restore is allowed only into a new or empty state root. The explicit launch
name and target root are authoritative; source identity is provenance only.
Payloads are first restored into a staging directory and promoted only after
all providers validate. Failure leaves no published instance and no partially
initialized target root.

## Required diagnostics

```text
state.snapshot.unclassified_source
state.snapshot.digest_mismatch
state.snapshot.incompatible_version
state.snapshot.unsafe_entry
state.restore.target_not_empty
state.restore.provider_failed
```

`state inspect` reports source provenance, state fingerprint, included and
excluded providers, payload digests, redaction decisions, and restorable versus
reference-only state. It never renders secret payload values.

## Live baseline carried into implementation

Current durable instance-owned state is split across `config.yml`, origin-wide
frontend local storage, `assistant-sessions.json`, and `usage.sqlite3`. The host
configuration mixes portable settings with registered-repository references;
the assistant manifest already uses atomic replacement; the usage store is a
live SQLite connection and therefore requires its backup API rather than file
copying. Provider credentials and assistant tool configuration under external
home directories are not Shipctl profile state and remain excluded as secrets
or external dependencies.

## Acceptance scenarios

1. Populate every current portable provider in a named isolated instance.
2. Save it through the public CLI and verify the archive offline.
3. Load it into a different empty root under a different name.
4. Prove equal restorable-state fingerprints and provider values.
5. Prove runtime UUID, name, root, endpoints, and live resources differ.
6. Corrupt each validated archive layer and prove restore publishes no instance
   and leaves no partial target profile.
