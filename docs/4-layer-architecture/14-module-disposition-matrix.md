# Module disposition matrix

<!-- markdownlint-disable MD013 -->

## Purpose

This document maps each current module to its target plugin and platform
capabilities. It prevents a directory move from deciding architecture by
accident.

The live repository has nine module manifests. All nine are frontend-only.
Permanent Rust providers and private Tauri adapters now live under `core/`.
The matrix separates the remaining TypeScript application-lifecycle work from
the completed native-provider extraction because they have different risk and
proof needs.

## Summary matrix

| Module | Current native shape | Target plugin ownership | Target platform services | Migration position |
| --- | --- | --- | --- | --- |
| `commands` | Frontend-only immutable artifact | Saved-command service, persistence policy, autostart, session tracking, commands, optional presentation | Terminal, contribution, and workspace command services | First compound Cordis and artifact pilot complete; live replacement remains |
| `ports` | Frontend-only; permanent process provider | Polling policy, port projection, commands, action wording, notices, optional UI | Scoped process inspection and termination | First native-provider slice complete |
| `thin-terminal` | Frontend-only immutable artifact | xterm view, terminal workflow, local presentation state | Terminal session, stream, input, and resize | First terminal presentation artifact complete |
| `todos` | Frontend-only immutable artifact; permanent project-document provider | TODO parsing policy, ordering, presentation, mutations, and preferences | Scoped project-document read/write, host project catalog, durable plugin data | Second native-provider and third artifact slice complete |
| `skills` | Frontend-only immutable artifact; permanent native provider | Catalog and source policy, setup workflow, commands, optional presentation | Approved skill installation operations and host project catalog | Fourth native-provider and fifth artifact slice complete |
| `git` | Frontend-only immutable artifact; permanent Git provider and watcher | Git projections, workflow, refresh policy, commands, optional UI | Scoped Git operations, project catalog, durable plugin data, and repository-change leases | Third native-provider and fourth artifact slice complete |
| `assistants` | Frontend-only immutable artifact; permanent launch and credential providers | Session services, provider orchestration, commands, labels, models, optional UI | Terminal/process, credentials, durable plugin data | Seventh native-provider and eighth artifact slice complete |
| `usage` | Frontend-only immutable artifact; permanent usage-source provider | Ingestion, normalization, aggregation, scheduled refresh, projections, optional dashboard | Approved source access, durable plugin data, scheduling and messages | Sixth native-provider and ninth artifact slice complete |
| `semantic-terminal` | Frontend-only immutable artifact; permanent native parser and authority provider | Semantic terminal view, interaction policy, presentation | Host terminal plus semantic screen protocol and durable anchors | Fifth native-provider and seventh artifact slice complete |

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

## Legacy host-service disposition

`ModuleHostServices` is a temporary compatibility bag, not a host capability
contract. The activation contract must replace each member through the target
below; no replacement may reintroduce a shared module-shaped service object.

| Legacy member | Target boundary | Owning migration | Deletion condition |
| --- | --- | --- | --- |
| `panels` | `shipctl.workspace@1` view and navigation contributions | workspace-service and frame work | contributed workspace commands replace imperative panel calls |
| `terminalSessions` | `shipctl.terminal-sessions@1` | existing semantic capability | every caller resolves the declared service from its activation |
| `terminalPresentation` | `shipctl.semantic-terminals@1` | existing semantic capability | presentation drivers bind through their declared service |
| `settings` | activation-derived plugin configuration namespace | configuration migration | module settings sections and project policy no longer consume the global settings bag |
| `skills` | `shipctl.skill-installation@1` | existing semantic capability | feature code resolves the declared service rather than a legacy alias |
| `appearance` | read-only `shipctl.appearance@1` semantic service | presentation-contract migration | appearance consumers use the declared projection without a store reference |
| `notices` | structured runtime diagnostics and notice sink | runtime extraction | candidate and accepted activations emit attributable diagnostic records |
| `externalLinks` | grant-checked desktop-links port | native-port migration | URL opening is authorized from the activation binding |

The last four rows deliberately identify their target capability rather than a
convenience wrapper. Their implementation remains sequenced with the named
migrations; the table is the deletion contract for the legacy bag.

## Legacy artifact adapter migration matrix

