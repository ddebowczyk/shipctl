# Project capability data rail

Date: 2026-08-07

Task: `shep-3w1.8.4.2.1`

## Outcome

The module API now exposes a generic `projectData` service. A module can read
or replace one top-level project value by project path and capability ID
without importing the host workspace type or filesystem implementation.

This is the persistence boundary needed by Commands. It is deliberately not a
Commands API and does not add a Commands native plugin.

## Contract

`ModuleProjectDataPort` provides two asynchronous operations:

- `read(projectPath, capabilityId)` returns the capability-owned value; and
- `replace(projectPath, capabilityId, value)` replaces only that value.

The host rejects an empty ID and the host-owned `name` field. Existing
compatibility IDs such as `commands` and `assistants` remain valid while those
capabilities move out of the typed workspace aggregate.

## Persistence behavior

`createProjectCapabilityDataPort` implements read-modify-write over the current
workspace document. It has four important properties:

1. Host fields, sibling capability values, and unknown values are copied into
   every replacement document.
2. Writes to the same project are serialized, so a later write reloads the
   result of the earlier write instead of overwriting it from a stale snapshot.
3. A failed write does not publish the candidate document and does not poison
   the queue for the next write.
4. A successful write updates `useRepoStore.activeConfig` when that project is
   active, preserving compatibility with capabilities still using the
   aggregate during migration.

Different projects retain independent queues. The existing Tauri load and save
commands remain the filesystem boundary.

## Human-editable YAML compatibility

Rust `WorkspaceConfig` now flattens unknown top-level YAML values into
`capability_data`. The TypeScript workspace document has the equivalent open
shape. A load and save therefore preserves values owned by modules that the
host does not understand.

The existing top-level `name`, `commands`, and `assistants` layout remains
unchanged. No migration or rewrite is imposed on current
`.shep/workspace.yml` files.

## Dependency cleanup

`moduleHostServices.ts` now owns the project-data adapter and updates the repo
store after successful writes. Related-project discovery receives the host
services from `AppShell` instead of importing the concrete service singleton
inside `useRepoStore`; the store depends only on the module API type.

## Verification evidence

```sh
pnpm test:project-data
pnpm test:commands-characterization
pnpm test:module-composition
pnpm test:project-surfaces
pnpm test:git-characterization
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

Focused tests cover sibling and unknown value preservation, same-project write
ordering, failure recovery, publication after success, and reserved-key
validation. Rust tests cover unknown YAML round trips.
