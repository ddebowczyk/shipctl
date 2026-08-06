# Target modular architecture

## Architecture choice

Use a **compile-time modular monolith**:

- one signed Shep application;
- one React runtime and design system;
- one Tauri process;
- independently owned vertical module packages;
- explicit build profiles decide which modules are included;
- no downloading or dynamically loading native code at runtime.

This delivers the experimentation and customization benefits that are needed
now without taking on a plugin marketplace's signing, compatibility, trust,
dependency, and lifecycle problems.

## Design principles

### 1. Organize by capability, vertically

A module owns its React UI, state, frontend API, provider DTOs, native adapter,
permissions, fixtures, and tests. Do not split it across global
`components/`, `stores/`, `lib/tauri.ts`, and `commands.rs` directories.

### 2. Keep the host shallow

Core owns application-wide policy and stable extension points. It does not know
Beads issue fields, Git branches, TODO Markdown syntax, provider model lists, or
usage windows.

### 3. Depend inward through narrow ports

Modules can depend on `@shep/module-api`; core can depend on a module's public
entrypoint. Neither side imports module internals. Sibling modules do not import
one another.

### 4. Separate contribution metadata from module state

The host needs enough data to show and place a panel. Search filters, tree
expansion, selection, caches, and provider DTOs belong to the module.

### 5. Use namespaced identifiers

Identifiers such as `beads.browser`, `git.files`, and `todos.board` avoid one
global string union and make persisted state recoverable when a module is
disabled.

### 6. Treat paths and commands as authority boundaries

A project path from the frontend is not authorization. Native adapters must
resolve it against the registered-project service. Modules do not receive a
generic shell or arbitrary `invoke` capability.

### 7. Make removal an automated invariant

Architecture tests and build profiles must prove that a module can be disabled
without editing its implementation or breaking the host.

## What belongs in core

The initial shallow core should own only:

- Tauri application/window lifecycle, quit policy, native menu shell, updates;
- registered-project identity, project selection, and path authorization;
- generic tabs, project placement, panel registry, and layout slots;
- theme/design tokens, notices, and settings persistence primitives;
- terminal/PTY runtime while commands and assistants still depend on it;
- module activation and lifecycle orchestration;
- secure native bridge composition and permission profiles.

Terminal/PTY is not conceptually tiny, but it is infrastructural in the current
system. Keeping it in core during early migration avoids forcing Commands and
Assistant continuity to move together. It can later become a first-party
foundation module once its ports stabilize.

## Proposed repository layout

```text
shep/
  app/                              # application host; eventual move from src/
    frontend/
      src/
        App.tsx
        core/
          modules/
            ModuleRegistry.ts
            enabledModules.ts
          panels/
            PanelHost.tsx
            usePanelTabs.ts
          projects/
          lifecycle/
          theme/
          notices/
    backend/                        # eventual move/split from src-tauri/
      src/
        lib.rs
        host_lifecycle.rs

  modules/
    api/
      frontend/
        package.json
        src/index.ts
        src/module.ts
        src/panels.ts
        src/ports.ts
      backend/
        Cargo.toml
        src/lib.rs                  # stable native helper contracts only

    beads/
      README.md
      module.json
      frontend/
        package.json
        src/index.ts
        src/module.tsx
        src/contracts.ts
        src/api/
        src/state/
        src/components/
        src/tests/
      backend/
        Cargo.toml
        build.rs
        permissions/
        src/lib.rs
        src/commands.rs
        src/runner.rs
        src/dto.rs
        src/error.rs
        tests/
      fixtures/

    todos/                          # later extraction, same vertical shape
    git/                            # later extraction, same vertical shape

  profiles/                         # add only after more than one profile exists
    default/
    local-ddebowczyk/

  package.json
  pnpm-workspace.yaml
  Cargo.toml                        # workspace manifest
  src-tauri/                        # transitional host until app/backend move
```

Do not perform the `app/` move first. The valuable first step is introducing
`modules/api`, the panel registry, and `modules/beads`. Moving current host files
can wait and should be mechanical.

## Frontend contracts

### Public module contribution

The public API should be small and data-oriented:

