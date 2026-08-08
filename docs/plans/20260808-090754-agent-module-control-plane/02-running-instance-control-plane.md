# Phase 2 — running-instance control plane

## Outcome

Extend the Step 0 named-instance control plane with module registry and observed
runtime inspection. The endpoint remains private to the current OS user; it is
not a localhost REST API.

## Work package 2.1 — reuse instance identity and discovery

Use the UUID, live name, leases, atomic descriptor, and same-user endpoint
already proven in Step 0. Extend inspection metadata with workspace identities
currently known to the instance. Module code must not create an alternative
descriptor directory, endpoint, or instance selector.

## Work package 2.2 — versioned local protocol

Extend the Step 0 JSON framing contract with:

- `hello` and negotiated protocol version;
- request id, command, parameters, and caller metadata;
- response or structured error;
- revision and operation events for watchers; and
- explicit stream completion.

The server adapter calls the same `ModuleRegistry` service used by Tauri. It
adds authenticated instance context but no lifecycle policy.

Mutations are still disabled in this phase. Unsupported commands return a
structured capability error rather than being silently ignored.

## Work package 2.3 — consume deterministic instance selection

Preserve the Step 0 selection order:

1. explicit `--instance <name-or-id>`;
2. `SHIPCTL_INSTANCE_ID`, injected by Shipctl into terminals it launches;
3. the sole live compatible instance; or
4. `control.instance.ambiguous` with the candidates.

No process is chosen by recency, window focus, PID order, or unspecified
heuristic. Selection of a process is separate from a command's configuration
scope.

Add module-control diagnostics to `shipctl instances inspect` and add
`shipctl instances diagnose [<name-or-id>]`. The terminal environment injection
remains owned and tested by Step 0.

## Work package 2.4 — joined live inspection

The frontend host publishes an observed-runtime snapshot through the control
service. Join it with registry truth by module id, instance id, digest, and
revision. Online `modules inspect` reports:

- desired digest and configuration revision;
- observed digest, module instance id, lifecycle state, and applied revision;
- registered contributions and effective grants;
- active resource leases and drain blockers; and
- runtime diagnostics with host or module provenance.

Host-authoritative facts must be distinguishable from module-reported health.
A module cannot self-report a different identity, digest, grant set, or owner.

## Diagnostic and verification mechanism

The instance diagnostic checks descriptor validity, endpoint access, handshake,
protocol compatibility, build identity, registry access, observed-snapshot
freshness, and revision lag.

Integration tests start real `shipctl-ui` processes through `shipctl ui` and
invoke the compiled CLI. Reuse Step 0 coverage for lifecycle edge cases; add
module-specific checks for explicit and injected targeting, incompatible module
protocol capability, terminated servers, and joined desired/observed state.

## Exit proof

- Step 0 instance lifecycle and isolation gates remain green.
- Explicit and injected targeting reach the intended server in a two-instance
  test; an untargeted request fails as ambiguous.
- A caller outside the current-user permission boundary cannot open the endpoint
  in the supported platform test lane.
- Online inspection reports desired and observed revisions without conflation.
- Stopping the instance converts observed state to unavailable without
  corrupting the durable registry.
- The app opens no TCP listener for module control.
- Existing repository gates remain green.

## Primary implementation areas

- `core/backend/src/module_control/` for protocol and server adapter;
- `src-tauri/src/lib.rs` for module service attachment to the existing endpoint;
- `core/frontend/host/` for observed snapshot publication;
- `ops/module-control/` for multi-process integration tests.
