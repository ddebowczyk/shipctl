# Four-layer architecture migration

## Status

The architecture is approved and implementation is in progress under epic
`shep-vut`. The executable authority is
[`spec/program.yaml`](spec/program.yaml). Its indexed phase, capability, and
module-disposition records are schema-validated before implementation work.
Phase A is complete: the repository has passive entrypoint enforcement, a
reviewed source and legacy-composition baseline, and replayable TypeScript and
Rust property evidence. The Phase B foundation is implemented: public semantic
service and activation contracts, a trusted lifecycle registry, a Tauri-free
test host, request/event/stream test controls, and an import ratchet now exist.
Capability migrations are in progress. An exact ledger contains the existing
non-platform Tauri imports; any new non-platform Tauri import fails the boundary
check. Ports, Todos, Git, Skills, Semantic Terminal, Usage, and Assistants have
completed native provider extraction: their Rust module crates, Cargo features,
plugin registrations, and ACL projections are deleted, while their TypeScript
feature modules use permanent native core providers through private adapters.
Skills supplies its
catalog and Markdown from TypeScript to a generic native installation
capability. Semantic Terminal keeps its parser and activation-scoped native
authority in Tauri-free core while its TypeScript module owns presentation and
interaction policy. Their direct module Tauri clients and dependencies are
gone. Usage consumes the semantic Usage Sources service; its direct Tauri
client and dependency are gone. Assistant launch, recovery, configuration, and
credential operations use the Assistant Launch and Credential Store services.
Usage settings and Commands saved commands now use
the Plugin Data service. The native Usage host reads its owned settings through
the same durable store. The former broad global and project data host ports are
deleted. Typed Messages now resolves through `shipctl.messages@1`; the optional
parallel `ModuleHost.messages` path is deleted, and activation disposal removes
frontend handlers immediately. The legacy-import ledger has fallen from 24
entries to 16. Scheduler is now exposed as `shipctl.scheduler@1`: Usage declares
a typed cron target, while the native host owns clocks, persistence, target
preflight, delivery observations, cancellation, and activation cleanup. The
old browser interval scheduler is deleted.
Terminal sessions are now exposed as `shipctl.terminal-sessions@1`. Thin and
semantic terminal presentations receive this service through their exact
module activation instead of receiving the trusted raw-terminal host port.
The thin presentation uses activation-owned byte attachments, explicit stream
credit and acknowledgement, attachment-owned input and resize, and ordered
key and paste requests. The semantic presentation uses its separate public
screen protocol through an attributed private adapter. Its direct module Tauri
client is deleted; the raw PTY session contract remains separate.
The immutable artifact foundation is also implemented. Native admission checks
closed manifests, complete content digests, compatibility, and runtime
declarations before activation. The frontend loader supplies host singleton
identities and activates admitted code through the same Cordis lifecycle used
by built-ins. `commands`, `ports`, `todos`, `git`, `skills`, `thin-terminal`,
`semantic-terminal`, `assistants`, and `usage` are cut over: the app seeds their
artifacts, loads them
by digest, and has no static host import or root package dependency for these
modules. Skills remains DOM-free and declares only the public Skill
Installation service; its project state is a render cache, not a durable Plugin
Data record. Thin Terminal supplies the first artifact-owned stylesheet and
declares only Terminal Sessions plus its three attachment grants. Semantic
Terminal declares Terminal Sessions, Semantic Terminals, its six grants, and
one terminal presentation. Neither terminal has a static host import.
Assistants declares Assistant Launch, Credential Store, Processes, and Terminal
Sessions, its six grants, and one compound launcher panel. It has no static host
import or root package dependency.
Usage declares Usage Sources, Plugin Data, Messages, and Scheduler, its exact
nine grants, and six compound contributions. Its stylesheet, global surface,
navigation, sidebar, settings view, schedule, and message graph are owned by the
artifact. It has no static host import or root package dependency. No feature
module remains in the compile-time frontend profile.
Phase F live reconciliation is complete. Installed artifact revisions now
drive private Cordis candidates, atomic publication, last-good recovery,
structured operation inspection, and ordered disposal without a webview
restart. A packaged proof preserves running Thin and Semantic terminals across
live enable and remove, then confirms cold-start parity from the durable removal
tombstone. Phase G workspace closure remains.

The source architecture decision is the ignored working note at
`docs/plans/terget-4-layered-architecture.md`. This tracked document set is
self-contained and restates every decision needed to execute the migration.

## Contract

Shipctl must evolve from build-selected Rust and TypeScript modules to four
layers with one-way authority:

1. a closed Rust/Tauri native kernel;
2. a permanent trusted TypeScript application host;
3. a versioned TypeScript plugin API;
4. TypeScript-only Cordis plugins.

The migration must preserve current behavior while it makes module install,
activation, contribution, replacement, disposal, and inspection dynamic. It
must not require a large UI rewrite or move feature policy into core merely to
remove a Rust crate from `modules/`.

The acceptance contract is complete when the end-state proofs in
[Verification, cutover, and rollback](13-verification-cutover-and-rollback.md)
all pass. Before then, every phase must leave a smaller and better-defined
system even if later work stops.

## Decision in one page

- `core/backend` remains Tauri-free Rust capability logic.
- `core/tauri` remains the private Rust/Tauri adapter layer.
- `src-tauri` remains the bundle and composition shell required by Tauri.
- `core/frontend/platform` becomes the only frontend location that imports
  `@tauri-apps/*`.