```ts
// Runtime validation requires a namespaced value such as "beads.browser".
export type ModuleId = string;
export type ContributionId = `${string}.${string}`;

export interface ShepModule {
  readonly id: ModuleId;
  readonly version: string;
  readonly panels?: readonly PanelContribution[];
  readonly settings?: readonly SettingsContribution[];
  readonly commands?: readonly CommandContribution[];
  activate?(host: ModuleHost): void | ModuleDeactivation;
}

export interface ModuleDeactivation {
  deactivate(): void | Promise<void>;
}
```

`activate` is for subscriptions and background frontend work, not for rendering
or mutating host stores directly.

### Project-local panel contribution

```ts
export interface PanelContribution {
  readonly id: ContributionId;       // "beads.browser"
  readonly moduleId: ModuleId;       // "shep.beads"
  readonly scope: "project" | "global";
  readonly label: string;
  readonly icon: IconDescriptor;
  readonly singleton: "per-project" | "global" | false;
  readonly load: () => Promise<{
    default: React.ComponentType<ModulePanelProps>;
  }>;
}

export interface ModulePanelProps {
  readonly instanceId: string;
  readonly project: ProjectRef | null;
  readonly visible: boolean;
  readonly close: () => void;
  readonly setTitle: (title: string | null) => void;
}
```

The host persists only generic placement:

```ts
export interface PanelTabData {
  id: string;
  kind: "panel";
  panelId: ContributionId;
  moduleId: ModuleId;
  projectId: string | null;
  labelOverride: string | null;
}
```

The host must not persist module filter objects inside this tab. A module can
persist its own versioned, project-keyed preferences if that proves useful.

### Host ports

```ts
export interface ModuleHost {
  readonly projects: ProjectContextPort;
  readonly panels: PanelHostPort;
  readonly notices: NoticePort;
  readonly theme: ThemePort;
  readonly lifecycle: LifecyclePort;
}

export interface ProjectRef {
  readonly id: string;
  readonly name: string;
  readonly path: string; // display/context value; native side re-authorizes it
}

export interface ProjectContextPort {
  getActive(): ProjectRef | null;
  subscribe(listener: (project: ProjectRef | null) => void): () => void;
}

export interface PanelHostPort {
  open(panelId: ContributionId, options?: { projectId?: string }): string;
  reveal(instanceId: string): void;
  close(instanceId: string): void;
}
```

Do not give modules raw Zustand stores, `AppShell` callbacks, unrestricted
Tauri `invoke`, or a general shell executor. Those are dependency bypasses.

## Panel registry and rendering

The host replaces feature switches with one registry:

```ts
const modules = [beadsModule /* explicit build profile */] satisfies ShepModule[];
const registry = ModuleRegistry.create(modules);

function PanelHost({ tab }: { tab: PanelTabData }) {
  const contribution = registry.panel(tab.panelId);
  if (!contribution) return <UnavailableModulePanel tab={tab} />;
  const Panel = lazy(contribution.load);
  return <Panel instanceId={tab.id} project={resolveProject(tab)} visible />;
}
```

The production implementation should cache the `lazy` component in the
registry rather than creating it during render. The important point is that no
`if (kind === "beads")` or Beads import appears in `AppShell`.

### Registration failure policy

Activation should fail fast during development and produce a startup notice in
release builds for:

- duplicate module IDs;
- duplicate contribution IDs;
- unsupported module API versions;
- a project-scoped panel opened without a registered project;
- a persisted tab whose module is not enabled.

Persisted unknown panels should remain recoverable: show a small unavailable
state with "Close tab" and the missing module ID, rather than crashing or
silently converting it to another feature.

## Native module boundary with Tauri v2

