# Step 0A — named instance specification

## Outcome

Make a Shipctl process an agent-addressable product object before adding module
lifecycle behavior. An agent can start a named UI instance against an isolated
state root, prove it is ready, inspect it, and stop it without opening a webview
itself or guessing from a PID.

This is the first product capability in the plan. Later module tests must use
this public boundary rather than private test launchers.

## Executable contract

Shipctl ships two executables with distinct responsibilities:

| Executable | Responsibility |
| --- | --- |
| `shipctl` | Non-interactive, agent-facing control CLI; never hosts a webview |
| `shipctl-ui` | Tauri application and actual UI process |

`shipctl ui` resolves and launches the packaged `shipctl-ui` belonging to the
same installation. It does not depend on an unrelated executable found first
on `PATH`.

The initial public command surface is:

```text
shipctl ui
shipctl ui start --name <name> [--state-root <path>] [--load-state <file>]
shipctl instances list
shipctl instances inspect <name-or-id>
shipctl instances stop <name-or-id> [--force]
```

`shipctl ui` is the convenient default launch of instance `main` at the default
state root. `shipctl-ui` accepts the same name, state-root, and load-state launch
inputs for desktop-launcher and direct debugging use. `shipctl ui start` waits
for the ready handshake and returns the verified instance record; it does not
declare success after merely spawning a process.

All commands are non-interactive. Their canonical assertion model is JSON;
normal CLI output follows the plan-wide TOON rendering contract. Usage errors
exit `2`, operational errors exit `1`, and success or an idempotent no-op exits
`0`.

## Instance identity and selection

An instance has two different identifiers:

- `instanceId`: a fresh opaque UUID for one process incarnation;
- `name`: a user-provided stable selector, unique among live instances in the
  selected runtime discovery namespace.

Names are data, not filesystem paths. They must be non-empty after trimming and
must not contain path separators or control characters. Runtime descriptors are
keyed by `instanceId`, so a name never becomes a trusted path component.

`--instance` accepts either exact identity. Shipctl-created terminals receive
the exact `SHIPCTL_INSTANCE_ID`, so name reuse cannot retarget an old terminal.
Without an explicit selector or injected id, commands may select the sole live
compatible instance; multiple candidates produce `control.instance.ambiguous`.

Starting an already-live name with the same canonical state root is an
idempotent success that returns the existing record. Reusing that name with a
different root is a conflict. A dead name becomes reusable only after endpoint
verification proves that its former process no longer owns the name lease.

## State root and runtime root

The state root is the instance's writable profile, not a project repository.
It contains global configuration, instance-owned UI state, current
capability-owned stores, and later the module registry and artifacts. Project
workspaces remain independently addressable repository paths with their own
`<repo>/.shipctl/workspace.yml` files.

State-root resolution is deterministic:

1. explicit `--state-root <path>`;
2. `SHIPCTL_STATE_DIR` for controlled automation environments;
3. the production default `~/.shipctl`.

Every path is canonicalized into one immutable `InstanceContext` before any
manager, migration, plugin, database, or webview initializes. Direct calls to
`dirs::home_dir().join(".shipctl")` are forbidden after this boundary.

Only one writable UI instance may hold a state-root lease at a time in Step 0.
This prevents the existing YAML and file-backed stores from suffering
cross-process lost updates. Multiple simultaneous instances use distinct state
roots. Later shared services, such as a transactional module registry, may
introduce their own explicitly shared root without weakening this invariant.

Runtime discovery is separate from durable state. A per-user runtime root holds
name leases, descriptors, and local endpoints for instances across all state
roots. Tests may set `SHIPCTL_RUNTIME_DIR` when they require a completely
isolated discovery namespace.

## Discovery and shutdown contract

`shipctl-ui` acquires its name and state-root leases before publishing an atomic
descriptor. It reports ready only after migrations, state loading, control
endpoint setup, and application initialization succeed.

`instances list` validates a versioned same-user local IPC handshake. A
descriptor or matching PID alone is never proof of a live instance. Inspection
reports at least the id, name, build identity, process id, start time, canonical
state root, endpoint protocol, readiness, and state fingerprint.

`instances stop` sends a shutdown request through that authenticated endpoint;
it never signals a PID found in a stale file. A normal stop follows the existing
application shutdown path and refuses with structured blockers when active
non-restorable resources cannot close safely. `--force` is the explicit
authorization to terminate those resources through the application-controlled
shutdown path. Completion means the endpoint is closed and its descriptor and
leases are released.

No command in this contract opens a TCP port or exposes a REST API.

## Required diagnostics

Stable codes cover at least these contract failures:

```text
control.instance.name_in_use
control.instance.state_root_in_use
control.instance.ambiguous
control.instance.stale_descriptor
control.instance.handshake_failed
control.instance.shutdown_blocked
```

Every result includes the requested selector, resolved identity when known,
resolved roots, protocol/build compatibility, and expected versus observed
state. Paths and snapshot payloads are redacted according to their schema; raw
credentials never appear in evidence.

## Acceptance scenarios

The contract is proven only through packaged `shipctl` and `shipctl-ui`
binaries:

1. Start named `test-a` at an isolated state root and observe its ready record.
2. List and inspect it by name and by UUID; both resolve the same incarnation.
3. Start named `test-b` concurrently at another root and prove both remain
   independently addressable.
4. Prove duplicate-name and duplicate-state-root races have one lease owner and
   structured losing results.
5. Stop `test-a`, prove it disappears from the live list, and reuse its name for
   a new UUID.
6. Prove the default `main` state was not read or written by isolated tests.
