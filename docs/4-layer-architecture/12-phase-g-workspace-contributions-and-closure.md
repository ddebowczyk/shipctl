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

## Work

1. Complete the view contribution contract from the dynamic-workspace plan.
2. Move panel, global surface, navigation, project layout, settings, and command
   registries to one activation-owned catalog family while preserving distinct
   typed subregistries.
3. Reconcile catalog revisions into the semantic workspace service.
4. Replace the current one-window `LegacyCanvas` pane with projected semantic
   view instances, splits, tabs, floating windows, and focus operations as
   supported by the workspace document.
5. Keep the legacy canvas as a differential reference until the semantic
   projection is stable.
6. Move Tauri layout transport behind `core/frontend/platform` and persist the
   semantic workspace document. Keep Layman snapshot conversion private to the
   Layman adapter while compatibility requires it.
7. Consume the completed immutable-artifact catalog as the only feature-module
   source for workspace definitions and instances.
8. Keep compile-time feature membership empty and preserve the completed native
   module-crate deletion gates.
9. Make architecture, property, packaged-app, and control-plane proofs required
   release gates.

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
  subset, legacy and Layman adapters expose equivalent visible view identities,
  active view, tab order, and semantic actions.
- **Shape:** differential.
- **Evidence:** SEM-G-004.
- **Domain:** documents representable by both adapters, generated focus and
  navigation actions, and missing-view placeholders. Exclude Layman-only
  floating geometry and pixel output.
- **Preconditions:** the workspace document passes schema validation.
- **Oracle:** compare normalized renderer projections and captured semantic
  action logs from independent adapter harnesses.
- **Failure value:** selecting a thin terminal in Layman routes focus back to a
  semantic terminal.
- **Tier:** pull request and browser integration.
- **Initial status/test ID:** proposed / `architecture.canvas-adapter-parity.property`.

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
