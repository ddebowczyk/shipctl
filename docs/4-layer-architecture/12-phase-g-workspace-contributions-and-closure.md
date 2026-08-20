# Phase G: workspace contributions and wall closure

## Outcome

All built-in and installed views, menus, navigation items, commands, settings,
and other UI contributions flow from the accepted runtime catalog into the
semantic workspace and selected renderer. All remaining compatibility paths
are removed.

This phase makes Layman visibly useful for dynamic product modules without
making Layman a plugin API or workspace authority.

Phase G is the presentation plane of the Cordis application runtime. Headless
plugins do not need workspace entries, and their activation does not depend on
this phase. Compound plugins publish their optional presentation through this
plane while their services and background effects remain owned by the same
activation.

## Delivered foundation

The first vertical slice provides a renderer-neutral semantic workspace
contract, a validated immutable contribution catalog, a versioned document,
compare-and-save persistence, and a public semantic service with structured
inspection and observations. The authority accepts only an already admitted
catalog snapshot. It does not discover, load, authorize, or activate plugins.

The first integration slice now compiles a `WorkspaceContributionCatalog` for
each candidate runtime family before it is published. The compiler accepts
only active module contexts, records the owner module and activation for every
current UI contribution family, and produces two separate outputs:

- a renderer-neutral `WorkspaceCatalogSnapshot` for panels and global
  surfaces, which are current view-instance candidates; and
- a private `CanvasSurfaceCatalog` and renderer lookup for the selected canvas
  adapter.

`AppShell` now takes its current canvas surfaces from that accepted catalog,
not from its own direct static module list. Navigation, sidebars, project
layout, commands, project actions, and settings are also admitted with typed,
activation-owned records. They are not falsely represented as workspace view
definitions: each needs its own semantic descriptor and renderer projection.

The candidate compiler remains pure and runs before runtime publication. The
native message-route and declared-schedule transaction remains the one atomic
activation transaction. After that transaction commits, the host publishes its
service family and an `AcceptedWorkspaceCatalogController` serially reconciles
the semantic workspace from the accepted catalog. This one-way post-commit
step is intentional: including workspace compare-and-save in the native route
transaction would create a distributed commit across independent durable
authorities. A workspace persistence failure produces a workspace diagnostic;
it does not roll back routes, schedules, services, or the accepted family.

## Owner decision — 2026-08-19

**Owner:** Dariusz Debowczyk. **Selected policy:** retain the post-commit,
diagnostic-only workspace reconciliation model.

Activation succeeds when the native route and declared-schedule transaction
commits and the accepted runtime family is published. Workspace catalogue
reconciliation runs afterward, serially, and is not a veto point for that
success. If reconciliation or its durable compare-and-save fails, the host must
surface a structured workspace diagnostic while the accepted family, its
routes, schedules, and services remain active. Runtime inspection therefore
continues to show the accepted family; workspace inspection retains the last
successfully reconciled document (or bootstrap state) until a later accepted
catalogue can reconcile it. There is no activation rollback, unpublication, or
distributed recovery transaction.

This boundary keeps runtime publication and workspace persistence as separate
commit scopes. The workspace has one canonical durable authority: its own
generic plugin-data record. A `workspace plan`/`apply` batch is all-or-nothing
*within one workspace-document mutation*, but it neither participates in
activation nor changes the diagnostic-only result of catalogue reconciliation.

**Owner decision — view-local state (2026-08-19).** Dariusz Debowczyk selected
a layout-and-open-views-only shared workspace. View-local state, including
filters and drafts, belongs in the corresponding plugin's own plugin-data
namespace. The workspace document therefore removes the write-once `stateRef`
placeholder and view-state policy; legacy document-schema-v1 `stateRef` values
normalize away because no owning plugin key/schema/update path ever existed.

Semantic workspace documents are now schema-2 opaque values in the trusted
`shipctl.workspace` global plugin-data namespace, keyed as
`workspace-document:<workspaceId>`. Their `catalogRevision` stays inside that
owner value. The retired `workspace-documents.json` file is a read-only generic
legacy-record-map import source only: when no canonical record exists, the
workspace plugin migrates its v1 value once through plugin-data provenance, and
the resulting canonical record shadows the source thereafter. The former native
workspace document store and load/save commands are deleted. TypeScript
continues to validate the document grammar; it does not share Layman's raw
`workspace-layouts.json` snapshots, workspace IDs, or revision stream.

