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

## Work package 4.2 — activation scope and ownership

Every activation receives a host-created identity such as
`fixture@<digest>#<activation-id>` and a fresh `ActivationScope`. The scope owns:

- staged and published contributions;
- loaded styles;
- event and store subscriptions;
- scheduled tasks and timers;
- native channel/listener handles; and
- leases for host-owned long-lived resources.

Handle registration is immediate, disposal is reverse-order and idempotent,
and cleanup failures are secondary diagnostics. They may not mask the original
activation failure.

## Work package 4.3 — atomic catalog snapshot

Replace piecemeal mutable host registry reads with one immutable
`CatalogSnapshot` containing panels, surfaces, navigation, commands, settings,
providers, schedules, and active-instance routing.

Activation follows one transaction:

1. validate and import B from its digest-qualified URL;
2. activate B into private staging registries;
3. build and validate the complete next snapshot;
4. publish that snapshot once;
5. route new work to B; and
6. mark A draining, then dispose it when leases reach zero.

Any failure before publication disposes staging B and leaves A and the prior
snapshot untouched.

## Work package 4.4 — fixture runtime proof

Make `modules/fixture` the first real runtime-loaded module. Its artifacts
export deterministic version and activation markers, contribute more than one
catalog kind, acquire disposable handles, and support an injected activation
failure.

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

- `core/frontend/host/` for supervisor, snapshot, scope, and reporting;
- `core/frontend/shell/AppShell.tsx` for reactive snapshot consumption;
- `modules/api/frontend/` for activation and ownership contracts;
- `modules/fixture/` for deterministic runtime artifacts; and
- `ops/module-control/` for live-host integration tests.
