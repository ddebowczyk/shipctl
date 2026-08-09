# Phase 6 — migrate terminal, agents, projects, and feature capabilities

## Outcome

Move current Shipctl behavior behind capability contracts and live TypeScript
modules while keeping the Rust kernel limited to stable native mechanisms.
Every migrated capability becomes independently replaceable, inspectable, and
operable by agents through the Phase 5 surface.

## Common migration contract

Each module:

1. packages its TypeScript, UI, styles, and assets as an immutable artifact;
2. defines or implements explicit capability contracts;
3. declares ports, events, channels, streams, grants, configuration, and native
   adapter requirements;
4. replaces direct Tauri imports with mediated host APIs;
5. registers all contributions and resources through its activation context;
6. supports live enable, disable, replacement, and cleanup where its manifest
   claims those operations; and
7. proves behavior through public capability and lifecycle diagnostics.

Phase 3 admission alone is not a migrated feature. Until Phase 4 activates a
selected provider in a `CatalogSnapshot`, a disabled artifact can be inspected
but cannot publish UI, routes, events, stream attachments, schedule targets, or
native-adapter behavior.

Feature membership no longer comes from `ENABLED_MODULES` or compile-time
Cargo features. New native code remains restart-bound; already compiled native
adapters stay dormant until a provider with the required grant activates them.

## Migration order

1. The fixture proves a module-defined capability, typed port, event, asset,
   scheduler target, and agent access.
2. Terminal proves stable native resources, multi-subscriber streams, and live
   UI/provider replacement.
3. Assistants and agent sessions consume terminal capabilities and expose agent
   and session lifecycle contracts.
4. Project browser proves workspace-scoped providers, filesystem observation,
   and left-navigation contribution.
5. TODOs and commands prove ordinary data and frontend-only capabilities.
6. Git proves a broad request surface and workspace lifecycle.
7. Utilization and usage prove event consumers and scheduled refresh.
8. Ports and skills complete remaining feature extraction.

This is dependency order, not a requirement to create one task or document per
module. Complete coherent migration slices and prove each public contract once.

## Terminal capability

Rust retains the PTY/process adapter and a session registry independent of any
webview. The TypeScript terminal module owns terminal behavior, presentation,
and UI contributions.

The capability exposes typed ports for list, spawn, inspect, write, resize,
stop, attach, and detach. Lifecycle facts such as started, renamed, exited, and
ownership changes are declared bus events.

PTY bytes use a dedicated host-owned stream with ordered sequence numbers and
multiple read-only subscribers. UI terminals, assistant modules, and external
agents can observe the same session without competing for a spawn-time Tauri
channel. Any reconnect replay is memory-only and bounded from measured terminal
requirements; ordinary terminal content is never written to the registry.

Replacing or disabling the TypeScript provider detaches its observers but does
not kill a host-owned PTY unless an explicit stop policy requires it. A new
provider or webview attaches by stable session identity.

## Assistants, sessions, and projects

Assistant and agent-session modules use terminal ports and streams instead of
owning hidden PTY transport. They expose inspectable session state, commands,
events, and wakeup/message endpoints for scheduler use.

Project-browser capability owns workspace discovery, filesystem observation,
project selection, and the left-navigation contribution. Native filesystem
watching remains a granted host adapter. Consumers depend on the capability
contract, not on its concrete provider store.

## Remaining feature capabilities

TODOs, commands, git, utilization/usage, ports, and skills follow the common
contract. A module may introduce a new capability definition when no built-in
contract exists. Scheduled behavior uses scheduler messages; inter-module
coordination uses declared bus surfaces rather than imports between feature
implementations.

## Diagnostic and verification mechanism

Generate conformance evidence from real module inspection, capability
inspection, calls, event watches, stream attachment, and runtime snapshots.
For each migrated capability record artifact digest, provider binding, effective
grants, observed contributions, resource ownership, cleanup, and stable failure
codes. Do not maintain a parallel hand-written checklist.

## Exit proof

- Terminal output remains ordered and observable by the UI and an external
  agent while its TypeScript provider is replaced without killing the PTY.
- Assistants and sessions use the terminal capability and remain inspectable
  through declared ports and events.
- Project browser and its left-navigation contribution can be replaced or
  disabled without changing unrelated providers.
- Current features no longer depend on static frontend composition, direct
  Tauri access, or compile-time enable/disable switches.
- Every migrated module can be enabled, disabled, replaced, inspected,
  diagnosed, and cleaned up without a Rust rebuild or webview reload.

## Primary implementation areas

- `core/backend/src/<capability>/` for stable native adapters;
- `core/frontend/<capability>/` for host contracts and shared UI primitives;
- `modules/<name>/` for removable TypeScript implementations and assets;
- `modules/api/` for capability definitions and activation APIs; and
- `ops/module-control/` for public conformance and continuity proofs.
