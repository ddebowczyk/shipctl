# Module disposition matrix

<!-- markdownlint-disable MD013 -->

## Purpose

This document maps each current module to its target plugin and platform
capabilities. It prevents a directory move from deciding architecture by
accident.

The live repository has nine module manifests. Seven describe Rust backends.
Six of those also have a separate Rust host adapter. Seven frontend packages
import Tauri directly. The matrix splits TypeScript application-lifecycle work
from native-provider extraction because they have different risk and proof
needs.

## Summary matrix

| Module | Current native shape | Target plugin ownership | Target platform services | Migration position |
| --- | --- | --- | --- | --- |
| `commands` | No Rust backend | Saved-command service, persistence policy, autostart, session tracking, commands, optional presentation | Terminal, contribution, and workspace command services | First compound Cordis and artifact pilot |
| `ports` | Backend and host; two permissions | Polling policy, port projection, commands, action wording, notices, optional UI | Scoped process inspection and termination | First native-provider pilot |
| `thin-terminal` | No module Rust; uses host terminal capability | xterm view, terminal workflow, local presentation state | Terminal session, stream, input, resize, clipboard | Early service consumer; later artifact migration |
| `todos` | Backend without host adapter | TODO parsing policy, ordering, presentation, mutations | Scoped project document read and atomic write | Early policy-extraction slice |
| `skills` | Backend and host | Discovery and indexing services, setup workflow, commands, optional presentation | Scoped files, approved installation operations, plugin data | After file-service semantics |
| `git` | Backend and host; native events | Git projections, workflow, refresh policy, commands, optional UI | Scoped Git operations and watcher leases | After event and watcher services |
| `assistants` | Backend and host; session and credential work | Session services, provider orchestration, commands, labels, models, optional UI | Terminal/process, credentials, durable plugin data | After terminal ownership is proven |
| `usage` | Backend and host; database, ingest, queries | Ingestion, normalization, aggregation, scheduled refresh, projections, optional dashboard | Approved source access, durable plugin data, scheduling and messages | Late durable-state slice |
| `semantic-terminal` | Backend, host, and a large Rust core | Semantic terminal view, interaction policy, presentation | Host terminal plus semantic screen protocol and durable anchors | Last continuity-sensitive slice |

“Migration position” is dependency order, not an effort estimate.

## Two migration tracks

### TypeScript application lifecycle and artifacts

The low-risk order starts with `commands`, which has no Rust backend. It then
moves plugins whose service boundaries are already proven. Terminal and
assistant plugins remain late because replacement must preserve live sessions.

### Native-provider extraction

The low-risk order starts with `ports`, which has a small and clear OS
mechanism. Later slices can proceed when their required service and ownership
records pass. The order can branch; it is not one large serial rewrite.

## Shared Rust module API

`module-api/backend` is not a tenth product module. It is a leaf compatibility
crate created for the current native module model. Core, Tauri, assistants,
usage, and semantic terminal use its terminal, snapshot, and durable-write
contracts.

Its target disposition is:

- terminal IDs, values, authority, driver registry, and driver traits move to
  the permanent terminal capability under `core/backend`;
- durable-write coordination moves to the permanent state or persistence
  capability that owns it;
- snapshot provider contracts move to the permanent state archive capability;
- Tauri-only wire mappings remain private under `core/tauri` when needed;
- the `shipctl-module-api` crate and all Cargo edges to it are deleted after
  the last native feature provider is extracted.

This move occurs late in the native-provider track because the crate is a
shared bridge for current modules. The public `module-api/frontend` contract
can evolve earlier and independently.

## Commands

Current facts:

- the module is frontend-only;
- it is statically imported through the current built-in list;
- `runtime.ts` owns saved-command persistence, terminal-session lifecycle
  tracking, start/stop, and autostart behavior outside the React panel;
- saved commands use the activation-scoped Plugin Data service with one
  compare-and-write revision per project;
- it exercises headless behavior, commands, and UI contribution contracts
  without module-owned native state.

Target split:

- the compound plugin owns its saved-command service, persistence policy,
  autostart controller, session tracking, command definitions, optional
  command-palette presentation, and feature-specific actions;
- the host owns activation, contribution catalogs, workspace dispatch, and
  notices through public services;
- no Commands-specific native capability is added. Persistence uses the shared
  Plugin Data capability.

Deletion gate: remove its direct static activation only after Cordis lifecycle,
contribution parity, disposal, and immutable artifact properties pass.

## Ports

Current facts:

- `modules/ports/backend` lists listeners and kills a selected port process;
- `modules/ports/host` installs the Tauri plugin;
- the frontend imports Tauri directly.

Target split:

- `core/backend/src/processes/` owns portable process inspection and safe
  termination rules;
- `core/tauri/src/processes.rs` adapts those rules to Tauri;
- the plugin owns polling policy, port-oriented projections, filtering, labels,
  refresh behavior, commands, actions, notices, and optional UI;
- the public service uses an inspection identity so a reused PID cannot become
  a different termination target.

Deletion gate: delete the ports backend crate, host crate, Cargo feature, ACL
projection, and direct Tauri client after the process provider proofs pass.

## Thin terminal

Current facts:

- the module has no Rust crate;
- it already depends on shared terminal host behavior;
- its important behavior is xterm focus, input, paste, resize, and rendering.

Target split:

- the plugin owns xterm setup, view state, and terminal-specific UX;
- the host owns terminal session identity, process lifetime, stream transport,
  input, resize, and authorized clipboard access;