`staticPluginRuntime.ts` retains one module-private compatibility branch while
the existing immutable artifacts are converted. It is not a membership or
authorization path: an artifact is still selected only by admitted runtime
catalogue state. Each row below replaces that branch with a direct activation
entrypoint that registers the same declared contribution facts through the
activation-owned registries.

| Artifact | Declared role | Direct-activation task | Legacy adapter deletion condition |
| --- | --- | --- | --- |
| `shipctl.commands` | `compound` | `shep-2yc.12` | Direct command, project, layout, navigation, and terminal-presentation registrations match its admitted manifest. |
| `shipctl.ports` | `presentation` | `shep-2yc.13` | Direct navigation and global-surface registrations match its admitted manifest. |
| `shipctl.todos` | `compound` | `shep-2yc.14` | Direct project-document behavior and registered contributions match its admitted manifest. |
| `shipctl.git` | `compound` | `shep-2yc.15` | Direct Git service behavior and registered contributions match its admitted manifest. |
| `shipctl.skills` | `compound` | `shep-2yc.16` | Direct skill-installation behavior and registered contributions match its admitted manifest. |
| `shipctl.thin-terminal` | `presentation` | `shep-2yc.17` | Direct terminal-presentation registration and activation cleanup match its admitted manifest. |
| `shipctl.semantic-terminal` | `presentation` | `shep-2yc.18` | Direct semantic-terminal presentation and cleanup match its admitted manifest. |
| `shipctl.assistants` | `compound` | `shep-2yc.19` | Direct assistant behavior and registered contributions match its admitted manifest. |
| `shipctl.usage` | `compound` | `shep-2yc.20` | Direct usage schedules, messages, behavior, and registered contributions match its admitted manifest. |

The adapter, `ShipctlModule`, `ModuleHostServices`, and
`inferShipctlPluginRole` are deleted together only after all nine rows have
passed their direct-activation proof and the legacy host-service exception
ledger reaches zero. That deletion is the Step 08 closure, not an exception
that permits another static route.

## Shared Rust module API

`module-api/backend` is not a tenth product module. It is a leaf compatibility
crate created for the former native module model. No feature module uses it.
Core and its Tauri composition still use its terminal, snapshot, and
durable-write contracts.

Its target disposition is:

- terminal IDs, values, authority, driver registry, and driver traits move to
  the permanent terminal capability under `core/backend`;
- durable-write coordination moves to the permanent state or persistence
  capability that owns it;
- snapshot provider contracts move to the permanent state archive capability;
- Tauri-only wire mappings remain private under `core/tauri` when needed;
- the `shipctl-module-api` crate and all Cargo edges to it are deleted after
  the last native feature provider is extracted.

This is the remaining Phase D closure move. The public `module-api/frontend`
contract evolves independently.

## Commands

Current facts:

- the module is frontend-only;
- it is built as an immutable compound artifact and admitted through the common
  native repository and frontend loader;
- it has no static host import or root package dependency;
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

The Phase E deletion gate is complete. Cordis lifecycle, contribution parity,
disposal, immutable-artifact, embedded-startup, and packaged-app proofs pass.
Phase F owns live replacement without restart.

## Ports

Current facts:

- the module is frontend-only and uses the public Processes capability;
- process authority lives in `core/backend/src/processes/`;
- the private adapter lives in `core/tauri/src/processes.rs`.

Target split:

- `core/backend/src/processes/` owns portable process inspection and safe
  termination rules;
- `core/tauri/src/processes.rs` adapts those rules to Tauri;
- the plugin owns polling policy, port-oriented projections, filtering, labels,
  refresh behavior, commands, actions, notices, and optional UI;
- the public service uses an inspection identity so a reused PID cannot become
  a different termination target.

The Phase D deletion gate is complete. Process parity, identity, scope,
activation ownership, and native graph closure have replayable properties.
The Phase E deletion gate is also complete. Ports is packaged as a
presentation-only immutable artifact, declares `shipctl.processes@1`, and is
absent from static host composition. Differential properties cover navigation,
scan and filter policy, inspection denial, termination denial, service traces,
and idempotent disposal. Generated bundle inventory proves that the host seeds
the artifact as enabled at startup.

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

