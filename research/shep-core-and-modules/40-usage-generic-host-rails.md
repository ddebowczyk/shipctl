# Usage generic host rails

Date: 2026-08-07

## Outcome

Usage startup behavior and sidebar placement now pass through capability-neutral
module contracts while the implementation remains in its original host files.
This is an adapter stage: it changes composition and ownership seams without
moving provider, state, UI, or native implementation yet.

The host now supplies:

- ordered, lazy sidebar contributions;
- the existing ordered settings-section contribution rail;
- module-owned startup, delayed, and periodic tasks with teardown;
- namespaced opaque global capability data in human-editable
  `~/.shep/config.yml`.

No generic contract contains a Usage provider name, quota DTO, usage store, or
provider-specific command. The temporary `usageHostAdapter` is the only bridge
from module composition to the current Usage implementation.

## Preserved behavior

The adapter preserves the characterized lifecycle:

1. load Usage settings and snapshots during activation;
2. request provider and local-data refresh during activation;
3. fetch snapshots again after three seconds;
4. refresh and fetch once per minute;
5. fetch when native ingestion emits `usage-ingest-complete`;
6. remove the event listener and scheduled work on module deactivation.

The utilization widget remains in the same sidebar position. Disabling Usage
removes both its sidebar contribution and lifecycle work from the frontend
composition profile without adding a feature-specific branch to `Sidebar` or
`AppShell`.

## Contract details

### Sidebar

Each contribution carries a stable ID, owning module ID, optional order, and a
lazy component loader. Composition rejects an ownership mismatch, sorts by
order, and returns no contributions for a disabled profile. Rendering uses the
same suspense and error boundary as other module surfaces.

### Scheduling

A module can register startup, one-shot delayed, and periodic tasks. Task
execution is asynchronous and failure-isolated. Deactivation cancels timers in
reverse registration order and then deactivates modules in reverse activation
order. Partial scheduler registration is rolled back if a later task cannot be
registered.

This is lifecycle scheduling, not a general event bus. Inter-module state flow
needs a typed query-and-subscribe contract tied to a concrete consumer; that
design is tracked separately by `shep-3w1.8.8`.

### Global capability data

`ModuleGlobalDataPort` exposes only `read(capabilityId)` and
`replace(capabilityId, value)`. The frontend serializes operations and recovers
after a failed write. Rust stores unknown capability-owned top-level YAML keys
through a flattened map and rejects empty IDs or keys already owned by the host
schema.

Usage still uses its typed host `usage:` settings in this adapter stage. Moving
those settings behind the opaque port belongs to the frontend extraction and
compatibility-removal slices.

## Risk filed for follow-up

The native global config setters perform read and write under separate lock
scopes. Two concurrent callers can read the same config and then overwrite one
another's changes. Frontend serialization protects calls through one module
port but cannot coordinate a simultaneous host settings write.

This is not a reason to abandon the module boundary, but it is a correctness
prerequisite before typed Usage ownership is removed. Bead
`shep-3w1.8.6.2.5` requires one atomic global-config mutation boundary and a
deterministic lost-update test; it blocks the compatibility-removal slice.

## Verification contract

The focused checks are:

```sh
pnpm test:module-composition
pnpm test:project-data
pnpm test:usage-characterization
pnpm build
VITE_SHEP_USAGE_MODULE=disabled pnpm build
pnpm build:module-fixture
```

Rust tests additionally verify unknown top-level YAML preservation and
rejection of host-owned keys. The full enabled profile and Usage-disabled
profile must both compile before this migration slice closes.