The shell activates the bundled workspace plugin, which owns its
`WorkspaceCanvasBridge`: a renderer-neutral projection of the authority's
current document plus serialized semantic commands. The default workspace
catalog intentionally contains no private host compatibility definition: a new
empty workspace renders the terminal state, and admitted panels or surfaces
enter only through semantic workspace commands.

The selected Layman adapter now projects semantic stacks, split shares, tabs,
floating windows, selected tabs, and recoverable missing views. It sends user
tab selection and permitted close actions back through the bridge. It does not
read or save `workspace-layouts.json`; the former raw Layman snapshot bridge
has been deleted, and no rollback path consumes it. The canonical
`shipctl.workspace` plugin-data record is the sole durable workspace state.

The standard and Layman adapters now project the same semantic workspace
authority directly. `StandardWorkspaceCanvas` renders the representable root
stack, preserves tab selection and permitted close actions, shows a mounted
terminal state for an empty document, and makes unsupported layouts explicit
instead of flattening them. Layman additionally projects its supported split
and floating layouts. Both adapters use the bridge and accepted contribution
catalog; neither reads raw renderer persistence. The legacy canvas and its
compatibility profile were retired through the separately authorized Phase H
parity gate. A Fast Check differential property continues to prove their
shared semantic subset.

Layman now accepts two structural user actions with exact semantic mappings.
A workspace tab can be dropped into the centre of another existing tiled
semantic stack; the adapter emits a `move` command that appends the instance to
the target stack. An eligible edge drop between existing tiled semantic stacks
emits a `split` command. Left and right map to the horizontal axis; top and
bottom map to the vertical axis. The edge determines whether the new stack is
before or after the target.

Layman can create a temporary local window while it applies an edge drop. That
window identity is renderer state only: the adapter discards it and sends only
the source instance, semantic target stack, axis, and position through the
bridge. The workspace authority allocates unused semantic split and stack
identities from the current document, then canonical projection replaces the
temporary renderer state. The authority remains responsible for selection,
document cleanup, persistence, and recovery after a failed save.

This is not full renderer-parity closure. The legacy adapter deliberately
rejects splits, floating stacks, and maximized stacks instead of flattening
them. Layman permits only eligible edge drops between semantic tiled stacks;
it still rejects root and floating targets, floating-window movement, resize,
and maximize operations. Those layouts and interactions remain open under
SEM-G-004 and SEM-G-005.

Panel migration aliases remain legacy tab-persistence kinds (for example,
`git`) and are intentionally not admitted as semantic workspace aliases. A
future persistence migration must convert them explicitly rather than mixing
two identity systems.

## Normative semantics

- **SEM-G-001:** The workspace consumes only accepted catalog snapshots and
  never discovers, loads, authorizes, or activates plugins.
- **SEM-G-002:** A view contribution declares semantic identity, metadata,
  scope, cardinality, placement intent, required capabilities, and a lazy view;
  it contains no Layman node.
- **SEM-G-003:** Removing a view definition never corrupts the workspace
  document; missing instances become explicit recoverable placeholders or are
  removed according to stated policy.
- **SEM-G-004:** Legacy and Layman adapters render the same semantic workspace
  document and invoke the same workspace actions.
- **SEM-G-005:** User layout mutations preserve valid document structure and
  can be reset to a deterministic default derived from the active catalog.
- **SEM-G-006:** Every live contribution registration is activation-owned and
  disappears after plugin removal without stale component or CSS references.
  A recoverable missing workspace record can retain historical owner identity,
  but that metadata cannot resolve a renderer, route, or service.
- **SEM-G-007:** Built-in and installed plugins use the same runtime path; no
  static module list, native feature module, or direct Tauri plugin dependency
  remains.
- **SEM-G-008:** The app boots and remains operable when any individual plugin
  is absent, disabled, incompatible, or broken.

## Workspace collaboration

```text
accepted runtime catalog snapshot
        |
        v
workspace reconcile command
        |
        v
versioned semantic workspace document
        |
        +--> standard canvas adapter
        |
        +--> Layman canvas adapter
```

