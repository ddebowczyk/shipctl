# Current state and evidence

<!-- markdownlint-disable MD013 -->

## Evidence date and method

This inventory describes `main` at commit `ac14b3d` on 2026-08-16. It uses
`ast-grep outline` for exported structure, focused `rg` searches for dependency
and composition paths, package manifests, Cargo manifests, module manifests,
and the existing verification tools.

Counts are evidence, not targets. They show the present change surface and do
not create line-count or file-count gates.

## Current repository shape

| Area | Source files | Source lines | Current role |
| --- | ---: | ---: | --- |
| `core/frontend` | 145 | 19,092 | Trusted React host, platform clients, canvas, shell, module composition |
| `core/backend` | 66 | 36,586 | Tauri-free native capabilities and module control |
| `core/tauri` | 13 | 2,129 | Tauri command and event adapters |
| `module-api/frontend` | 23 | 3,273 | Shared frontend protocol, host ports, and module contributions |
| `module-api/backend` | 11 | 636 | Shared Rust host/module protocol traits |
| `modules` | 191 | 41,515 | Nine feature slices, including seven native backends |
| `src-tauri/src` | 8 | 1,293 | Bundle shell and build-selected module installation |

The existing module-control capability alone contains 10,201 lines of Rust.
It already implements durable registry, artifact validation, capability
contracts, offline operations, runtime inspection, and restart-bound startup
descriptors. The migration should reuse this work rather than replace it.

## Current frontend composition

`core/frontend/host/enabledModules.ts` imports all nine built-in frontend
modules and constructs `ENABLED_MODULES` at build time:

- assistants;
- commands;
- Git;
- ports;
- semantic terminal;
- skills;
- thin terminal;
- TODOs;
- usage.

`core/frontend/host/moduleComposition.ts` then derives commands, panels,
global surfaces, navigation, project actions, project facts, settings,
schedules, messages, and lifecycle calls from that array. Most functions use
`ENABLED_MODULES` as a default argument.

`core/frontend/shell/AppShell.tsx` is the active composition root. It has 970
lines and directly coordinates:

- static module membership;
- restart-bound artifact loading;
- module activation and deactivation;
- runtime snapshot publication;
- terminal presentation selection;
- command registry creation;
- project lifecycle notifications;
- workspace and canvas model construction;
- native event listeners and window lifecycle.

This is a working composition root, but it is not a dynamic plugin supervisor.

## Current canvas and Layman bridge

The Layman integration is a valid adapter proof, not yet a dynamic workspace:

- `core/frontend/canvas/layman/LaymanCanvas.tsx` creates one fixed Layman
  window and one tab;
- that tab renders the complete `LegacyCanvas`;
- user layout commands are denied by policy;
- `core/frontend/host/LaymanCanvasRuntimeAdapter.tsx` binds controller,
  persistence, notices, and lifecycle;
- `core/frontend/host/laymanWorkspaceLayoutPort.ts` imports Tauri directly and
  stores a renderer-specific Layman snapshot;
- the GitHub dependency is pinned to
  `8d0c41a0a52830f3072771af674d63d80215384e`.

This current bridge proves selectable renderers, controlled state, CAS layout
persistence, and source pinning. The target must replace the single legacy
pane with semantic view instances. It must also make the semantic workspace
document authoritative before Layman-specific persistence can be retired.

## Current runtime artifact path

The runtime path is real but intentionally narrow:

1. Rust returns `StartupModuleCatalog` from `list_startup_modules`.
2. The browser converts each admitted entry path to a digest-qualified asset
   URL.
3. `loadShipctlModuleArtifact` imports the module and checks its ID and version.
4. The loader accepts only `id`, `version`, `messages`, and `activate`.
5. It rejects commands, panels, and all canvas contributions.
6. `AppShell` appends the loaded headless modules to `ENABLED_MODULES`.

The path is restart-bound. It does not reconcile registry revision changes
while the webview remains active. Rust source names confirm the limitation:
the catalog is described as disabled runtime artifacts, and static inventory
records are build-installed and restart-bound.

This is valuable infrastructure. It proves immutable artifact import and
manifest-to-runtime message declaration comparison. It does not yet prove live
application-plugin replacement, service provision, or UI replacement.

## Current Tauri boundary

The target rule says that only trusted platform code can import
`@tauri-apps/*`. After the first Phase B slices, direct imports remain in four
feature modules:

| Module | Direct use |
| --- | --- |
| assistants | raw `invoke` client |
| semantic terminal | raw `Channel` and `invoke` client |
| skills | raw `invoke` client |
| usage | raw `invoke` client |

