<!-- markdownlint-disable MD013 -->

# Step 05 — Move configuration and persistence policy to TypeScript

## Outcome

Move configuration grammar, defaults, validation, migrations, and workspace
interpretation from Rust into the TypeScript application runtime and plugins.
Retain only generic durable-document mechanics in Rust. This makes config
inspectable and evolvable by plugins and usable by the future headless runtime
without duplicating product semantics in the lean Rust CLI.

## The separation to preserve

The native kernel should provide a generic revisioned document facility:

- namespaced document identifiers;
- opaque JSON or bytes payloads;
- current revision, origin, and compare-and-swap write;
- atomic persistence, backup/recovery, and transaction primitives where needed;
- a platform-defined configuration root and migration-safe file access.

The TypeScript runtime should provide:

- schema and human-readable configuration grammar;
- defaults and layered resolution;
- plugin-owned namespaces;
- semantic validation and migration;
- inspect, validate, plan, apply, and rollback-oriented operations;
- user-facing diagnostics and configuration provenance.

Native code must not parse or select a UI canvas, workspace profile, panel
position, sidebar side, module enablement policy, or feature setting merely
because the file happens to be located under the application configuration
directory.

## Current-to-target mapping

| Current implementation | Target | Migration decision |
| --- | --- | --- |
| core/backend/src/workspace/config.rs CanvasAdapter and UiSettings | TypeScript configuration service and workspace/plugin schemas | Read legacy settings once, translate to a versioned TypeScript-owned document, then stop writing native UI config. |
| core/backend/src/state/workspace_document.rs workspace-shaped record | generic native durable document CAS | Retain revision mechanics; remove workspace names and payload interpretation from the kernel API. |
| core/backend/src/state/workspace_layout.rs raw Layman snapshots | legacy importer only, then delete | Do not make renderer snapshots canonical. Import once to a semantic document if support is worthwhile. |
| core/frontend/platform/workspacePersistence.ts named workspace commands | generic durable document port | Workspace service uses a namespace/id/revision contract. |
| src/main.tsx native canvas adapter selection | TypeScript bootstrap/profile selection | Native bootstrap launches the runtime; runtime selects compatible renderer/plugin profile. |
| feature-specific settings in host wiring | plugin configuration contributions | Each plugin owns schema/defaults/migration for its namespace. |

## Configuration document model

Use a small number of durable document families, rather than one global
untyped configuration object:

| Family | Owner | Examples |
| --- | --- | --- |
| host bootstrap | trusted TypeScript runtime | enabled artifact sources, trust/admission policy, selected user profile |
| workspace profile | workspace plugin | layout tree, view instances, frame and navigation preferences |
| plugin configuration | individual plugin | assistant provider preferences, usage filters, terminal presentation options |
| project-scoped settings | owning plugin/service | project-bound behavior where a project identity is required |

Configuration needs explicit version fields and migration functions. A plugin
does not get to mutate another plugin's namespace. Cross-plugin configuration is
expressed through a shared public schema or a host-owned policy document, never
through an undocumented property in a global YAML file.

The existing ~/.shipctl/config.yml may remain a human-facing entry point during
migration. Its grammar should be parsed and validated by TypeScript, then
projected into versioned documents. The target must support deterministic
offline resolution; it cannot require a running React webview to answer what a
setting means.

## Transaction and revision requirements

Configuration and workspace apply operations need the same basic safety:

1. read document plus revision;
2. parse and validate all affected documents;
3. compute a semantic plan and explicit migration actions;
4. commit using compare-and-swap or an atomic multi-document primitive;
5. activate a candidate runtime graph if the change affects plugins;
6. publish only after validation and activation succeed; otherwise retain the
   prior accepted state and report a structured failure.

For multi-document changes, do not pretend that sequential writes are
transactional. Either use a generic transaction/journal primitive in the
native document store or persist a recoverable intent with a verified recovery
protocol. The choice should be made and tested before configuration is used to
activate plugins.

## Refactoring actions

1. Define a generic DurableDocumentPort in module-api or trusted runtime
   contracts; its names are generic and its payload is opaque to Rust.
2. Implement TypeScript configuration loading, schema validation, defaults,
   provenance, and migrations.
3. Move ui.canvas and all visual settings out of Rust configuration enums.
4. Define configuration contributions in the plugin contract and register
   schemas from the accepted graph.
5. Build read-only inspect and validate operations before apply operations.
6. Add revision-aware plan/apply to prevent an agent from overwriting a newer
   user edit.
7. Implement a one-way, idempotent legacy import with backup and clear
   diagnostics; retain a rollback/read path only for the supported transition.
8. Remove legacy native configuration writes once migrated profiles have been
   proven.

## Validation and exit criteria

- Changing a TypeScript-owned configuration setting does not require a Rust
  enum, Tauri command, or app rebuild.
- Invalid configuration never replaces the last accepted document.
- Re-applying the same migration produces no further semantic change.
- Revision conflict messages identify the document id and expected/current
  revision.
- The UI and headless test runtime resolve the same fixture configuration into
  the same semantic result.
- The raw Layman layout store has no production writer and a documented
  deletion date.