Tauri v2 plugins match the desired native boundary. The official plugin model
supports a Cargo crate plus optional JavaScript bindings, lifecycle hooks,
managed state, command handlers, namespaced frontend invocation, and explicit
permissions. See the official [Plugin Development](https://v2.tauri.app/develop/plugins/)
and [Capabilities](https://v2.tauri.app/security/capabilities/) documentation.

A module backend should expose one internal plugin:

```rust
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("shep-beads")
        .invoke_handler(tauri::generate_handler![
            commands::detect,
            commands::list_issues,
            commands::list_children,
            commands::show_issue,
            commands::count_issues,
        ])
        .build()
}
```

Frontend bindings invoke namespaced commands:

```ts
invoke("plugin:shep-beads|list_issues", { request });
```

Tauri plugin commands are denied to the frontend until permissions allow them.
The module therefore owns generated command permissions under
`modules/beads/backend/permissions/`, and the selected application capability
grants only the read operations included in that build profile.

### Project path authorization

Tauri permission scopes alone should not become the only project path check.
The native Beads plugin should receive a small host-owned
`RegisteredProjectAuthorizer` state/extension that resolves an opaque project
ID to a current canonical path. If passing a path is necessary during the first
increment, the plugin must canonicalize it and confirm it is an exact registered
project before spawning `bd`.

### Native composition

The transitional host can explicitly install internal plugins:

```rust
let builder = tauri::Builder::default()
    .plugin(shep_module_beads::init());
```

This is a declarative enablement touchpoint, not Beads implementation leakage.
After two or more custom distributions exist, introduce a small profile crate
or generated build profile under `profiles/` so `src-tauri/src/lib.rs` always
calls one generic `install_enabled_modules(builder)` function.

Do not build profile generation before the second real profile. One explicit
plugin line and one explicit frontend module entry are easier to inspect and
remove during the first experiment.

## Frontend and Rust packaging

### Frontend

Introduce a pnpm workspace:

```yaml
packages:
  - modules/*/frontend
```

Use workspace packages such as `@shep/module-api` and `@shep/module-beads`.
React and React DOM should be peer dependencies of module packages to guarantee
one runtime. The root application owns versions and bundles modules through
Vite.

### Rust

Introduce a Cargo workspace at repository root or extend the current native
workspace:

```toml
[workspace]
members = ["src-tauri", "modules/*/backend"]
resolver = "2"
```

Each native module is a crate. Shared native APIs must remain small leaf crates;
do not create a broad `common` crate that becomes the new monolith.

## Dependency rules

The intended frontend graph is:

```text
app host -> module public entrypoint -> module internals
                     |
                     +-> @shep/module-api

module internals -> @shep/module-api
module A -X-> module B
module internals -X-> app stores/components/lib/tauri
```

The intended native graph is:

```text
src-tauri host -> module plugin crate -> module internals
                       |
                       +-> narrow host API crate (only when required)

module crate A -X-> module crate B
module crate -X-> src-tauri private modules
```

An explicit integration module can depend on two modules later, but ordinary
features must not create hidden sibling dependencies.

## Architecture gates

Add gates as the boundaries become real:

1. **Frontend public-entrypoint rule:** host may import a module only from its
   package root.
2. **No host internals from modules:** module packages may import only
   `@shep/module-api`, third-party libraries, and their own files.
3. **No sibling imports:** one module cannot import another module.
4. **No feature commands in flat bridge:** new module commands must not be added
   to `src/lib/tauri.ts`, `src-tauri/src/commands.rs`, or the root handler list.
5. **Namespaced contribution IDs:** panel/command/settings IDs must begin with
   their module namespace.
6. **Negative fixture:** intentionally illegal imports must make the
   architecture test fail, proving the gate is active.
7. **Disabled-profile build:** at least CI or a local script builds Shep with the
   experiment disabled.
8. **Removal smoke test:** a temporary worktree removes `modules/beads` after
   disablement and runs the builds.

Use ESLint import restrictions or a small TypeScript/AST rule for frontend
boundaries and Cargo workspace/package metadata checks for native boundaries.
Do not claim isolation because directories merely look modular.

## Runtime plugin architecture: deliberately deferred

A runtime-installed plugin system would require answers Shep does not currently
need:

- native code signing/notarization and trust;
- host/module API version negotiation and migrations;
- React runtime duplication and chunk loading;
- secure capability grants per installed module;
- failure isolation for startup hooks and background processes;
- module installation/update/removal transactions;
- persisted state cleanup and recovery;
- compatibility across macOS, Windows, and Linux builds.

Compile-time modules provide customization by build profile and safe local
experimentation. Revisit runtime installation only after at least three modules
need independent release/update cycles or users repeatedly require adding
modules without rebuilding Shep.

This defers a **general installation platform**, not all future local code
reload. A trusted machine-local TypeScript activation lane can reuse the same
module contracts once activation/deactivation, stale-context invalidation,
state ownership, health checks, rollback, safe mode, and an app-owned module
asset origin exist. It remains bounded by the native capabilities compiled into
the installed Tauri shell. See
[06-pi-self-modification-and-future-shep.md](./06-pi-self-modification-and-future-shep.md).
