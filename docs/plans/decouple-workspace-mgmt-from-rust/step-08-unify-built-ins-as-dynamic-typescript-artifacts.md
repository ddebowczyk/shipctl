<!-- markdownlint-disable MD013 -->

# Step 08 — Unify built-ins as dynamic TypeScript artifacts

## Outcome

Convert Shipctl's existing feature packages into direct TypeScript plugin
artifacts that use the public plugin contract. Built-ins continue to be bundled
and trusted, but they travel through the same discovery, admission, activation,
contribution, diagnostics, configuration, and deactivation path as an installed
plugin.

This is where “modules are dynamic and removable” becomes real. A module must
not depend on a static AppShell list, a host-specific workspace adapter, or a
privileged Rust view path to function.

## Current feature migration inventory

The current artifact wrappers already describe role and required services, but
wrap legacy ShipctlModule values. The target is a direct artifact entrypoint
using the Step 02 plugin context and registries.

| Module | Present role | Required semantic services | Target contribution focus |
| --- | --- | --- | --- |
| assistants | compound | assistant launch, credentials, processes, terminal sessions | assistant workflow, sessions views, actions, configuration |
| commands | compound, frontend-only | plugin data | command catalogue, background/action providers |
| git | compound | Git | repository views, commands, project workflow |
| ports | presentation | processes | ports view and navigation/menu contributions |
| semantic-terminal | presentation | terminal sessions, semantic terminal | semantic terminal views and presentation policy |
| skills | compound | skill installation | skills workflow, settings, commands and views |
| thin-terminal | presentation | terminal sessions | thin terminal views and presentation policy |
| todos | compound | project documents | project todo views, commands, configuration |
| usage | compound | usage sources, plugin data, messages, scheduler | data policy, background work, views, settings and schedules |

The list is deliberately not a promise that all features have the same shape.
For example, commands may be useful with no presentation contribution, while
ports may initially be presentation-only. The direct artifact contract must
preserve this distinction rather than forcing a panel everywhere.

## Artifact content and admission

Each artifact needs:

- a passive manifest: identity, version, compatibility, role, requested
  services/grants, provided services, configuration namespace, and stable
  contribution ids;
- a TypeScript entrypoint exporting a direct plugin definition;
- optional view chunks or assets referenced through an approved artifact loader;
- integrity/provenance metadata appropriate to bundled versus installed code;
- diagnostics metadata that identifies its source and effective version.

The artifact manifest is not a second copy of runtime behavior. It is an
admission and inspection document. Runtime activation must validate that the
entrypoint registered only the declared identities and used only declared
authority.

## Migration order

Convert modules one at a time behind the legacy adapter:

1. A small non-presentation module demonstrates headless activation, operation
   registration, and configuration with no React dependency.
2. A simple presentation module demonstrates direct view registration and
   workspace catalogue appearance.
3. Terminal modules demonstrate high-frequency presentation while keeping
   native session operations behind typed ports.
4. Assistants and usage demonstrate compound behavior: settings, schedules,
   messages, background effects, and multiple views.
5. Remove the legacy adapter only after the final built-in has moved.

Each conversion should preserve artifact identity and public behavior unless a
separate user-facing change is explicitly approved. This avoids conflating
platform migration with feature redesign.

## Prevent hidden host dependencies

After conversion, a module may import:

- its own package;
- stable module-api frontend entrypoints;
- explicitly permitted shared pure TypeScript libraries; and
- React only for a declared presentation body.

It may not import:

- core/frontend private paths or stores;
- core/frontend/platform adapters;
- AppShell, canvas adapters, or Layman;
- raw Tauri packages or invoke commands;
- another module's private path.

Cross-plugin collaboration must use a declared public service contract. A view
asking the workspace service to open or focus a view is acceptable; importing
the workspace authority implementation is not.

## Deactivation and replacement behavior

Dynamic artifacts need reliable transitions. When a module is disabled,
upgraded, replaced, or rejected:

1. the runtime validates the candidate graph before changing the accepted one;
2. workspace receives the accepted catalogue revision, not a partial list;
3. view instances enter the unavailable/recovery state if their definition
   disappears;
4. effects, schedules, and routes are disposed atomically with the old graph;
5. diagnostics record old/new identity, cause, and recovery action.

No feature should be able to leave an old schedule, route, terminal
presentation handler, or menu contribution active after it is no longer in the
accepted graph.

## Refactoring actions

1. Extend artifact manifests and loader validation for Step 02 contract data.
2. Introduce direct artifact entrypoints alongside legacy wrapper entrypoints.
3. Convert modules in the migration order above, adding focused contract tests
   for each capability family.
4. Move static visual lists into accepted contribution registries and workspace
   profiles.
5. Replace static enabled-module assumptions with explicit artifact source and
   admission configuration.
6. Verify bundled artifacts can be inspected without activating their views.
7. Delete the legacy ShipctlModule adapter, related contribution conversion,
   and obsolete test fixtures when their last consumers are gone.

## Validation and exit criteria

- Every bundled module is discoverable and inspectable as an artifact.
- No built-in module imports private core or platform code.
- Disabling a module cannot leave stale contributions, schedules, routes, or
  effect handles in the accepted runtime.
- At least one module activates and exposes useful operations in the headless
  runtime.
- At least one view from each presentation-capable module can be added to a
  workspace profile through its declared view identity.
- The compatibility adapter has zero production users and is removed.