The catalog tells the workspace what views exist. The workspace owns which
instances are open, their semantic positions, focus, grouping, and persisted
state. A canvas adapter translates those facts into renderer state and reports
user layout actions back as semantic commands.

Runtime ordering is deliberately:

```text
candidate activation and catalog compilation
        |
        v
atomic native route + schedule commit
        |
        v
host service-family publication
        |
        v
serial semantic workspace reconciliation and durable CAS
        |
        +--> later standard projection
        +--> later Layman projection
```

## Work

1. Complete the view contribution contract from the dynamic-workspace plan.
2. Move panel, global surface, navigation, project layout, settings, and command
   registries to one activation-owned catalog family while preserving distinct
   typed subregistries.
3. Reconcile catalog revisions into the semantic workspace service. **Delivered
   for accepted runtime families. Standard and Layman share a semantic
   single-stack projection; Layman also maps a tiled centre-drop between
   existing stacks to the semantic move command and an eligible tiled edge
   drop to the semantic split command.**
4. Replace the one-window compatibility renderer with projected semantic view
   instances, tabs, and terminal state. **Delivered:** the standard adapter is
   the default renderer, rejects layouts it cannot represent, and delegates
   semantic selection and close gestures through the bridge.
5. Keep the legacy canvas as a differential reference until the semantic
   projection is stable. **Completed:** the authorized Phase H parity gate
   retired the legacy renderer and its profile after standard/Layman evidence
   passed.
6. Persist the semantic workspace document in the bundled workspace plugin's
   generic plugin-data namespace. **Delivered.** One-way legacy import, replay,
   and stale-conflict proof now precede removal of the old native store and
   commands; the selected Layman runtime never starts raw snapshot persistence.
7. Consume the completed immutable-artifact catalog as the only feature-module
   source for workspace definitions and instances.
8. Keep compile-time feature membership empty and preserve the completed native
   module-crate deletion gates.
9. Make architecture, property, packaged-app, and control-plane proofs required
   release gates.

### Current supporting proof

`architecture.workspace-contribution-catalog.property` generates admitted
plugin subsets, retains a family across a registry-only revision, replaces
activation identities, and removes selected plugins. It proves catalog
admission and ownership cleanup only; it is not evidence for full mounted
component or stylesheet cleanup, which remains `PROP-G-CONTRIBUTION-CLEANUP-001`.

`acceptedWorkspaceCatalogController.test.ts` proves the post-commit path:
accepted catalogs persist, stale submissions do not regress the local runtime
stream, a matching restored catalog is not degraded by bootstrap revision zero,
and storage failure does not reject the accepted runtime family.

`pluginDataPersistence.test.ts` and the native legacy-record-map test prove the
one-way v1 workspace import, exact migration replay, and stale conflict behavior
of the canonical plugin-data record.

## Property cards

### PROP-G-WORKSPACE-001

- **Claim:** For every generated catalog and workspace history, reconciliation
  produces a valid document whose live view instances reference accepted view
  definitions or an explicit recoverable-missing record.
- **Shape:** state-machine.
- **Evidence:** SEM-G-001, SEM-G-003.
- **Domain:** view add, replace, disable, remove, re-enable, open, close, move,
  split, focus, and restore histories. Exclude pixel geometry.
- **Preconditions:** input catalog snapshots are accepted and revisioned.
- **Oracle:** a pure workspace model tracks definition and instance IDs and
  applies the documented missing-view policy.
- **Failure value:** disabling usage corrupts the layout and prevents terminal
  views from reopening.
- **Tier:** pull request and scheduled extended histories.
- **Initial status/test ID:** proposed / `architecture.workspace-reconcile.property`.

### PROP-G-RENDERER-001

- **Claim:** For every generated semantic workspace document in the shared
  subset, legacy and Layman adapter projections expose equivalent view
  identities, active view, tab order, and semantic actions.
- **Shape:** differential.
- **Evidence:** SEM-G-004.
- **Domain:** one-root-stack documents representable by both adapters,
  generated select and permitted-close actions, and missing-view placeholders.
  Exclude splits, floating stacks, maximized stacks, and pixel output.