- session ownership is independent from plugin activation ownership.

Deletion gate: remove direct host or Tauri knowledge from the plugin after the
terminal service fake, packaged focus/input proof, and session ownership model
pass. Do not make this the first lifecycle pilot because interactive focus is a
poor control variable for Cordis adoption.

## Todos

Current facts:

- the Rust backend reads, parses, changes, and writes project TODO content;
- the module has no separate host crate;
- much of this behavior is feature policy, not native authority.

Target split:

- the plugin owns TODO syntax interpretation, ordering, move rules, and UI;
- a scoped project-document service owns authorized reads and atomic writes;
- a temporary TODO-specific adapter can preserve current behavior while
  TypeScript policy is characterized and moved.

Deletion gate: remove the TODO command plugin only after generated document
roundtrips, concurrent-write policy, path-scope denial, and legacy parity pass.
The final core must not contain TODO concepts.

## Skills

Current facts:

- the Rust backend lists, installs, and removes skills;
- the frontend uses the public Skill Installation service through its module
  activation;
- operations cross filesystem and installation boundaries.

Target split:

- the plugin owns discovery and indexing behavior, setup workflow, commands,
  and optional presentation;
- platform services own scoped filesystem access and only the reviewed
  installation operations named by capability records;
- grants identify allowed roots and operations. They do not expose an
  unrestricted filesystem bridge.

Deletion gate: remove the skills crates after traversal, scope, atomic install,
rollback, and behavior properties pass.

## Git

Current facts:

- the Rust backend exposes repository, branch, worktree, status, diff, stage,
  commit, switch, and push operations;
- the frontend also listens for native events;
- the host adapter is tied to a workspace scope.

Target split:

- `core/backend` owns Tauri-free, scoped Git execution and watcher resources;
- `core/tauri` owns command and event transport;
- the plugin owns Git projections, workflow, refresh policy, wording, commands,
  and optional views;
- a semantic event subscription service replaces raw Tauri event names and
  returns an activation-owned lease.

Deletion gate: remove the Git module crates and native listeners after command
parity, repository-scope, watcher ownership, event ordering, and disposal
properties pass.

## Assistants

Current facts:

- native code covers session spawn and resume, capture, placement, labels,
  provider model data, Pi configuration, and credentials;
- Pi credential operations cross an activation-scoped semantic service. Only
  the trusted adapter knows their current Tauri command names;
- terminal sessions and assistant records have durable meaning outside a
  mounted React view.

Target split:

- the plugin owns assistant-session services, provider orchestration, event
  handling, commands, optional session presentation, model choices, labels,
  and capture policy that does not require native secrecy;
- host services own process and terminal resources, credential storage,
  authorized configuration writes, and durable session records;
- plugin data stores feature records through a versioned schema; the host does
  not interpret provider-specific UI policy;
- session resources survive plugin replacement according to an explicit lease
  and adoption protocol.

Deletion gate: remove the assistant crates only after session recovery,
credential non-disclosure, terminal continuity, record migration, and provider
behavior properties pass.

## Usage

Current facts:

- native code owns provider ingestion, a database, queries, pricing data, and
  snapshots;
- source refresh participates in the message bus. Settings use the public
  Plugin Data service, and the native Usage host reads the same owned record;
- source interpretation and dashboard aggregation are mixed with native file
  and scheduling mechanisms.

Target split:

- the plugin owns provider-specific ingestion, parsing, normalization,
  aggregation, pricing interpretation, scheduled refresh, projections, and
  optional dashboard views;
- platform services expose reviewed source readers, namespaced durable plugin
  data, scheduler leases, and typed messages;
- the current database migrates only after its schema authority and recovery
  rules are explicit. A private compatibility adapter can keep the old schema
  during the move.

Deletion gate: remove the usage crates after database migration, ingestion
idempotency, message compatibility, source-scope, snapshot parity, and restart
recovery properties pass. This is a late slice because data loss is harder to
reverse than a presentation defect.

## Semantic terminal

Current facts:

- the module contains a Tauri backend, a host adapter, and a substantial Rust
  semantic engine with input, projection, replay, retention, anchors, painting,
  and trace behavior;
- the frontend is large and imports Tauri directly;
- live PTY continuity and incremental screen revisions are high-risk state.

Target split:

- the Rust semantic engine moves to a stable terminal capability under
  `core/backend`; it remains Tauri-free;
- `core/tauri` adapts the semantic protocol;
- the plugin owns terminal presentation, selection UX, paste policy UI, and
  feature workflow;
- the public terminal service exposes typed snapshots, monotonic revisions,
  credit, input, resize, history, anchors, and leases without exposing Tauri;
- PTY and semantic-screen resources are host-owned. Plugin activations attach
  through replaceable leases.

Deletion gate: delete all three module Rust crates and the Cargo/Tauri
projections only after replay, revision, backpressure, input, paste, resize,
anchor, detach/reattach, replacement, and packaged interactive proofs pass.
This is the final native extraction unless measured evidence supports an
earlier safe slice.

## Closure rule for every module

A module is complete only when its disposition record shows:

- one TypeScript artifact source under `modules/<id>/`;
- imports limited to the plugin API and declared external libraries;
- explicit required and provided service declarations, capability requests,
  and optional contribution declarations;
- Cordis activation and complete effect disposal;
- immutable artifact admission and live inspection;
- no Rust crate, Tauri command, ACL projection, Cargo feature, or static source
  import owned by that feature.
