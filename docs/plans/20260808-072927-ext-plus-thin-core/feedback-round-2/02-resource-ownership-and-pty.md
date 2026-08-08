# Resource ownership and PTY continuity

## Why live reconciliation is the v1 fix

The round 1 failure chain is present in the current implementation:

- [`spawn_pty`](../../../../core/backend/src/terminal/commands.rs) receives a
  webview-created `Channel<PtyOutput>` and passes it into the session at spawn;
- [`PtyManager`](../../../../core/backend/src/terminal/manager.rs) exposes spawn,
  write, acknowledge, resize, theme, kill, and count, but no list or attach;
- [`usePty`](../../../../core/frontend/terminal/usePty.ts) holds host session
  identity in module-level maps;
- a failed channel send stops the output coalescer in
  [`session.rs`](../../../../core/backend/src/terminal/session.rs).

A reload is therefore not a harmless activation technique. The native process
may remain while its frontend identity and output path disappear.

The first usable lifecycle should leave the webview, `usePty`, xterm instances,
and the Tauri channel intact. Only the affected extension instance and the
catalog snapshot change. That directly preserves the terminal performing the
operation and is less machinery than making every current PTY reload-safe first.

## Instance-scoped ownership

Every activation creates a unique `ModuleInstanceId`, for example
`assistants@<digest>#<activation>`. The host creates `ModuleHostServices` for
that instance; module code cannot supply or impersonate the identity.

The instance owns an `ActivationScope` containing all handles created through
host services:

- contribution registrations and loaded CSS;
- event and store subscriptions;
- scheduled tasks and timers;
- native channels and listeners;
- leases on host-owned resources.

Registration APIs return handles into this scope. Disposal closes handles in
reverse acquisition order and is idempotent. Existing module-level cleanup is a
useful starting point, but it must become per-instance: the current
[`activateModules`](../../../../core/frontend/host/moduleComposition.ts) tracks
scheduled-task cancellation and a module deactivation callback without an
instance identity or drain state.

## Leases separate unpublish from destruction

Host-owned resources can outlive the module version that created them. A lease
binds each resource to its exact owner instance and prevents that instance and
artifact from being destroyed while the resource still needs its callbacks.

For terminal sessions:

1. `terminalSessions.launch` stamps the active `ModuleInstanceId` onto the
   host's session record and acquires an owner lease.
2. Update or disable removes the old instance from public contributions and
   new-session routing immediately.
3. Existing PTY output continues through the unchanged host channel and xterm
   path.
4. Rename, placement, stop, and lifecycle actions route to the exact owner
   instance, not to every subscriber.
5. PTY exit or explicit transfer releases the lease. The draining instance can
   then dispose and its artifact can become garbage-collection eligible.

This requires replacing the global listener broadcast in
[`terminalSessions.ts`](../../../../core/frontend/terminal/terminalSessions.ts)
with an owner router keyed by `ModuleInstanceId`. The current assistants runtime
filters broadcast events by owner-key prefix and clears all module-level maps on
deactivation. Under live updates, version B must not receive version A's owner
actions, and deactivating A must not erase B's state.

## Update example

```text
assistants A active; terminal T leased to A
  -> prepare assistants B in a private activation scope
  -> atomically route new panels and launches to B
  -> A enters draining; T and its owner callbacks remain with A
  -> T remains interactive through the host PTY path
  -> T exits or ownership transfers
  -> release A's final lease and dispose A
```

The same rule applies to long-running jobs, watchers, streams, and background
tasks. New resource types need an owner adapter defining acquire, route,
transfer if supported, release, and force-close policy. A resource without that
contract cannot be claimed as live-disable or live-remove capable.

## Disable and remove

Disable and remove are two-stage operations:

- **Logical completion:** remove contributions and new-work routing at the
  committed catalog revision. The user and agent no longer see or start the
  capability.
- **Physical completion:** dispose old instances and delete unreferenced
  artifacts after their leases reach zero.

Status must distinguish `applied` from `draining` and enumerate the remaining
resource identities. The system must not kill an agent's PTY merely to make
module removal look synchronous.

If a resource has neither a safe drain path nor an explicit transfer contract,
preflight returns `restart-required` before desired state changes. This is the
tripwire that prevents an unmodelled resource from becoming a mission-ending
cleanup call.

## Reattachment is a separate resilience track

Live reconciliation protects planned module lifecycle operations. It does not
protect against an arbitrary webview crash, manual refresh, or update of the
stable shell. Reload-safe PTY recovery is still valuable, but a real design
needs more than `list` and `attach` commands:

- a host-owned output multiplexer rather than one spawn-time channel;
- sequenced output retained until attachment policy permits release;
- per-attachment cursors and acknowledgement state;
- durable session metadata sufficient to rebuild frontend tabs;
- explicit behavior for overflow, stale attachments, exit, and ownership.

That work should follow the live v1 critical path unless the product separately
promises crash-transparent terminal recovery. Adding only discovery and a new
channel would risk silent output loss and duplicate or misordered terminal data.