The same four frontend packages declare `@tauri-apps/api` as a dependency.
Ports, Git, and TODOs now use activation-scoped semantic services through
trusted platform adapters. Commands and thin terminal already use host
services and have no native backend. They are the closest current examples of
the target plugin shape.
Commands is specifically a compound-plugin candidate: its `runtime.ts` owns
persistence, terminal-session tracking, start/stop, and autostart behavior,
while `CommandsPanel.tsx` is optional presentation.

Tauri imports also exist in trusted host code outside `platform/`, including
`shell`, `projects`, `terminal-host`, and `host`. The end-state wall is stricter
than today's documented frontend boundary: those imports must be moved behind
named platform adapters, not merely removed from feature modules.

## Current native module shape

Seven of nine module manifests declare Rust Tauri backends. Six also declare a
host adapter crate.

| Module | Rust backend | Host adapter | Frontend only today |
| --- | --- | --- | --- |
| assistants | yes | yes | no |
| commands | no | no | yes |
| Git | yes | yes | no |
| ports | yes | yes | no |
| semantic terminal | yes, plus Tauri-free core | yes | no |
| skills | yes | yes | no |
| thin terminal | no | no | yes |
| TODOs | yes | no | no |
| usage | yes | yes | no |

The root Cargo workspace includes `modules/*/backend`, `modules/*/core`, and
`modules/*/host`. `src-tauri/Cargo.toml` defines one feature and direct optional
dependencies per native module. `src-tauri/src/modules/mod.rs` installs the
selected plugins. Tauri needs the direct backend dependency to discover ACL
manifests at build time.

This design gives good build-time removal. It cannot accept a TypeScript-only
user plugin that needs an already available native capability without rebuilding
the application.

## Current shared API

`module-api/frontend` has a useful internal direction:

- `protocol/` holds immutable and wire values;
- `host/` holds services supplied by the host;
- `module/` holds contributions supplied by a module.

The current `ModuleHostServices` exposes panels, appearance, data, terminal
sessions, terminal presentation, settings, skills, notices, and external
links. This proves that semantic ports work: commands and thin terminal use
them now.

The current public root also combines:

- browser plugin contracts;
- concrete React contribution types;
- host-side port types;
- module-side contribution types;
- message, schedule, capability, and terminal protocols.

The backend crate contains Rust traits and values used by core and current
native modules. Its live surface includes terminal authority, terminal driver
registry and traits, durable-write coordination, snapshot providers, and
terminal protocol values. In the target, these responsibilities move to their
owning `core/backend` capabilities and private `core/tauri` wire adapters. The
Rust compatibility crate is deleted. It is never part of the TypeScript plugin
API, even while both remain under `module-api/` during migration.

## Existing strengths to preserve

- `core/backend` is already Tauri-free.
- `core/tauri` already holds named Tauri adapters.
- `src-tauri` already acts mainly as a bundle composition shell.
- terminal identity and PTY resources are host-owned.
- the canvas has a semantic model and replaceable legacy and Layman adapters.
- module contributions already use stable IDs and typed interfaces.
- panel and surface registries validate important identity constraints.
- module-control already has immutable artifact, registry revision,
  diagnostics, capability, and agent inspection concepts.
- the message bus already has contracts, capability grants, ordered behavior,
  and proof tooling.
- modularity checks already use the TypeScript AST and test synthetic
  violations.
- module characterization tests exist for several high-risk features.

These are migration assets. The plan extends their boundaries and does not
introduce parallel replacements without a deletion gate.

## Existing verification surface

The root `justfile` delegates to capability-owned checks. Relevant current
surfaces include:

- `just modularity boundaries` for frontend dependency direction;
- modularity profile and plug-out checks for build-selected modules;
- module manifest schema tests;
- `just module-control ...` for control-plane contracts;
- `just message-bus ...` for shared protocol and runtime proofs;
- frontend Node tests, Rust tests, TypeScript checks, Clippy, and builds.

No current dependency on `fast-check`, `proptest`, or another property-testing
library was found. The architecture program must add these deliberately and
integrate them into existing test runners.

## Current-state correction

The requested scope mentioned `modules-api`. The live directory is
`module-api/`. This plan uses the live name. A future `plugin-api/` rename is a
separate mechanical change after its public contract is stable.

The current dynamic-workspace discussion emphasized views and menus. That is
only the presentation plane. The target Cordis runtime composes complete
TypeScript application plugins, including services and headless effects, as
defined in [Cordis application runtime](20-cordis-application-runtime-and-plugin-roles.md).
