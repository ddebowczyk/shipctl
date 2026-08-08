# Live reconciliation and agent control

## One authority, two adapters

Rust should own a durable `ModuleRegistry`. The settings UI reaches it through
Tauri commands; an agent reaches it through a local `shipctl modules` control
endpoint. Both are adapters over the same mutation and validation code. Neither
adapter edits enablement independently or tells the webview to reload.

The registry records:

- installed immutable artifacts, identified by module id, version, and content
  digest;
- desired active version and configuration for each module;
- one monotonically increasing revision for the complete desired state;
- reconciliation status and structured diagnostics for each revision.

The frontend owns observed runtime state because the module instances and React
surfaces live there. A `ModuleSupervisor` subscribes to change notifications and
reports the observed result to the registry. Notifications are wake-up hints:
on startup or after a revision gap, the supervisor reads the complete desired
snapshot rather than trying to reconstruct truth from events.

## Immutable artifacts solve the ESM cache problem

Do not overwrite `<id>/module.mjs`. Publish each successful build under an
immutable location such as:

```text
modules/<id>/versions/<content-digest>/module.mjs
```

The resolved import URL includes that digest. Version A, version B, and a
rollback to A therefore resolve to known identities; the host never depends on
cache invalidation or query-string folklore. The active-version record is a
small atomic pointer, while old artifacts remain available until no runtime
instance leases them.

This reuses the immutable-version property already described in the
[fully modular lifecycle](../../fully-modular-tauri/07-lifecycle-install-update-disable-remove.md).

## Reconciliation transaction

For a desired change from A to B, the supervisor performs this sequence:

1. Read the newest desired snapshot and collapse superseded work by revision.
2. Validate B's manifest, digest, API compatibility, contribution references,
   grants, and restart classification before changing public runtime state.
3. Import B from its digest-qualified URL and create a `ModuleInstance` with
   host-bound identity and a fresh activation scope.
4. Activate B against private staging registries. Host event delivery, scheduled
   work, and mutating native calls remain gated until commit.
5. Construct and validate one complete `CatalogSnapshot` containing the shell's
   panels, routes, navigation, commands, settings, providers, and active-instance
   routing.
6. Commit by publishing that snapshot once. New work now targets B. Mark A as
   draining and report B applied for the requested revision.
7. Dispose A when its leases reach zero, then release its CSS, listeners,
   schedules, subscriptions, and artifact reference.

If any step before commit fails, dispose B's staging scope, keep A and the prior
catalog snapshot untouched, and report the failed phase and cause. If cleanup of
B also fails, include that as a secondary diagnostic; it must not mask the
activation failure.

The immutable snapshot is preferable to adding piecemeal `unregister()` calls
to every registry. The current
[panel](../../../../core/frontend/host/panelRegistry.ts) and
[global-surface](../../../../core/frontend/host/globalSurfaceRegistry.ts)
registries are mutable maps, and
[`AppShell`](../../../../core/frontend/shell/AppShell.tsx) captures their lists
at module scope. One snapshot exposed through `useSyncExternalStore` gives React
an atomic revision and prevents mixed A/B UI states.

## Lifecycle semantics

<!-- markdownlint-disable MD013 -->

| Operation | Desired-state commit | Runtime result |
| --- | --- | --- |
| Install | Record a validated immutable artifact, disabled unless explicitly enabled. | No runtime change for a disabled artifact. |
| Enable | Select an installed version. | Prepare and atomically publish its instance. |
| Update | Select B while A remains observed active. | Prepare B beside A, swap routing, then drain A. |
| Disable | Select no active version. | Remove public contributions and new-work routing, then drain the old instance. |
| Remove | Remove the desired version and installation reference. | Same live unpublish and drain; delete files only after leases release. |
| Roll back | Select a retained immutable version A. | Run the same A-beside-B transaction; no special cache path. |

<!-- markdownlint-enable MD013 -->

An operation can be logically applied while an old instance is `draining`.
Status must say so and identify the owned resources preventing final disposal.
This is more truthful than blocking the entire change or silently killing those
resources.

## Agent-facing surface

The CLI should expose the registry's domain model, not UI gestures. A minimal
surface is:

```text
shipctl modules apply --file desired-modules.yaml --wait --json
shipctl modules status --revision <revision> --json
shipctl modules watch --after <revision> --jsonl
shipctl modules dev <source-path> --watch --wait --json
```

`apply` submits desired state and returns its revision. `--wait` observes that
same revision until it is applied, draining, rejected as restart-required, or
failed. Diagnostics include module id, artifact digest, operation, phase, and
cause in structured fields.

The local transport should authenticate as the current OS user and call the
same in-process registry service as Tauri. The concrete Unix-socket or named-pipe
adapter is platform glue, not a second source of lifecycle truth.

`dev --watch` owns source watching and compilation. It writes a new immutable
artifact and requests a desired-state update only after a successful build. The
desktop host remains a loader and reconciler; it does not embed a TypeScript
build system or execute half-written source trees.

## Restart preflight

The registry must classify a request before committing desired state. A change
to module code or declarative configuration is live when its instance obeys the
activation and ownership contracts. A change to Rust, registered Tauri plugins
or commands, CSP/import policy, or the static shell is restart-required.

`restart-required` is a structured preflight result, not a fallback that reloads
the webview after mutation. The active revision remains unchanged until the
caller explicitly chooses a restart path.
