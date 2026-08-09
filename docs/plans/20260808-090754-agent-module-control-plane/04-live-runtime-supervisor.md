# Phase 4 — live capability provider runtime

## Outcome

Activate, replace, and deactivate TypeScript capability providers in an already
running named instance without rebuilding Rust or reloading the webview. A
failed candidate never disturbs the last good runtime snapshot.

## Work package 4.1 — module supervisor

Add one long-lived `ModuleSupervisor` per Shipctl instance. It reconciles a
desired registry revision into an immutable runtime snapshot. Lifecycle policy
remains behind this service; Tauri commands, the CLI transport, and React are
adapters.

Phase 3 admission is not activation: an installed, disabled archive may be
inspected, but it contributes no runtime code, public route, UI contribution,
schedule target, or native resource. The supervisor is the sole transition
that reconciles desired state into a `CatalogSnapshot` and makes it public.

For each activated artifact the supervisor records:

- module instance identity and artifact digest;
- implemented and defined capabilities;
- effective grants and configuration revision;
- acquired native handles and stream/resource leases;
- health, diagnostics, and applied desired revision; and
- cleanup state for a replaced or disabled provider.

## Work package 4.2 — atomic catalog snapshot

Publish one atomically replaceable `CatalogSnapshot` containing:

- capability definitions and active provider bindings;
- message-bus routes and agent-accessible ports;
- event topics, directed channels, and stream descriptors;
- UI contributions and their owners;
- scheduler-addressable endpoints;
- native resource adapters and leases; and
- provider health and activation identity.

Readers always observe one complete snapshot. Capability definitions may exist
without an active provider. Exclusive capabilities have at most one selected
provider per scope; multi-provider capabilities expose every healthy binding
and deterministic selection metadata.

## Work package 4.3 — transactional activation

Activation prepares a candidate away from public routing:

1. load the digest-qualified ESM entry point;
2. validate the runtime declaration against the preflighted manifest;
3. create an instance-bound activation context with only effective grants;
4. register provisional ports, events, streams, UI contributions, and schedule
   targets;
5. run the provider readiness check; and
6. publish one new catalog snapshot.

Only after publication may new work reach the candidate. Replacement prepares B
while A remains public, atomically routes new work to B, then disposes A when
its owned resources permit. If B or invalid C fails, the supervisor removes its
provisional state and leaves A or B unchanged.

## Work package 4.4 — frontend host attachment

The frontend host renders UI contributions from the current snapshot and
attaches or detaches their code and assets by activation identity. Module code
uses the host module API; it does not import Tauri directly or mutate global
registries. React singleton identity and digest-qualified URLs remain enforced.

The host subscribes once to snapshot changes. It does not reload the document
and does not infer module membership from static `ENABLED_MODULES` composition.

## Diagnostic and verification mechanism

Expose a structured runtime snapshot and transition result through the exact
named-instance control plane. The observation joins desired revision, applied
revision, provider identity, digest, routes, contributions, grants, resources,
and failure diagnostics.

The fixture from Phase 3 implements its new capability, typed port, event, UI
asset, and scheduler endpoint. Build A, compatible B, and C whose activation
fails after loading. Use the same packaged host binary for every transition.

## Exit proof

- Enabling A publishes its provider, port, event, UI contribution, and schedule
  endpoint in one snapshot.
- Replacing A with B atomically redirects new work and removes A only after its
  owned work is released.
- C fails with a stable diagnostic; B remains callable and visible.
- Disable removes the provider and all of its public routes and contributions.
- No transition changes the host binary, rebuilds Rust, reloads the webview, or
  requires a second runtime API.
- Snapshot inspection through local IPC is sufficient to prove ownership and
  cleanup without reading frontend stores.

## Primary implementation areas

- `core/backend/src/module_control/` for reconciliation and observations;
- `core/frontend/host/` for activation and atomic catalog publication;
- `modules/api/frontend/` for the activation context and provider contracts;
- `examples/module-fixture/` for A, B, and C; and
- `ops/module-control/` for running-host transition proofs.