- `core/frontend/runtime` owns the Cordis application root, application-service
  graph, activation identities, artifact loading, candidate graphs, and
  reconciliation. It initially executes in the main webview.
- `core/frontend/workspace` owns the semantic workspace document.
- `core/frontend/canvas` remains a replaceable rendering boundary. Only its
  Layman adapter imports Layman.
- `module-api/` evolves in place into the public TypeScript plugin contract.
  A rename to `plugin-api/` is deferred until the contract is stable.
- `modules/<name>/` ends as a TypeScript artifact source with optional React
  presentation. It contains no Rust crate and no direct Tauri import.
- Native work now found under a module moves to a named platform capability
  only when it needs OS authority, durable cross-plugin ownership, or native
  enforcement. Feature policy remains in the plugin.
- Built-in and installed plugins use the same immutable artifact and lifecycle
  path.
- Cordis controls TypeScript application composition, service dependencies,
  and effect lifetime. Plugins can be headless, presentation-only, or
  compound. Cordis does not become the native kernel, workspace model,
  permission system, or security sandbox.

## First no-regret move

Close direct Tauri access from feature frontends. Add semantic service ports to
`module-api/`, implement them in `core/frontend/platform`, and migrate one
module client at a time. Keep current Rust commands in place during this step.

This move is independent of Cordis, Layman, and dynamic artifact loading. It
gives DOM-free tests for headless behavior, browser tests for presentation, and
a real Chinese wall immediately. Directory moves follow proven service seams;
they do not create those seams.

## Plan map

| Document | Question answered |
| --- | --- |
| [01](01-current-state-and-evidence.md) | What exists now, and what evidence supports the plan? |
| [02](02-target-boundaries-and-collaboration.md) | What owns authority and how do the four layers collaborate? |
| [03](03-current-to-target-delta.md) | What must change in each current repository area? |
| [04](04-architecture-debt-and-priority.md) | Which decay risks make the migration necessary and in what order? |
| [05](05-specification-and-property-method.md) | How are semantics, property cards, generators, oracles, and evidence recorded? |
| [06](06-phase-a-contract-and-enforcement-foundation.md) | How do we establish executable architecture contracts without changing behavior? |
| [07](07-phase-b-semantic-service-wall.md) | How do we close direct Tauri access from modules? |
| [08](08-phase-c-cordis-static-composition.md) | How does Cordis first own lifecycle without dynamic loading? |
| [09](09-phase-d-native-provider-extraction.md) | How do Rust-backed modules become platform capabilities plus TS plugins? |
| [10](10-phase-e-immutable-plugin-artifacts.md) | How do built-ins enter the real artifact path? |
| [11](11-phase-f-live-reconciliation.md) | How do add, replace, disable, and remove become atomic live operations? |
| [12](12-phase-g-workspace-contributions-and-closure.md) | How do dynamic views reach Layman and how is the wall closed? |
| [13](13-verification-cutover-and-rollback.md) | What proves each cutover and protects rollback? |
| [14](14-module-disposition-matrix.md) | What is the proposed destination of each current module? |
| [15](15-artifacts-repository-layout-and-agent-ops.md) | Which durable specifications, checks, test artifacts, and agent commands are needed? |
| [16](16-execution-graph-and-task-contracts.md) | What is the dependency order and how will implementation tasks be formed? |
| [17](17-decisions-risks-and-review.md) | Which choices are fixed, deferred, or require reviewer approval? |
| [18](18-property-oracle-review.md) | What second oracle can challenge each property and how can both oracles fail? |
| [19](19-requirement-traceability.md) | Where is every requested and target-architecture obligation planned and later proved? |
| [20](20-cordis-application-runtime-and-plugin-roles.md) | How can Cordis plugins own backend and frontend responsibilities without crossing the native wall? |

## Execution gate

The approved execution contract fixes these points:

- the four authority layers and one-way dependency rule;
- the semantic service wall as the first runtime change;
- Cordis behind a Shipctl-owned adapter and pinned source revision;
- headless, presentation-only, and compound plugins under one activation
  model;
- `commands` as the first compound Cordis plugin, a headless service fixture,
  and `ports` as the first native split;
- the proposed disposition of feature policy in each Rust-backed module;
- same-realm, reviewed plugins as the initial trust tier;
- the property specification format and proof requirements;
- the oracle candidates and their known blind spots;
- the execution graph and deletion gates.

Tasks under `shep-vut` cite their semantics, property IDs, compatibility paths,
and deletion gates. Run `just architecture all` to validate the indexed record
graph and its generated negative tests before a task changes runtime behavior.

## Terminology

- **Native kernel:** layers in Rust that own OS authority and durable native
  resources.
- **Trusted application host:** permanent TypeScript code that owns Tauri
  adapters, the Cordis application graph, headless plugin effects, catalogs,
  workspace state, and optional React composition. It initially runs in the
  main webview.
- **Plugin API:** public TypeScript meaning with no host implementation or
  Tauri type.
- **Plugin:** a TypeScript-only Cordis application activation and its immutable
  artifact. It can be headless, presentation-only, or compound.
- **Platform capability provider:** a vertical native-to-TypeScript service.
  It is not a dynamically loaded plugin.
- **Provided service:** an application contract implemented by a plugin or a
  permanent platform adapter and published through Cordis.
- **Contribution:** a reversible plugin-owned registration such as a command,
  view, menu item, or setting. Contributions are optional.
- **Catalog snapshot:** one validated immutable set of active contributions.
- **Activation:** one versioned plugin instance and all effects that it owns.
