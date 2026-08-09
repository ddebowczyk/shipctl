# Agent-operated capability runtime

**Status:** Revised for implementation. **Revised:** 2026-08-09.

## Goal

Let agents manage and use Shipctl capabilities in a running named instance.
Agents must be able to add, remove, enable, disable, replace, configure,
inspect, diagnose, and verify modules without rebuilding Rust or reloading the
webview. They must also be able to discover capability providers, invoke their
declared ports, watch their events, and attach to authorized streams.

The Rust host is a minimal, slowly changing kernel. TypeScript modules own
feature behavior and UI and use stable APIs exposed by that kernel.

## Core model

Three concepts stay separate:

- A **capability contract** defines a stable, versioned semantic API: ports,
  events, streams, schemas, scopes, declared agent access, and
  provider-selection rules.
- A **module artifact** packages one or more TypeScript implementations with
  their contracts, JavaScript, styles, and assets.
- A **provider binding** connects one activated module instance to a capability
  contract in one named Shipctl instance.

Modules may define new versioned capabilities as well as implement built-in
ones. `modules/api` owns the meta-contract and built-in host contracts; it is
not an exhaustive central catalog.

## Target shape

```text
shipctl CLI -------- same-user local IPC --------> named shipctl-ui instance
                                                     |
                       +-----------------------------+------------------+
                       |                             |                  |
                ModuleRegistry              ModuleSupervisor     Scheduler
               desired state and             atomic runtime       file-defined
             durable operations only           snapshot             triggers
                       |                             |
                       +---------------------- RuntimeMessageBus
                                                     |
                                      ports / events / channels / streams
                                                     |
                                    activated TypeScript capability modules
```

The message bus is ephemeral. It routes live commands, messages, and events; it
does not persist them. A logger module may subscribe and persist selected data
when explicitly configured. Continuous data such as PTY bytes uses dedicated
host-owned streams rather than the general bus.

## Rust kernel boundary

Rust owns only mechanisms that need native authority or process durability:

- the Tauri shell and same-user local instance protocol;
- named-instance identity, state-root isolation, and process discovery;
- artifact integrity, grants, and native resource adapters;
- the in-process message bus and per-instance scheduler;
- stable resource registries such as PTY processes and stream fan-out; and
- durable desired state, configuration, operation identity, and reconciliation
  observations.

Rust does not encode feature membership or ordinary feature behavior. New
native Rust or Tauri registrations remain release- and restart-bound and must
not be presented as live-loadable.

## Module packaging

Source modules are normal npm/pnpm packages built with Vite or Rollup. Runtime
installation consumes an immutable Shipctl artifact, not a source checkout or
`node_modules` tree:

```text
module.yaml
module.mjs
chunks/*
styles/*
assets/*
capabilities/*
messages/*
integrity.json
```

Adding or replacing an artifact never runs `npm install`, lifecycle scripts, a
Rust build, or a webview reload. An npm registry may later distribute archives;
it is not part of runtime activation.

## Phase map

| Phase | Capability unlocked | Exit evidence |
| --- | --- | --- |
| [0A](00a-named-instance-spec.md) | Named process and state-root contract | Reviewable process specification |
| [0B](00b-saved-instance-state-spec.md) | Save and restore contract | Reviewable state specification |
| [0C](00c-named-instance-foundation-implementation.md) | Launch, list, inspect, save, load, and stop | Packaged black-box proof |
| [0D](00-foundation-contracts-and-test-kernel.md) | Module contracts and loader seam | Contract and packaged loader proofs |
| [1](01-durable-registry-and-offline-inspection.md) | Durable desired state and offline inspection | Registry recovery proof |
| [2](02-running-instance-control-plane.md) | Exact running-instance access | Multi-instance local-IPC proof |
| [3](03-artifacts-capabilities-and-preflight.md) | Packages, capability contracts, and preflight | Disabled fixture is installable and inspectable |
| [4](04-live-runtime-supervisor.md) | Live capability providers and atomic replacement | A-to-B activation with C rollback proof |
| [5](05-generic-lifecycle-and-reconfiguration.md) | Lifecycle plus agent capability operations | Call, watch, attach, drain, and cleanup proof |
| [6](06-current-module-migration.md) | Terminal, agents, projects, and feature capabilities | Production-module conformance proofs |
| [7](07-agent-development-loop.md) | Build, pack, apply, and watch workflow | Source-to-runtime digest proof |
| [8](08-full-application-verification.md) | Packaged end-to-end agent operability | Success, failure, and continuity bundle |

The implementation order and lean task contract are in
[Execution order and task contract](09-execution-order-and-task-contract.md).

## First cross-phase working milestone

The first meaningful milestone uses one fixture archive that defines a new
capability, implements a typed port, emits an event, exposes a UI contribution,
and accepts a scheduler message. Through public commands an agent must be able
to install it disabled, enable it, discover and call it, watch its event,
refresh and trigger its schedule, replace A with B, reject invalid C while B
remains active, then disable and remove it. The host binary and webview remain
unchanged throughout.

Phase 3 proves only disabled artifact publication: dynamic capability
definitions, binding and selection validation, declared agent surfaces, and
offline inspection. Activation and replacement belong to Phase 4; discovery,
calling, and watching belong to Phase 5.

## Diagnostics and persistence

Every phase adds the smallest production inspection or verification surface
needed to prove its new behavior. Durable storage is limited to desired state,
configuration, immutable artifact references, operation identity and state,
and reconciliation observations needed across restarts. Bus events, terminal
bytes, schedule ticks, and routine internal activity are not written to the
registry.

JSON is the canonical wire and assertion format. The CLI may render compact
TOON by default and supports JSON for integration tests. Instance access uses
same-user local IPC; Shipctl does not expose a REST listener.

## Prior decisions superseded here

This revision incorporates
[revision 2](revision-2/revised-plan.md) and the accepted
[live-reconciliation feedback](../20260808-072927-ext-plus-thin-core/feedback-round-2/README.md).
It replaces the former catalog-centered model and the reload-first lifecycle.
PTY reattachment is now part of terminal capability migration because terminal
continuity is a required runtime property, not a reason to reload safely.
