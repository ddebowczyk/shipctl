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
- a private `CanvasSurfaceCatalog` and renderer lookup for the legacy canvas.

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

Semantic workspace documents now use a separate
`workspace-documents.json` store and Tauri load/save port. The store preserves
an opaque JSON-object document envelope with compare-and-save. TypeScript
continues to validate the document grammar. It does not share Layman's raw
`workspace-layouts.json` snapshots, their workspace ID, or their revision
stream. Bootstrap catalog revision zero is an explicit pre-runtime state; a
restored document is held unchanged until the first actual accepted catalog is
submitted.

The first renderer bridge is delivered. `AppShell` gives the selected canvas a
`WorkspaceCanvasBridge`: a renderer-neutral projection of the authority's
current document plus serialized `open`, `select`, `close`, `move`, and `split`
commands. The
accepted catalog always includes the host compatibility definition, so a new
workspace has a valid root view even before optional module views are opened.

The selected Layman adapter now projects semantic stacks, split shares, tabs,
floating windows, selected tabs, and recoverable missing views. It sends user
tab selection and permitted close actions back through the bridge. It does not
read or save `workspace-layouts.json`; the former raw Layman snapshot bridge is
retained only as an inactive migration and rollback artifact. The semantic
`workspace-documents.json` record remains the sole durable workspace state.

The legacy canvas is still the compatibility content and differential
reference. Its data adapter now projects and maps the same representable
semantic subset as Layman: one root tab stack, its order and selection,
missing-view state, and permitted select and close commands. In the live legacy
UI, the selected semantic global or panel view renders through the host ports
and a permitted close is forwarded through the bridge. Its existing tab strip
is not yet a semantic workspace tab strip, so live semantic selection remains
open. `AppShell` opens and closes global surfaces by using the semantic
document; the old UI-store route is only a startup fallback before the
workspace bridge exists. A Fast Check differential property proves the shared
adapter subset against Layman's real command gate.

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
- **SEM-G-006:** Every contribution registration is activation-owned and
  disappears after plugin removal without stale component or CSS references.
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
        +--> legacy canvas adapter
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
        +--> later legacy projection
        +--> later Layman projection
```

## Work

1. Complete the view contribution contract from the dynamic-workspace plan.
2. Move panel, global surface, navigation, project layout, settings, and command
   registries to one activation-owned catalog family while preserving distinct
   typed subregistries.
3. Reconcile catalog revisions into the semantic workspace service. **Delivered
   for accepted runtime families. The first Layman and legacy semantic
   single-stack projections are also delivered; wider layout parity remains.**
4. Replace the current one-window `LegacyCanvas` pane with projected semantic
   view instances, splits, tabs, floating windows, and focus operations as
   supported by the workspace document. **Started:** both adapters share a
   single-stack projection and select/close mapping; Layman also maps a tiled
   centre-drop between existing stacks to the semantic move command and an
   eligible tiled edge drop to the semantic split command. The live legacy
   route renders selected global and panel views and uses semantic close.
   Complete the semantic tab strip, layout rendering, and command support
   before removing the compatibility pane.
5. Keep the legacy canvas as a differential reference until the semantic
   projection is stable.
6. Persist the semantic workspace document through a separate Tauri port.
   **Delivered.** The selected Layman runtime no longer starts raw snapshot
   persistence. Keep the old snapshot conversion private and inactive until a
   tested migration or deletion decision removes it.
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
  schema bounds, plugin view state, and missing definitions. Exclude physical
  monitor coordinates that migration policy normalizes.
- **Preconditions:** the source document is valid for its schema version.
- **Oracle:** retain the semantic source document and compare it with restored
  canonical state without using Layman serialization.
- **Failure value:** a restart changes project/terminal identity because the
  renderer tree was persisted as domain state.
- **Tier:** pull request.
- **Initial status/test ID:** proposed / `architecture.workspace-roundtrip.property`.

### PROP-G-CONTRIBUTION-CLEANUP-001

- **Claim:** After every generated plugin removal, no accepted catalog, mounted
  view, stylesheet, command route, menu item, navigation item, or component
  cache references the removed activation.
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
- **Initial status/test ID:** proposed / `architecture.contribution-cleanup.property`.

### PROP-G-ABSENCE-001

- **Claim:** For every generated subset of built-in plugins, the host boots to
  an operable workspace using exactly that subset and reports each excluded or
  failed plugin without requiring its implementation package.
- **Shape:** safety.
- **Evidence:** SEM-G-007, SEM-G-008.
- **Domain:** all built-in inclusion subsets selected by generated admitted
  registries, plus one injected load or readiness failure. The campaign can
  sample subsets in normal lanes and enumerate them where the existing
  plug-out profile contract already requires enumeration.
- **Preconditions:** required platform services are available.
- **Oracle:** compare the accepted plugin IDs, contribution owners, and core
  workspace operability against the generated subset model.
- **Failure value:** removing Git prevents the host from starting because a
  shell import still requires its package.
- **Tier:** release, with focused pull-request fixtures.
- **Initial status/test ID:** proposed / `architecture.plugin-absence.property`.

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

Remove the legacy canvas only by a separate product decision after Layman has
the required behavior and rollback is no longer needed. Remove static module
composition, legacy activation, restart-only loading, native module crates,
and raw shims as part of this architecture closure because their replacements
are direct end-state requirements.
