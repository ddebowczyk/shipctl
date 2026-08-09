# Phase 5 — lifecycle and agent capability operations

## Outcome

Complete the generic module lifecycle and let external agents discover and use
the capability surfaces of an exact running Shipctl instance.

## Work package 5.1 — lifecycle operations

Implement add, enable, disable, replace, reconfigure, rollback, and remove as
idempotent operations with expected-revision or expected-digest preconditions.
Every request receives a stable operation identity and an observable terminal
result. Reconciliation may cross the registry, backend, frontend host, and more
than one instance, so operation observation remains durable even when the
in-process activation itself is fast.

`add` retains Phase 3's disabled-admission semantics: it may validate and
record an artifact, but it does not load code, publish a route, or attach a
native adapter. An enabled desired state becomes public only through Phase 4's
supervisor reconciliation.

Persist only facts needed across restarts: desired state, non-secret effective
configuration, secret references, selected artifact digests, operation state,
and per-instance reconciliation observations. Do not persist bus traffic,
terminal bytes, schedule ticks, or routine internal events. Optional logger
modules own any requested event history.

## Work package 5.2 — agent capability API

Expose the activated catalog over the existing same-user local instance
protocol. The CLI supports exact instance targeting:

```text
shipctl capabilities list --instance <name>
shipctl capabilities inspect <capability-id> --instance <name>
shipctl capabilities providers <capability-id> --instance <name>
shipctl capabilities call <capability-id> <port-id> --instance <name> --input <json-or-file>
shipctl events watch <topic-id> --instance <name>
shipctl streams attach <stream-id> --instance <name>
```

CLI commands resolve only declared, explicitly agent-accessible surfaces. They
validate inputs and outputs against the capability schemas. Rust binds caller
identity and grants at the control boundary; agents cannot claim a module
identity, inject arbitrary bus messages, or invoke private implementation
routes.

## Work package 5.3 — provider selection and configuration

Support capability-level provider inspection and selection. Exclusive
capabilities expose one selected provider per supported scope. Multi-provider
capabilities expose deterministic selection metadata and explicit targeting.

Configuration is versioned by the scopes declared in its schema. A live-safe
configuration change reconciles the running provider without rebuilding code.
A change requiring a new native registration is classified restart-required
before commit.

## Work package 5.4 — resources, streams, and drain

Host-owned native resources survive frontend module replacement when their
contract requires continuity. Track their owner, observers, leases, and drain
blockers. New work stops routing to a draining provider; existing leases either
finish under their original owner or are transferred only when the capability
contract explicitly supports it.

Stream identity is independent of a webview-created channel. A consumer may
attach, detach, and reconnect by stable resource identity. Backpressure,
ordering, and any bounded in-memory replay are defined by each stream contract,
not by the general event bus.

## Diagnostic and verification mechanism

`inspect`, `diagnose`, operation watch, capability call, event watch, and stream
attach all use the production local-IPC boundary and emit versioned structured
results. Verification joins desired revision, applied revision, provider
identity, selected digest, effective configuration, public routes, resources,
leases, and stable diagnostic codes.

Use the Phase 3 fixture to prove lifecycle and agent access. Include duplicate
requests, stale preconditions, invalid call payloads, denied private routes,
activation failure, drain, and cleanup.

## Exit proof

- An external agent can target a named instance, discover the fixture's new
  capability, invoke its typed port, and watch its declared event.
- Authorized stream attachment works by stable resource identity and does not
  consume another subscriber's data.
- Add, enable, replace, reconfigure, rollback, disable, and remove converge to
  inspectable terminal operation results.
- Retrying the same request is idempotent; stale preconditions fail without
  changing desired state.
- Disabled or removed providers have no public routes or unleased resources.
- No lifecycle path rebuilds Rust, reloads the webview, or stores ephemeral bus
  and stream traffic in the registry.

## Primary implementation areas

- `core/backend/src/module_control/` for operations and reconciliation;
- `core/backend/src/instance/` and `cli/` for the public local-IPC surface;
- `core/frontend/host/` for provider and resource coordination;
- `modules/api/` for agent-accessible schemas; and
- `ops/module-control/` for lifecycle and external-agent integration proofs.
