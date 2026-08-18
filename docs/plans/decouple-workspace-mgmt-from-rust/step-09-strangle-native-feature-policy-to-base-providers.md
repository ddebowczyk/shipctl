<!-- markdownlint-disable MD013 -->

# Step 09 — Strangle native feature policy to base providers

## Outcome

Systematically remove product and feature policy that remains in Rust after the
TypeScript runtime has viable service, configuration, workspace, and artifact
paths. Retain native base providers where they protect operating-system
resources or durable primitives. This step is an audit-and-strangler process,
not a mandate to move every line of Rust into TypeScript.

The desired result is a small core/backend plus core/tauri surface that can
serve many trusted TypeScript plugins without knowing their panels, workspace
profiles, menu positions, visual settings, or feature workflow vocabulary.

## Audit rule

For every native type, command, enum, configuration field, and event, answer:

1. What operating-system resource, protocol implementation, or durable
   primitive requires native ownership?
2. What is the stable TypeScript semantic port?
3. Is the remaining code resource implementation, or does it decide product
   policy?
4. If policy remains, which runtime/plugin owns it after migration?

If the first answer is absent, the code is a candidate to move. If it exists,
retain the smallest native implementation that enforces the resource boundary.

## Expected classification of current areas

| Current area | Retain in native kernel | Move or re-home in TypeScript |
| --- | --- | --- |
| workspace/config.rs | configuration root access and generic document storage only | canvas selection, UI settings, profiles, sidebar policy, terminal appearance settings |
| state/workspace_document.rs | revisioned opaque document CAS, backup/recovery | workspace field names, document validation, migration and interpretation |
| state/workspace_layout.rs | none after optional legacy importer | raw Layman layout persistence and validation |
| semantic_terminal and terminal_host | PTY, terminal process/session state, optimized I/O, native resource lifetime | terminal tabs/views, semantic presentation, focus and user workflow |
| assistant_launch and credentials | process/credential/keychain primitives, scoped launch mechanics | assistant provider selection, model/workspace policy, session placement and settings |
| git and processes | native command/process execution and permitted paths | commands, status workflow, views, navigation and presentation |
| project_documents and plugin_data | scoped file/database implementation and atomic writes | domain schemas, plugin-owned data semantics, UI and policy |
| scheduler and runtime messages | reliable timer/wakeup and durable delivery primitive only if needed | route declarations, schedule policy, handlers, retries, user semantics |
| usage_sources | native collection adapters where external sources require them | source policy, aggregation, alerts, dashboard behavior |
| skill_installation | atomic install/extraction and filesystem safety | catalogue policy, selection, UI, configuration and commands |
| desktop window/menu/notification commands | native platform implementation | whether a menu/window/notice exists, its placement, content, and workflow |

The final column should be implemented through public TypeScript service
contracts and plugins, not by moving feature code from core/backend directly
into arbitrary frontend components.

## Keep backend neutral

core/backend should remain Tauri-free and organize reusable native resource
providers. core/tauri should translate Tauri commands, events, lifecycle, and
state injection only. src-tauri remains the packaging shell required by
tauri::generate_context!, not a location for new behavior modules.

Do not recreate per-feature Rust module crates merely to mirror the old
frontend module folders. The end goal is TypeScript-only feature plugins using
generic native services. A native component is justified only if it provides a
shared privileged capability or a measured performance-sensitive implementation.

## Strangler sequence

1. Add a TypeScript semantic service and tests while the native feature policy
   remains in place.
2. Make the runtime/plugin use the new service for new configuration and
   composition paths.
3. Read legacy native state once through an importer when needed.
4. Stop writing the legacy native policy representation.
5. Observe migration diagnostics and offer explicit recovery/rollback.
6. Remove the old Rust enum, command, state record, test fixture, and frontend
   adapter together once unused.

Deletion is part of the step, not a hypothetical cleanup later. Every retained
compatibility path needs a measurable deletion gate.

## Refactoring actions

1. Turn the Step 01 ledger into a Rust/API deletion checklist.
2. Remove canvas and workspace UI configuration from core/backend first, once
   Step 05 is live.
3. Separate generic wake/delivery primitives from usage or feature-specific
   schedules/routes.
4. Move presentation and user workflow policy out of terminal, assistant, Git,
   skills, usage, and project native command layers as their direct artifacts
   migrate.
5. Minimize core/tauri command names around base providers; group by resource,
   not feature screen.
6. Update Rust integration tests to test resource semantics rather than
   TypeScript composition.
7. Delete obsolete workspace commands and raw layout storage after migration
   coverage is sufficient.

## Validation and exit criteria

- Native sources contain no application rule that names a plugin view, menu
  placement, Layman, workspace profile, or UI canvas choice.
- Each remaining native command maps to a documented resource-backed semantic
  port.
- A feature can change its TypeScript configuration and composition without a
  Rust rebuild, unless it intentionally adds a new privileged resource.
- Rust integration tests still prove terminal/process/credentials/filesystem
  correctness under TypeScript-independent fixtures.
- The native command surface is materially smaller and easier to audit than
  the original feature-shaped surface.
