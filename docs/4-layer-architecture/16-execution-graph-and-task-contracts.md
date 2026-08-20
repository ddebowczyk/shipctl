# Execution graph and task contracts

## Purpose

This document turns the approved architecture into dependency-ordered work.
The indexed YAML records are the compilation input for child tasks under epic
`shep-vut`.

## Program graph

```text
A  executable contracts and baseline
|
B  semantic frontend service wall
|\
| +--> C  Cordis application composition with headless fixture + commands
|       |
|       +--> E0 headless fixture + commands immutable artifacts
|             |
|             +--> F  live candidate reconciliation
|                    |
|                    +--> G  workspace contribution reconciliation
|
+----> D0 ports native-provider pilot
       |
       +--> D1..Dn remaining provider slices

B + C + D(service prerequisites)
       -> E1..En remaining immutable plugin slices

D0..Dn + E0..En + F + G
       -> H architecture closure
```

The graph has two parallel tracks after the service wall:

- Cordis, artifacts, and runtime reconciliation prove dynamic TypeScript
  application lifecycle for headless and compound plugins.
- Native-provider slices remove Rust feature modules without moving feature
  policy into core.

The closure waits for both tracks. Layman projection work waits for the
semantic workspace and contribution catalog, not for every native extraction.

## Work packages

### A. Executable architecture contract

Deliver:

- record schemas and first capability and disposition records;
- architecture graph extraction and mutation fixtures;
- baseline snapshots for the current static system;
- property runner integration and evidence schema;
- characterized legacy composition proof.

Exit: Phase A properties pass and no application behavior changes.

### B. Semantic service wall

Create one task per semantic service slice. Each task must add the public
service contract, platform adapter, fake-host implementation, migrated plugin
client, and direct-Tauri import deletion for that slice.

Start with a narrow service used by the `ports` pilot. Continue according to
the provider and plugin prerequisites recorded in the specification graph.

Exit: headless plugin code is DOM-free testable, presentation code is
browser-testable without Tauri, and the source graph rejects new direct Tauri
edges.

### C. Cordis adapter and static lifecycle

Deliver:

- exact Cordis revision pin;
- Shipctl-owned adapter over Context, activation, effect, and disposal behavior;
- candidate activation, application-service, and optional contribution
  publication model;
- a headless provider/consumer conformance fixture without React;
- compound `commands` activation through Cordis while source remains bundled;
- lifecycle, role, effect, parity, and disposal properties.

Exit: `commands` has no direct call in the legacy activation loop.

### D0. Ports native-provider pilot

Deliver the complete process capability, Tauri adapter, service client,
authorization model, differential proof, package proof, and deletion of ports
Rust projections.

Exit: the ports plugin is TypeScript-only and uses the process service.

### D1..Dn. Remaining native providers

Create one task family per module from the disposition matrix. Split a family
only at a stable service or data-migration boundary. Each final task in the
family owns deletion of that module's obsolete Rust, Cargo, Tauri, and ACL
paths.

Exit: no optional feature owns native code under `modules/`.

### E0. Headless fixture and commands immutable artifacts

Deliver a reproducible headless fixture artifact and compound `commands`
artifact, closed manifest, digest admission, external closure, loader, artifact
property suite, and parity with bundled command behavior.

Exit: a no-React service provider and the built-in compound command plugin use
the same loaded-artifact path intended for installed plugins.

### E1..En. Remaining plugin artifacts

Move one plugin at a time after its service imports and lifecycle behavior are
ready. Each task covers artifact build, admission, activation, disposal,
package inventory, and deletion of the direct source implementation import.

Exit: no built-in has a privileged lifecycle path.

### F. Live candidate reconciliation

Deliver the desired-state watcher, candidate graph, isolated activation,
readiness barrier, atomic service-and-catalog publication, provider routing,
rollback disposal, monotonic observed state, restart recovery, and structured
inspection.

Exit: add, enable, disable, replace, and failure transitions converge without
app restart, partial service routing, or partial catalog visibility.

### G. Workspace contribution reconciliation

Deliver typed activation-owned contribution catalogs, semantic workspace
reconciliation, dynamic view instances, renderer adapters, Layman projection,
layout persistence, reset, missing-view behavior, and agent inspection.

Exit: plugins can add and remove views, commands, menus, navigation items, and
settings without hard-coded shell membership.

### H. Architecture closure

Run all source, contract, property, integration, package, installed-app, and
control-plane proofs. Delete the remaining static membership, restart-only
lifecycle, module Rust projections, and raw shims named by the disposition
records.

Exit: every end-state acceptance proof in document 13 passes. Deleting the
legacy canvas is part of H only under the separately recorded product decision
and its named parity evidence; that authorization was recorded on 2026-08-19.

## Child task contract

Each implementation task must contain:

- the one outcome that the task owns;
- cited semantic and property IDs;
- exact current files and target owners;
- prerequisites expressed as Beads dependencies;
- public behavior that must remain equal and intended behavior changes;
- generated domain, oracle, and failure value for each property;
- implementation artifacts and deletion targets;
- focused proof commands and structured evidence paths;
- rollback condition before deletion;
- explicit exclusions that belong to a different task.

A task is too broad if it changes more than one authority boundary without an
independent cutover. A task is too small if it leaves duplicate authority and
no later task owns deletion.

## Task completion rule

A task can close only when:

1. its normative record validates;
2. every required property has an executable test ID;
3. the deliberate mutation fails for the expected reason;
4. regression replay and a fresh campaign pass;
5. focused integration and package checks pass where relevant;
6. agent-visible snapshots show the new authority and ownership;
7. every deletion target assigned to the task is absent;
8. the parent architecture graph has no new forbidden edge.

A changed implementation without deletion is incomplete. A deleted path
without proof is unsafe.

## Beads compilation and execution

The existing epic remains `shep-vut`. The user approved execution. The full
program is compiled into dependency-linked child tasks. `shep-vut.1` owns the
executable record graph and checker. `shep-vut.2` owns the passive boundary,
reviewed source baseline, legacy composition characterization, and replay
support. Both Phase A tasks are complete.

The remaining graph separates semantic service foundations, individual
service ports, native provider extractions, immutable plugin artifacts,
reconciliation, workspace composition, and final closure. The shared Phase B
contract and enforcement foundation is complete. The next tasks migrate one
capability at a time and delete its exact entries from the non-platform Tauri
import ledger.

Use JSON output for all Beads inspection and mutation commands, as required by
the repository instructions. Do not add placeholder tasks for unresolved
design choices. Record the decision owner in the specification and add the
task after resolution.

## Work that must not join the critical path

These changes do not prove the four-layer contract and need separate product
or cleanup decisions:

- renaming `module-api/` to `plugin-api/`;
- deleting the legacy canvas before Layman product acceptance;
- placing untrusted plugins in a separate process or browser realm;
- general shell redesign, visual restyling, or unrelated module UX changes;
- replacing Cordis internals or extending Layman beyond Shipctl's proven need;
- moving files only to make the tree look complete.

They can be useful later. They are not prerequisites for this migration.