The Phase E deletion gate is complete. Thin Terminal is an immutable
presentation artifact that declares `shipctl.terminal-sessions@1`, attach,
input, and resize grants, and one terminal-presentation contribution. React is
host-supplied, xterm remains bundled, and its generated stylesheet is admitted
by digest and owned by the activation. Differential properties cover source
and artifact presentation identity and wrapper props. Existing focused tests
cover focus scheduling and raw-byte identity; the Terminal Sessions fake covers
key and paste attribution, resize ownership, exits, and attachment teardown.
The packaged proof creates a Thin Terminal through the application menu and
preserves its host-owned session across live module transitions.

## Todos

Current facts:

- the module is frontend-only and uses public Project Documents, Projects, and
  Plugin Data capabilities;
- it is built as an immutable compound artifact and has no static host import
  or root package dependency;
- scoped filesystem authority lives in `core/backend/src/project_documents/`;
- TODO parsing, ordering, mutation, and presentation remain in TypeScript.

Target split:

- the plugin owns TODO syntax interpretation, ordering, move rules, UI, and
  persisted preferences;
- a scoped project-document service owns authorized reads and atomic writes;
- a generic project catalog owns project identity and lifecycle events.

The Phase D deletion gate is complete. Document roundtrip, conflict, path
scope, atomic-write, activation ownership, and native graph closure have
replayable properties. Core contains no TODO policy. The Phase E deletion gate
is also complete. Todos directly declares `shipctl.project-documents@1`,
`shipctl.projects@1`, and `shipctl.plugin-data@1`; differential properties
cover contribution parity, persisted preference revisions, catalog and
filesystem lifecycle changes, document discovery success and denial, passive
CSS, and idempotent disposal. Generated bundle inventory proves that the host
seeds the artifact as enabled at startup.

## Skills

Current facts:

- the module is frontend-only and uses public Skill Installation and Projects
  capabilities;
- the Tauri-free provider lives in
  `core/backend/src/skill_installation/`;
- the private adapter lives in `core/tauri/src/skill_installation.rs`;
- the frontend uses public Skill Installation and Projects services through its
  module activation;
- the plugin owns the built-in catalog and Markdown sources;
- operations cross an authorized project filesystem boundary.

Target split:

- the plugin owns catalog identities and metadata, source selection, Markdown,
  setup workflow, commands, notices, and optional presentation;
- the platform capability owns registered-root authorization, source identity
  validation, safe directory traversal, atomic publication, rollback, and safe
  removal;
- the generic project catalog owns project identity and lifecycle events that
  keep the plugin cache current;
- grants identify allowed roots and operations. They do not expose an
  unrestricted filesystem bridge.

The Phase D deletion gate is complete. Traversal, scope, parity, atomic
installation, rollback, activation ownership, and native graph closure have
replayable properties. The Phase E deletion gate is also complete. Skills is a
DOM-free immutable compound artifact that directly declares
`shipctl.skill-installation@2` and `shipctl.projects@1`, registers its
project-action and skills-provider contributions, and owns its generic catalog
lease through `skills.runtime`. Generated discovery, refresh, install, remove,
denial, notice, cache-eviction, and disposal cases match the direct source
definition. The packaged app seeds and activates the artifact through the
common loader. The static host import and root dependency are deleted. Skills
does not declare Plugin Data because it owns no durable record; its Zustand
state is a cache of filesystem-backed capability results.

## Git

Current facts:

- the module is frontend-only and uses the public Git capability;
- scoped repository operations live in `core/backend/src/git/`;
- the private command adapter lives in `core/tauri/src/git.rs`;
- the trusted platform adapter owns the raw native change signal; Git receives
  scoped semantic repository-change leases and the generic project catalog.

Target split:

- `core/backend` owns Tauri-free, scoped Git execution and watcher resources;
- `core/tauri` owns command and event transport;
- the plugin owns Git projections, workflow, refresh policy, wording, commands,
  and optional views;
- a semantic event subscription service replaces raw Tauri event names and
  returns an activation-owned lease; plugin-data owns persisted preferences.

The Phase D deletion gate is complete. Command parity, repository scope,
activation access, event ordering, subscription disposal, and native graph
closure have replayable properties. The Phase E gate is also complete. Git now
declares `shipctl.git@1`, `shipctl.projects@1`, and `shipctl.plugin-data@1` with
eight contribution families in an immutable artifact. Differential properties
cover refresh success and denial, clean and dirty project facts, worktree
preferences and expansion, catalog and repository-change lifecycle, service
traces, and repeated disposal. The static host import and root package
dependency are deleted.

