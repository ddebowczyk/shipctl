# Inject named-instance paths into durable owners

## Outcome

Every instance-owned durable source is derived from one validated instance
context, and two concurrently configured instances cannot accidentally share
the default profile state.

## Depends on

- Split CLI and UI executables.
- The Step 0A path and identity contract.
- The Step 0B durable-source inventory.

## Production change

Introduce an instance context and path service, inject it into host config,
workspace management, assistant continuity, usage storage, frontend-owned
preferences, and spawned PTY environments, and remove process-global path or
cache assumptions that cross instance boundaries.

## Diagnostic or observability change

Expose a redacted path/source inventory that reports the selected instance
name, UUID, state root, runtime root, each durable owner, and the derivation
source for every path.

## Mechanism-level integration test

Construct two real backend compositions with different state roots, write and
read every registered durable source, spawn an environment probe through the
PTY path, and prove that neither instance observes the other's files or
identity.

## Acceptance evidence

- Explicit, environment, and default roots follow the ratified precedence.
- State roots are created and canonicalized before publication.
- Config, UI preferences, assistant continuity, and usage data reside below
  the selected state root.
- Spawned terminal processes receive the exact instance UUID.
- No instance-owned durable path is hard-coded to the default profile.
- Isolation integration tests and relevant existing suites pass.

## Non-goals

- Moving repository-local workspace metadata into the instance profile.
- Copying external provider credentials or configuration.
- Adding module lifecycle behavior.
- Pushing commits to a remote.
