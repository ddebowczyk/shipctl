# Agent-operated capability module control plane

**Status:** Draft for implementation review. **Recorded:** 2026-08-08.

## Goal

Let agents add, remove, enable, disable, inspect, diagnose, verify, update, and
reconfigure any supported Shipctl capability module while Shipctl is running.
Every operation must expose enough structured evidence for the same agent to
prove the requested result at mechanism level and in the full application.

The groundwork is an independently addressable application process: agents can
start, list, inspect, save, restore, and stop named `shipctl-ui` instances with
isolated state roots before the first module-control mechanism is introduced.

This is a generic module lifecycle. `terminal` and `assistants` are continuity
stress cases, not the architecture's center.

## Contract

The plan is complete when it provides an ordered, implementation-ready path in
which:

- supported module changes never reload the webview;
- `shipctl` is an agent CLI, `shipctl-ui` is the actual Tauri process, and
  `shipctl ui` launches a named, handshake-verified instance;
- multiple live named instances use explicit state roots, while state archives
  can clone restorable state into a new isolated root;
- one Rust service owns artifacts, desired state, revisions, operations, and
  diagnostics for both the UI and CLI;
- the CLI reaches selected running Shipctl instances over same-user local IPC,
  not a TCP or REST listener;
- immutable module versions are prepared before one atomic catalog swap;
- resource ownership makes disable, remove, update, and rollback truthful;
- every phase adds a production diagnostic and an integration proof using that
  diagnostic;
- the final packaged-app test proves that the originating agent terminal stays
  interactive through success, failure, reconfiguration, and rollback.

## Target shape

```text
shipctl CLI --launches--> shipctl-ui (named instance + explicit state root)
     |                         ^
     +------ local IPC --------+
                               |
settings UI --- Tauri adapter -+--> ModuleRegistry service
                                      | durable desired state + journal
                                      v
                               revision notifications
                                      |
                                      v
                               ModuleSupervisor
                                      |
                             atomic CatalogSnapshot
                                      |
                        panels / commands / providers / jobs

inspect / diagnose / verify <--- joined desired + observed + lease state
```

The CLI transport and Tauri commands are adapters. Neither contains lifecycle
policy or edits registry files directly.

## Diagnostic-first rule

A phase does not exit merely because its new code path works once. It exits
only when it also provides:

1. a versioned structured observation of the behavior;
2. a deterministic check with stable diagnostic codes;
3. an integration test through the production boundary available in that
   phase; and
4. machine-readable evidence showing the expected and observed outcome.

Unit tests may prove internals, but they cannot substitute for the phase's
integration proof. Test fixtures may isolate state; they may not introduce a
second lifecycle API that production agents cannot call.

## Phase map

| Phase | Capability unlocked | Exit evidence |
| --- | --- | --- |
| [0A](00a-named-instance-spec.md) | Named process, path, discovery, and shutdown contract | Reviewable process specification |
| [0B](00b-saved-instance-state-spec.md) | Save, inspect, verify, and restore contract | Reviewable state specification |
| [0C](00c-named-instance-foundation-implementation.md) | Launch/list/inspect/save/load/stop automation foundation | Packaged black-box proof |
| [0D](00-foundation-contracts-and-test-kernel.md) | Module contracts and loader feasibility tripwires | Schemas and loader proofs |
| [1](01-durable-registry-and-offline-inspection.md) | Durable read model and offline agent inspection | Registry recovery proof |
| [2](02-running-instance-control-plane.md) | Module inspection over exact running-instance access | Multi-instance module IPC proof |
| [3](03-artifacts-capabilities-and-preflight.md) | Safe artifact add and preflight | Tamper and compatibility proof |
| [4](04-live-runtime-supervisor.md) | Live A-to-B activation and atomic UI state | Rollback and cleanup proof |
| [5](05-generic-lifecycle-and-reconfiguration.md) | Full generic lifecycle and configuration | Operation and drain proof |
| [6](06-current-module-migration.md) | All current feature modules use the runtime path | Per-module conformance matrix |
| [7](07-agent-development-loop.md) | Edit-build-apply-diagnose loop | Source-to-runtime marker proof |
| [8](08-full-application-verification.md) | Packaged application integration gate | Success and failure evidence bundle |

The task template, dependency gates, and merge order are in
[Execution order and task contract](09-execution-order-and-task-contract.md).

## Design commitments

- `shipctl` never hosts a webview. `shipctl-ui` is the packaged application;
  `shipctl ui` resolves and launches the matching UI executable.
- Runtime identity, user-visible name, durable state root, project workspaces,
  and the per-user discovery root are separate concepts. Step 0 permits one
  writer per state root and supports concurrent instances through distinct
  roots.
- SQLite backs the global module registry and operation journal because the
  lifecycle requires atomic revisions, crash recovery, and safe multi-process
  reads. Existing YAML configuration remains for unrelated Shipctl settings.
- Artifacts are content-addressed and immutable. Desired state points at a
  digest; it never relies on overwriting a stable ESM URL.
- The first live runtime is trusted frontend ESM using mediated host ports.
  Statically linked native adapters remain inert host capabilities when their
  module is absent; adding new native code is restart-required.
- A manifest declares its runtime kind and supported lifecycle. Future isolated
  worker or WASM drivers can join the same registry without changing the agent
  contract.
- Target instance and configuration scope are separate. `--instance` selects
  the process handling a request; `--scope` selects the durable configuration
  affected by a schema that supports scopes.
- JSON is the canonical wire and assertion model. CLI output defaults to
  [TOON](https://toonformat.dev/reference/spec) for compact shell use and
  supports `--output json` for integration tests. Pin the encoder and validate
  golden outputs because the specification is still evolving.

## Planned verification entry points

These recipes are deliverables of the plan; they do not exist yet:

```text
just instance-control contract
just instance-control integration
just module-control contract
just module-control integration
just module-control e2e
just module-control all
```

They belong under `ops/module-control/`. Application code must not import that
test and repository-operations layer.

## Prior decisions superseded here

This plan implements the accepted
[live-reconciliation feedback](../20260808-072927-ext-plus-thin-core/feedback-round-2/README.md).
It supersedes reload-first lifecycle steps in the parent plan. Reload-safe PTY
reattachment remains separate resilience work; it is not required to make
planned module operations safe.