## Assistants

Current facts:

- the module is frontend-only and uses the Assistant Launch and Credential
  Store capabilities;
- launch and recovery authority lives in `core/backend/src/assistant_launch/`;
- credential authority and non-disclosure live in
  `core/backend/src/credentials/`;
- private Tauri adapters contain transport only;
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

The Phase D deletion gate is complete. Launch and credential parity, native
authority, activation disposal, durable-resource ownership, credential
non-disclosure, and native graph closure have replayable properties.

The Phase E deletion gate is complete. Assistants is an immutable compound
artifact with no static host import or root package dependency. Its manifest
declares the five services used by current code: Assistant Launch, Credential
Store, Processes, Terminal Sessions, and Projects. The `assistants.runtime`
effect owns project-catalog and terminal lifecycle subscriptions without a
workspace grant. It requests the exact six grants for assistant launch and
records, credential inspection and writes, and terminal start and attachment.
Differential properties preserve the launcher panel, restore warning, shutdown
preparation, semantic service results and traces, activation subscription, and
repeated disposal. Plugin Data and Workspace stay target capabilities until the
module consumes their public contracts.

## Usage

Current facts:

- the module is frontend-only and uses Usage Sources, Plugin Data, Scheduler,
  and Messages capabilities;
- approved source and credential authority, normalized source facts, SQLite
  persistence, and snapshots live in `core/backend/src/usage_sources/`;
- pricing, aliases, aggregation, projections, refresh policy, and presentation
  live in TypeScript.

Target split:

- the plugin owns provider-specific ingestion, parsing, normalization,
  aggregation, pricing interpretation, scheduled refresh, projections, and
  optional dashboard views;
- platform services expose reviewed source readers, namespaced durable plugin
  data, scheduler leases, and typed messages;
- the current database migrates only after its schema authority and recovery
  rules are explicit. A private compatibility adapter can keep the old schema
  during the move.

The Phase D deletion gate is complete. Source parity, authority, redaction,
durable-record ownership, TypeScript policy ownership, and native graph
closure have replayable properties.

The Phase E deletion gate is also complete. Usage is a direct immutable
compound artifact with no static host import, static module wrapper, or root
package dependency. Its manifest declares the four services used by current
code: Usage Sources, Plugin Data, Messages, and Scheduler. Its
`usage.runtime` effect owns the semantic source observer and global-store
adapters. It requests the exact nine grants for source reads, refresh and
observation, settings reads and writes, message publication, subscription and
directed refresh, and schedule registration. Differential properties and the
direct lifecycle fixture preserve settings access, source ingestion and
observation, scheduled message delivery, presentation loaders, denied-grant
withdrawal, runtime inspection, and repeated disposal. Credential Store stays
private behind the native Usage Sources provider. Workspace stays a target
capability until the module consumes its public contract.

## Semantic terminal

Current facts:

- the module is frontend-only and uses the public Semantic Terminal capability;
- the substantial Rust semantic engine lives in
  `core/backend/src/semantic_terminal/`;
- the private adapter lives in `core/tauri/src/semantic_terminal.rs`;
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

The Phase D deletion gate is complete. Replay, revision, backpressure, input,
paste, resize, anchor, detach/reattach, activation disposal, PTY continuity,
and native graph closure have replayable properties.

The Phase E deletion gate is also complete. Semantic Terminal is a direct
immutable presentation artifact with no static host import or root package
dependency. Its activation declares `shipctl.terminal-sessions@1`,
`shipctl.semantic-terminals@1`, its six existing grants, and one
terminal-presentation contribution. The artifact property compares source and
admitted direct registrations, wrapper props, service binding, passive import,
stylesheet ownership, and repeated disposal. The existing 66 focused
interaction tests cover attachment, flow control, input, history, anchors,
selection, paste, resize, recovery, focus, and teardown.
The packaged proof creates a Semantic Terminal through the application menu,
writes through the real PTY before and after live module transitions, and
preserves its host-owned identity beside a running Thin Terminal.

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
