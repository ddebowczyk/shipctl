# Current-to-target delta

<!-- markdownlint-disable MD013 -->

## Delta map

| Area | Current state | Target state | Bridge retained during migration | Deletion gate |
| --- | --- | --- | --- | --- |
| Frontend native access | Tauri imports in core host areas and seven modules | only `core/frontend/platform` imports Tauri | semantic adapters wrap existing commands | forbidden-import property passes for every plugin artifact and source package |
| Module membership | `ENABLED_MODULES` statically imports nine modules | desired registry and artifact manifests select plugins | static array feeds Cordis adapter first | all built-ins load through admitted artifacts and static profile tests have replacements |
| Application lifecycle | custom activate/deactivate plus restart-bound loader | Cordis activation per plugin instance, including headless work and optional presentation | adapt `ShipctlModule` to a Cordis entry | lifecycle conformance passes for headless and compound plugins and no caller uses legacy activation |
| Contributions | arrays read directly from module objects | activation-owned reversible registrations and immutable catalogs | adapter registers legacy arrays provisionally | candidate failure and disposal properties prove no partial or stale contribution |
| Native modules | seven Rust Tauri plugins under `modules/` | named providers under `core/backend` and `core/tauri` | old plugin commands remain behind semantic services | differential and authority tests pass; old feature and crate are removed |
| Plugin API | TS and Rust contracts share `module-api`; host service bag is partial | versioned public TS service and contribution contracts; private Rust wire types | evolve `module-api/` in place | plugins compile without Rust concepts, Tauri types, raw IPC, or host implementation paths |
| Runtime artifacts | immutable native-control artifacts, restart-bound browser bundles | immutable TypeScript application artifacts with optional UI and live add/replace/disable/remove | extend existing validator and loader | headless, compound, built-in, and installed plugins have one artifact format and activation path |
| Runtime reconcile | startup load mixed into static modules | candidate graph, readiness, atomic publish, last-good rollback | current runtime snapshot remains inspection input | generated transition histories converge without reload or partial state |
| Workspace | semantic canvas model with static contribution catalog | workspace reconciles live accepted catalog | existing canvas model and adapters remain | removed views recover safely and Layman/legacy adapters consume the same document |
| Agent operations | strong native registry and runtime snapshots; no full live application graph | desired/applied plugin, service, effect, grant, contribution, and lease inspection | extend current control protocol | CLI can inspect headless behavior and correlate visible contributions without UI scraping |
| Security | Tauri ACL at webview/plugin build level | activation-bound grants checked by semantic services and Rust | existing ACL remains defense in depth | every native call is attributable to admitted activation; no same-realm sandbox claim |

## `core/frontend` delta

### Preserve in core frontend

- capability-oriented directories;
- semantic terminal host ownership;
- normalized canvas model and replaceable renderer;
- current notice diagnostics and host error surfaces;
- tested panel, global surface, command, and message contracts.

### Add

- one semantic service adapter per native capability;
- a Cordis boundary adapter;
- activation identity and owned-effect tracking;
- provisional application-service providers, contribution registries, and
  accepted runtime snapshots;
- artifact graph reconciliation and runtime status projection;
- a semantic workspace service that consumes catalog snapshots.

### Change

- move Tauri imports from `shell`, `projects`, `terminal-host`, and `host` into
  `platform` adapters;
- split `MODULE_HOST_SERVICES` into named service providers bound through the
  plugin API and Cordis;
- remove default dependencies on `ENABLED_MODULES` from contribution queries;
- reduce `AppShell` to presentation startup and React composition; application
  plugin supervision belongs to the runtime outside the component tree.

### Do not do

- do not make permanent host mechanisms Cordis plugins without an independent
  lifecycle or replacement need;
- do not expose Zustand stores as services;
- do not make the canvas discover plugins;
- do not let plugins import the Layman adapter.

## `core/backend` delta

### Preserve in core backend

- Tauri independence;
- terminal resource authority;
- module-control artifact, registry, capability, diagnostic, and control
  contracts;
