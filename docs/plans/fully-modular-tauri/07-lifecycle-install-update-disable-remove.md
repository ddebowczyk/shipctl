# Lifecycle and package operations

## State machine

```text
discovered
  → verifying
  → verified
  → installing
  → installed
  → activating
  → active
  → deactivating
  → disabled
  → uninstalling
  → removed
```

Failure and quarantine states must be explicit. An extension can be installed
but incompatible, enabled but activation-failed, or disabled with data retained.

## Installation

1. Download or select a package into an operation-specific staging directory.
2. Validate archive safety and manifest schema.
3. Verify publisher signature, content digest, package identity, and revocation
   policy.
4. Check platform, architecture, host API, runtime, and protocol compatibility.
5. Present new or changed permissions for approval.
6. Extract and verify every declared file.
7. Atomically publish the immutable version directory.
8. Commit the installed-version registry record.
9. Activate only when policy permits.

An interrupted operation leaves either the previous state or an unreferenced
staging directory that can be cleaned safely.

## Activation

1. Resolve the active immutable package version.
2. Reconfirm compatibility and current permission grants.
3. Create an extension instance and scoped capability context.
4. Start the process or instantiate the WASM component.
5. Complete a bounded handshake and health check.
6. Register contributions through instance-owned handles.
7. Begin data subscriptions only after registration succeeds.
8. Commit the active lifecycle state.

If any step fails, the manager disposes every registration and runtime resource
created by preceding steps.

## Disable and deactivate

1. Mark the extension as deactivating and reject new operations.
2. Cancel or drain active work according to operation policy.
3. Stop extension-owned streams and subscriptions.
4. Remove UI and command registrations.
5. Request graceful runtime shutdown.
6. Wait for a bounded timeout.
7. Force-terminate a remaining process or drop the WASM instance.
8. Release protocol mounts and resource leases.
9. Persist the disabled state.

Disable preserves package versions, settings, permission history, and extension
data. The base application remains usable when deactivation is incomplete.

## Upgrade

Install the new version beside the current version. Validate and migrate before
switching the active-version pointer. The old package remains available until
the new version has passed activation and a defined stability window.

Data migrations need one of these policies:

- backward-compatible migration that permits binary rollback;
- snapshot-and-restore rollback;
- explicitly irreversible migration requiring user confirmation.

Extension code must never mutate another extension's data during migration.

## Removal

Removal first performs complete deactivation, then removes immutable package
versions and registry references. The user or policy chooses separately whether
to:

- preserve extension data for later reinstallation;
- export it;
- purge persistent data and cache.

After removal there must be no live process, WASM instance, event listener,
command, panel, resource mount, scheduled task, or active permission grant for
that extension instance.

## Crash and hang handling

The supervisor records abnormal exits, traps, failed health checks, and protocol
timeouts. Restart policy must be bounded. Repeated failure transitions the
extension to quarantined or activation-failed rather than creating a crash loop.
