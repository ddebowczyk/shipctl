# Phase 4 — live runtime supervisor

## Outcome

Replace static frontend composition for the fixture module with revision-driven
live activation. Version B prepares beside A, one immutable catalog snapshot
switches public behavior, and failure preserves the last good instance without
reloading the webview.

## Work package 4.1 — observed-state supervisor

Add a stable `ModuleSupervisor` under `core/frontend/host/`. It:

- reads a complete desired snapshot at startup;
- treats registry notifications as wake-up hints;
- rereads the snapshot after a revision gap;
- collapses superseded pending revisions without skipping committed truth;
- owns module instances and reports observed results to the registry; and
- never asks the shell to reload for a supported lifecycle operation.

The supervisor's observable state is exposed through `useSyncExternalStore`.
Do not synchronize derived registry state with React effects.

## Work package 4.2 — declarative module instances and host ownership

Every artifact exports a declarative module descriptor: contribution ids and
kinds, component references, requested capabilities, configuration schema, and
resource intents. The host validates that descriptor, creates an identity such
as `fixture@<digest>#<activation-id>`, and owns:

- staged and published contributions;
- loaded styles;
- React mounting and unmounting;
- subscriptions, tasks, and timers created through host ports;
- native channel and listener handles; and
- leases for host-owned long-lived resources.

Modules do not return a catch-all live runtime object. React owns component
cleanup, while the host tracks only handles created through its mediated ports
and resource adapters. Handle disposal is idempotent, and cleanup failures are
secondary diagnostics that may not mask the original load failure.

## Work package 4.3 — atomic catalog snapshot

Replace piecemeal mutable host registry reads with one immutable
`CatalogSnapshot` containing panels, surfaces, navigation, commands, settings,
providers, schedules, and active-instance routing.

Activation follows one transaction:

1. validate and import B from its digest-qualified URL;
2. validate B's descriptor into a private host-owned catalog;
3. build and validate the complete next snapshot;
4. publish that snapshot once;
5. route new work to B; and
6. mark A draining, then dispose it when leases reach zero.

Any failure before publication disposes staging B and leaves A and the prior
snapshot untouched.

## Work package 4.4 — fixture runtime proof

Make `modules/fixture` the first real runtime-loaded module. Its artifacts
export deterministic version and evaluation markers plus a declarative
descriptor, contribute more than one catalog kind, request disposable handles
through host ports, and support an injected descriptor failure.

Add the public declarative primitive:

```text
shipctl modules apply --file <desired-modules.json>
```

It validates and commits one complete desired snapshot and returns its operation
and revision. Phase 5 builds ergonomic lifecycle commands on this same service;
`apply` is not a test-only switch.

Use registry revisions and the local CLI to drive A, B, rollback to A, and
invalid C. A private frontend test switch is not acceptable as the phase proof.

## Diagnostic and verification mechanism

The supervisor reports every transition with module id, digest, instance id,
desired revision, observed revision, phase, duration, and result. Inspection
also reports contributions by owner, active handles by kind, leases, and
cleanup failures.

Add a runtime consistency diagnostic that checks:

- every published contribution has one live owner;
- active-instance routing names the same owner as the snapshot;
- no staging contribution is public;
- desired and observed digest/revision relationships are valid; and
- disposed instances retain no unleased handles.

Integration tests assert through `shipctl modules inspect`, `diagnose`, and
`verify --output json` while the real frontend host is running.

## Exit proof

- A becomes observed active at its committed revision.
- B's evaluated runtime marker and digest become public in one snapshot.
- No observation contains a mixed A/B catalog.
- Invalid C leaves B public, produces the failing phase, and leaks no handles.
- Rollback evaluates immutable A and creates a new instance identity.
- Repeated lifecycle cases return unleased handle inventories to the measured
  baseline after every case.
- The webview identity and an independent host-owned terminal remain unchanged.
- Existing repository gates remain green.

## Primary implementation areas

- `core/frontend/host/` for supervisor, snapshots, mounting, ownership, and reporting;
- `core/frontend/shell/AppShell.tsx` for reactive snapshot consumption;
- `modules/api/frontend/` for declarative contribution and host-port contracts;
- `modules/fixture/` for deterministic runtime artifacts; and
- `ops/module-control/` for live-host integration tests.