- **Preconditions:** the workspace document passes schema validation.
- **Oracle:** compare normalized renderer projections and captured semantic
  action logs from independent adapter harnesses.
- **Failure value:** selecting a thin terminal in Layman routes focus back to a
  semantic terminal.
- **Tier:** pull request and browser integration.
- **Current status/test ID:** passing /
  `architecture.canvas-adapter-parity.property`. It covers the declared
  single-stack subset only; it is not evidence for split or floating parity.

### PROP-G-LAYMAN-MOVE-001

- **Claim:** A user center-drop from one tiled semantic stack into another
  emits exactly the semantic append move for the dropped instance; the local
  Layman tab membership matches the independent stack model.
- **Shape:** differential.
- **Evidence:** SEM-G-005.
- **Domain:** generated two-tiled-stack documents, selected source tabs,
  available and missing view placeholders, and target stacks with existing
  tabs. Exclude edge drops, root drops, floating stacks, resizing, and pixels.
- **Preconditions:** the workspace document passes schema validation and both
  stack IDs are renderer-derived semantic IDs.
- **Oracle:** compare the emitted action and Layman tab membership with a pure
  source-removal and target-append model; the model does not import Layman or
  workspace implementation code.
- **Failure value:** dragging a terminal changes only the renderer tree, or
  moves it into the wrong semantic stack.
- **Tier:** pull request.
- **Current status/test ID:** passing /
  `architecture.layman-semantic-move.property`. This is intentionally limited
  to existing tiled stacks; it is not evidence for split creation or floating
  movement.

### PROP-G-LAYMAN-SPLIT-001

- **Claim:** An eligible Layman edge drop between existing tiled semantic
  stacks emits exactly the semantic split direction for its edge. No temporary
  Layman window identity enters the semantic action or persisted document.
- **Shape:** differential and safety.
- **Evidence:** SEM-G-005.
- **Domain:** generated two-tiled-stack documents, selected source tabs, all
  four edge placements, and available or missing view placeholders. Exclude
  root and floating targets, floating-window movement, resizing, and pixels.
- **Preconditions:** the workspace document passes schema validation; the
  source view allows splitting; both stack IDs are renderer-derived semantic
  IDs.
- **Oracle:** compare the emitted action with a pure edge-to-axis-and-position
  table and assert the temporary Layman window has no semantic workspace ID.
  The table imports neither Layman nor workspace implementation code.
- **Alternative oracle:** route an ID-free split through the public bridge and
  require the workspace authority to allocate unique document identities;
  generated workspace histories validate the resulting tree independently.
- **Failure value:** a renderer-generated window ID becomes durable workspace
  state, or an edge creates a split on the wrong side of the target.
- **Tier:** pull request.
- **Current status/test ID:** passing /
  `architecture.layman-semantic-split.property`. It proves the declared tiled
  edge-drop subset only; it is not evidence for root, floating, resize, or
  maximize interactions.

### PROP-G-LAYOUT-001

- **Claim:** Persisting and restoring every generated valid workspace document
  preserves semantic view identity, topology, focus, and restorable state after
  canonical normalization.
- **Shape:** roundtrip.
- **Evidence:** SEM-G-005.
- **Domain:** generated splits, tabs, optional floating windows, sizes within
  schema bounds, open-view state, and missing definitions. Exclude physical
  monitor coordinates that migration policy normalizes.
- **Preconditions:** the source document is valid for its schema version.
- **Oracle:** retain the semantic source document and compare it with restored
  canonical state without using Layman serialization.
- **Failure value:** a restart changes project/terminal identity because the
  renderer tree was persisted as domain state.
- **Tier:** pull request.
- **Current status/test ID:** passing /
  `architecture.workspace-roundtrip.property`.

### PROP-G-WORKSPACE-OPERATIONS-001

- **Claim:** The rendererless public workspace service validates and plans
  without writes, exposes every retained semantic layout operation, and applies
  an ordered batch in one revision or leaves the document unchanged.
- **Shape:** safety and metamorphic.
- **Evidence:** SEM-G-005.
- **Domain:** validate, plan, apply, open, close, focus, select, move, split,
  rename, resize, float, dock, maximize, restore, reset, and stale-revision
  requests. Exclude renderer interaction and view-local plugin data.