- message-bus ordering and grant enforcement;
- the standalone CLI-compatible capability shape.

### Add or absorb

- platform providers extracted from current module backends, starting with
  process/ports;
- activation-bound native authorization for semantic service calls;
- browser applied-revision and resource-lease facts needed by agent
  inspection;
- durable plugin data and resource scopes where current services are too broad.

### Separate

`module-api/backend` remains usable as a private Rust protocol crate during the
migration. Public plugin API compatibility must not imply that this Rust crate
is a user extension SDK.

## `core/tauri` delta

`core/tauri` becomes the only Rust framework adapter for all permanent native
capabilities. Current `modules/*/backend` command wrappers move here after their
Tauri-free logic has a named core owner. Command names remain private wire
details.

The adapter must bind requests to activation identity and pass only checked,
semantic inputs to `core/backend`. It must not contain feature workflows.

## `src-tauri` delta

The shell currently installs feature-gated Tauri plugins. During extraction,
it can register old and new commands behind mutually exclusive feature gates.
After each provider cutover, the module dependency and feature are removed.

The end state contains no per-plugin Rust dependency. It registers only stable
platform capability adapters and the Tauri plugins required by the permanent
host.

## `module-api` delta

### Evolve in place

- keep `protocol`, `host`, and `module` direction while names remain useful;
- add service contracts for Git, process inspection, scoped project files,
  assistant launch primitives, usage sources, and semantic terminal streams;
- add plugin manifest, activation, readiness, grants, contribution ownership,
  and inspection records;
- add provided and required application-service identities, versions, and
  lifecycle records;
- add Cordis context augmentation in a separate entry point;
- version all externally persisted or exchanged records.

### Split public from private

- TypeScript application-plugin contracts are public;
- private Tauri command and channel payloads live in trusted platform code;
- move terminal authority, driver registry and traits, durable-write
  coordination, snapshot-provider contracts, and terminal protocol values
  from `module-api/backend` to their owning `core/backend` capabilities;
- keep only Tauri wire adapters that are required under `core/tauri`;
- delete the `shipctl-module-api` Rust crate after its feature-module consumers
  and Cargo edges are gone;
- generated schemas may be shared, but public API names do not mirror command
  names merely for convenience.

### Rename later

Rename `module-api/` to `plugin-api/` only after no current Rust module uses it
as a conceptual module SDK and package consumers use stable public entry
points. Mixing a rename into service extraction would make review and rollback
harder without improving the boundary.

The end-state `module-api/` is TypeScript-only even if the directory keeps its
current name. “Rename later” does not permit the Rust compatibility crate to
remain.

## `modules` delta

Each feature follows the same strangler sequence:

1. characterize current behavior and errors;
2. define the public semantic service it needs;
3. add a trusted adapter over the existing command;
4. replace direct Tauri calls in the frontend;
5. adapt current contribution arrays to activation-owned registration;
6. build the TypeScript application plugin, with optional React presentation,
   as an immutable artifact;
7. move only platform-worthy native behavior to core;
8. move feature services, controllers, workflows, background work, and policy
   to TypeScript and namespaced plugin data;
9. prove parity and resource ownership;
10. remove the module Rust crates, Cargo feature, ACL projection, static import,
    and compatibility adapter.

At every intermediate point, the module remains usable. A feature does not
cross two major boundaries in one patch.

## `ops` delta

Add an `ops/architecture/` capability that owns:

- normative specification validation;
- dependency and artifact boundary checks;
- property-test dispatch and replay;
- architecture inspection snapshots;
- migration evidence validation;
- the final wall-closure proof.

It extends the current modularity checker rather than building a second import
scanner. Runtime code never imports `ops/`.

## No-regret rule

Every phase must leave one of these durable improvements:

- a clearer semantic contract;
- a stricter dependency rule;
- an independently testable adapter;
- a single authority for a resource;
- a reversible lifecycle;
- an immutable, inspectable snapshot;
- a deleted obsolete path.

A directory move, an adapter that only renames a raw command, or a second
registry without a deletion trigger does not satisfy this rule.
