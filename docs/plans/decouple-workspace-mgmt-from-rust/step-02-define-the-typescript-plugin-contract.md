<!-- markdownlint-disable MD013 -->

# Step 02 — Define the TypeScript plugin contract

## Outcome

Replace the host-shaped ShipctlModule and ModuleHostServices relationship with
a small public TypeScript plugin contract. The contract lets a Cordis plugin
provide and consume named semantic services, contribute declarative metadata,
register lifecycle-owned effects, and optionally supply presentation content.
It must support background-only plugins as first-class citizens.

Cordis remains a private runtime implementation detail. Plugins program to
module-api contracts, not to Cordis classes, containers, or lifecycle types.
This preserves the ability to change the composition library without changing
all plugins.

## Why the current contract cannot be the end state

ShipctlModule currently makes a module describe unrelated concerns in one
static object: panels, global surfaces, menus, navigation, settings, skills,
scheduled work, messages, terminal presentation, and lifecycle hooks.
ModuleHostServices supplies a similarly broad bag. Although this avoids raw
Tauri imports, it still forces features to know the host's rendering and
service assembly shape.

The replacement should not merely rename the two types. It must make authority,
ownership, and optional presentation explicit.

## Proposed public concepts

The names below are design-level names; implementation may choose idiomatic
TypeScript spelling after an API review.

| Concept | Responsibility |
| --- | --- |
| Plugin identity | Stable id, version, provenance, declared role, compatibility range, and required grants. |
| Plugin context | A narrow object received at activation that resolves declared semantic services and registers owned outputs. |
| Service contract | A TypeScript interface plus a stable service id, provider version, request semantics, and error contract. |
| Contribution registry | Registration APIs for views, menus, navigation, commands, settings schemas, routes, schedules, and operation providers. |
| Effect scope | Owns subscriptions, background loops, message handlers, and schedules; disposal is mandatory and observable. |
| Capability grant | Admission-time permission for a native-backed semantic service, never an opaque native handle. |
| Artifact manifest | Passive, inspectable metadata for admission, dependency solving, and offline discovery. |

The plugin-facing activation contract should allow a plugin to:

1. resolve only services it declares as required;
2. register only contribution families it is allowed to provide;
3. provide semantic services for other plugins;
4. register background effects with explicit disposal;
5. report structured diagnostics under its identity; and
6. operate without React, Layman, or a rendered window.

React view bodies may be contributed as a peer dependency of the presentation
surface. They must not receive the application runtime, a Tauri object, or a
Layman instance as a shortcut around semantic APIs.

## Contributions: facts in manifests, behavior at activation

Manifests need enough declarative information to inspect a candidate before
executing it: plugin id/version, dependencies, provided service ids, requested
grants, declared roles, configuration namespaces, and stable contribution ids.
Runtime activation supplies the executable behavior and validates that it
matches the manifest.

For example, a workspace view contribution should declare a stable view id,
title metadata, singleton or multiplicity policy, and capability requirements.
Its live view body is registered only after the candidate graph is admitted.
Likewise, a schedule declaration may name an id and policy in the manifest,
while its handler is registered from the accepted runtime graph.

This split enables inspection and planning without pretending that arbitrary
plugin code can be evaluated safely during manifest parsing.

## Compatibility strategy

Keep an adapter from the legacy ShipctlModule object to the new contract while
individual built-ins migrate. The adapter must:

- be private to core/frontend/runtime/cordis or a migration package;
- map each legacy contribution family explicitly;
- reject unsupported implicit authority rather than growing a catch-all bag;
- have a module-by-module migration matrix; and
- be deleted after the final built-in no longer uses it.

Do not publish the adapter through module-api. Doing so would fossilize the
legacy host model as the extension API.

## Refactoring actions

1. Define public contracts and stable ids in module-api/frontend, with no
   imports from core, platform, Tauri, React implementation details, or Cordis.
2. Introduce an artifact-manifest schema and a runtime-to-manifest consistency
   validator.
3. Add a plugin context backed by a resolved, grant-filtered service registry.
4. Add typed contribution registries rather than one mutable host service bag.
5. Wrap existing ShipctlModule entries through a temporary adapter.
6. Convert one headless-capable plugin first, preferably a small command or
   todo-style module, to prove that React is optional.
7. Convert one presentation plugin second to prove view registration does not
   need direct host ownership.

## Validation and exit criteria

- A plugin can be activated in a test without a React renderer or a Tauri
  backend.
- An undeclared service request and an ungranted native-backed service request
  fail with a structured, attributable error.
- Candidate activation is transactional: no contribution, message route,
  schedule, or effect is published when validation fails.
- Manifest/runtime contribution ids, roles, and required services match.
- Legacy modules still work through the private adapter, but no new feature is
  allowed to use it.
- The public declaration output of module-api contains neither Cordis nor Tauri
  types.