- **Oracle:** compare dry-run output and revision with the later public apply;
  make a later batch step invalid and verify the earlier step was not committed.
- **Failure value:** an agent can partially save a planned layout.
- **Tier:** pull request.
- **Current status/test ID:** passing /
  `architecture.workspace-public-operations.property`.

### PROP-G-CONTRIBUTION-CLEANUP-001

- **Claim:** After every generated plugin removal, no live accepted catalog,
  mounted view, stylesheet, command route, menu item, navigation item, or
  component cache resolves the removed activation. A recoverable missing
  workspace record can retain historical owner identity only as inert metadata.
- **Shape:** conservation.
- **Evidence:** SEM-G-006.
- **Domain:** plugins contributing every UI family with open and closed views,
  replacement, failure, and removal. Exclude browser engine module-cache bytes
  that are unreachable and not observable by the host.
- **Preconditions:** removal transition settles.
- **Oracle:** the generated owner ledger lists all objects acquired by each
  activation and compares it with host inspection.
- **Failure value:** a removed plugin's stale menu item invokes a new plugin
  with the same contribution ID.
- **Tier:** pull request and browser integration.
- **Current status/test ID:** passing /
  `architecture.contribution-cleanup.property`. It checks every current UI
  contribution family plus route, subscription, stylesheet, and renderer-key
  canaries. Unreachable browser module-cache bytes remain outside the host
  contract.

### PROP-G-ABSENCE-001

- **Claim:** For every generated subset of built-in plugins, the host boots to
  an operable workspace using exactly that subset, makes no import request for
  an excluded package, and retains the accepted workspace after a failed
  candidate.
- **Shape:** safety.
- **Evidence:** SEM-G-007, SEM-G-008.
- **Domain:** empty, singleton, and mixed selections from the emitted built-in
  artifact templates, plus one injected load or readiness failure.
- **Preconditions:** required platform services are available.
- **Oracle:** compare accepted plugin IDs, contribution owners, and core
  workspace operability against the generated subset model. The execution path
  is the real live supervisor, message bridge, immutable artifact loader,
  Cordis activation, and workspace authority. A host-only URL/import adapter
  admits only the current catalog identities and provides no module
  implementation package.
- **Failure value:** a missing built-in package prevents the host from
  starting because a shell import still requires its package.
- **Tier:** pull request and release.
- **Current status/test ID:** passing /
  `architecture.plugin-absence.property`. It proves both injected load and
  readiness failures retain the last accepted catalog and leave the core
  workspace operable.

### PROP-G-CONTRIBUTION-SCHEMA-001

- **Claim:** Contribution admission accepts renderer-neutral semantic views and
  rejects declarations that embed a Layman node or another renderer detail.
- **Shape:** safety.
- **Evidence:** SEM-G-002.
- **Domain:** valid semantic view definitions plus one renderer-specific field,
  eager view, missing identity, or malformed lazy-view mutation.
- **Preconditions:** artifact and plugin identity have passed admission.
- **Oracle:** a closed renderer-neutral field model computes admission without
  importing a renderer or catalog implementation.
- **Failure value:** a plugin persists a Layman node and prevents projection by
  another renderer.
- **Tier:** pull request.
- **Initial status/test ID:** proposed /
  `architecture.workspace-contribution-schema.property`.

## Closure checks

The final architecture graph must prove:

- no module source or artifact imports Tauri, core, Layman, or another plugin;
- no Rust workspace member lives under `modules/`;
- no Rust crate remains under `module-api/`;
- no per-module Cargo feature or Tauri plugin dependency remains in
  `src-tauri`;
- no `ENABLED_MODULES` or equivalent static implementation list remains;
- all built-ins have immutable artifact identity and runtime inspection;
- all contributions have activation owners and disposal evidence;
- every native request has semantic service, activation, grant, and scope;
- workspace and renderer inspection use stable IDs and structured snapshots;
- the CLI can operate plugin lifecycle without UI scraping.

## Deletion gate

The legacy canvas was retired by the separate product decision recorded in
`DELETE-H-LEGACY-CANVAS`, after its standard/Layman parity evidence passed.
Remove static module composition, legacy activation, restart-only loading,
native module crates, and raw shims as part of this architecture closure
because their replacements are direct end-state requirements.
