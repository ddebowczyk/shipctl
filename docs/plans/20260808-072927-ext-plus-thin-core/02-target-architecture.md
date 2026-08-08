# Target architecture

## Three layers and their mutability

```text
┌──────────────────────────────────────────────────────────────┐
│ Rust / Tauri core                              recompile     │
│  all module plugins, always registered                       │
│  fixed capability superset                                   │
│  module-registry commands (list/install/remove/enable)       │
│  asset-protocol scope over the modules directory             │
├──────────────────────────────────────────────────────────────┤
│ TypeScript host shell (in bundle)              recompile     │
│  boot, dependency shims, discovery, enablement               │
│  registries + disposal, host services, native port           │
│  layout, terminal, projects, settings, appearance            │
├──────────────────────────────────────────────────────────────┤
│ TypeScript modules (on disk)     install / replace / remove  │
│  builtin:  <bundle>/resources/modules/<id>/                  │
│  user:     ~/.shipctl/modules/<id>/                          │
└──────────────────────────────────────────────────────────────┘
```

The shell is the only thing that knows how to load a module. Nothing above the
Rust line is special-cased per module.

## Builtin modules are installed modules

Builtin modules ship inside the app bundle under `resources/modules/<id>/` in
byte-identical format to user-installed ones, and load through the same code
path. The only differences are that the builtin directory is read-only and
that a user-installed module of the same id shadows it.

This is what makes the migration honest. If builtins kept a privileged loading
path, the dynamic path would rot — it would be exercised only by whatever
third-party module happened to exist. Making the builtins the primary consumer
of the mechanism keeps it correct by construction, and it is how VS Code
treats `resources/app/extensions`.

## Artifact format

```text
<id>/
  module.json     manifest: identity, api_version, contributes, permissions
  module.mjs      ESM entrypoint, default export is a factory
  module.css      optional, emitted only if the module has styles
  assets/         optional static files
```

`module.json` is generated at build time from `modules/<id>/module.yaml`, so
the repository keeps one source of truth and the artifact carries a
self-contained copy.

## The manifest carries every declarative contribution

This is the load-bearing change. Today the host must `import` a module to
discover that it contributes a "To-dos" panel, because the metadata lives in a
TypeScript object literal. Moving that metadata into the manifest lets the
shell build the entire UI shell — panels, navigation, sidebar entries, settings
sections, ordering — by reading JSON, with no module code executed.

```yaml
# modules/todos/module.yaml
schema_version: 2
id: todos
version: 0.1.0
api_version: "^1.0.0"
permissions:
  - shipctl-todos:allow-scan
contributes:
  panels:
    - id: todos.board
      scope: project
      label: To-dos
      icon: { name: list-todo, label: To-dos }
      singleton: per-project
      order: 40
      unavailable:
        title: To-dos panel unavailable
        description: The project to-do module could not be loaded.
      migrationAlias: { kind: todos, label: To-dos }
  projectNavigation:
    - id: todos.project-navigation
      panelId: todos.board
      order: 40
```

Everything above is data that the current code object already contains. What
stays in code is only behaviour: the component loaders, lifecycle, providers,
and scheduled-task bodies.

Consequences that fall out for free:

- Enable and disable become a filter over manifest data. No module code runs.
- Lazy activation becomes possible: load `module.mjs` when a panel is first
  opened, not at boot.
- Id collisions, ordering, and `api_version` mismatches are detected before
  any module code executes.
- The scaffold generator, the ops proofs, and the host registry all derive
  from one file.

## Module runtime shape

```ts
// module.mjs
export default function createModule(host: ModuleRuntimeHost): ModuleRuntime;

interface ModuleRuntime {
  /** Keyed by contribution id declared in module.json. */
  readonly components?: Readonly<Record<string, () => Promise<{
    readonly default: ComponentType<never>;
  }>>>;
  readonly projectFactsProvider?: ProjectFactsProviderContribution;
  readonly skillsProvider?: ModuleSkillsPort;
  readonly projectLifecycle?: ModuleProjectLifecycle;
  readonly scheduledTasks?: Readonly<Record<string, ModuleScheduledTask["run"]>>;
  activate?(): void | ModuleDeactivation;
  beforeShutdown?(): void | Promise<void>;
}
```

A factory rather than a static object, because the host must inject
dependencies (chapter 02, "Dependency injection") and because it matches
`activate(context)` in VS Code. The shell validates that every contribution id
in the manifest has a matching entry in `components`, and reports the module
as failed if not — the same failure surface that `reportModuleFailure` uses
today.

## Dependency injection without a dynamic import map

A dynamically loaded module must not bundle its own React. Two React instances
in one page break hooks, and the failure is confusing rather than loud.

Import maps are the standard mechanism, but a map must be present in the
document before the first bare specifier is resolved, and support for
injecting additional maps later is uneven across WebKit versions. Depending on
that is an avoidable risk.

Instead, use a **static import map pointing at in-bundle shims**:

```html
<script type="importmap">
{
  "imports": {
    "react": "/shims/react.mjs",
    "react/jsx-runtime": "/shims/react-jsx-runtime.mjs",
    "react-dom": "/shims/react-dom.mjs",
    "zustand": "/shims/zustand.mjs",
    "@tauri-apps/api/core": "/shims/tauri-core.mjs",
    "@tauri-apps/api/event": "/shims/tauri-event.mjs"
  }
}
</script>
```

Each shim is a file in the host bundle that re-exports the host's singleton:

```js
// shims/react.mjs
const R = globalThis.__shipctl_react;
export default R;
export const {
  useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore,
  createElement, Fragment, memo, forwardRef, createContext, useContext,
} = R;
```

The map is fixed at build time and needs no runtime mutation, because the
shim URLs are stable and the values behind them are set during host boot.
Named exports must be enumerated explicitly — ESM named exports are static —
which is verbose but mechanical and testable.

`react/jsx-runtime` matters and is easy to miss: modules built with the
automatic JSX transform emit `import { jsx } from "react/jsx-runtime"`, so
that specifier needs a shim even though no module source mentions it.

Fallback if the shim approach proves unworkable: generate the import map at
boot and inject it before any module load. Experiment E2 decides.

## Native access moves behind a mediated port

Modules stop importing `@tauri-apps/api` directly. `ModuleHostServices` gains:

```ts
interface ModuleNativePort {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): () => void;
  channel<T>(): ModuleChannel<T>;
}
```

The shell checks each call against the `permissions` list in the calling
module's manifest and rejects undeclared commands with a structured error.

This restores the per-module permission model that Tauri capabilities cannot
express, because capabilities are per-webview and every module shares one
webview. It is an **advisory** boundary: a module that bundles its own copy of
`@tauri-apps/api`, or reaches `globalThis.__TAURI_INTERNALS__`, bypasses it.
Chapter 05 states what that costs and why it is still worth doing.

Migration shim: keep `@tauri-apps/api/core` and `/event` in the import map
during the transition so unmigrated modules keep working, and remove those two
entries once every module is on the port. Removing them is the checkpoint that
proves the migration is complete.

## Boot sequence

```text
1. Rust starts. All module plugins register. Asset scope covers both
   module directories.
2. Webview loads the host shell bundle. Shell publishes its singletons
   (React, zustand, native port) onto the shim globals.
3. Shell calls modules_list(). Rust returns manifests from the builtin
   directory and the user directory, with source and resolved base URL.
4. Shell merges (user shadows builtin), applies enablement from settings,
   rejects api_version mismatches and duplicate ids, sorts by order.
5. Shell populates the registries from manifest data alone. Panels,
   navigation, sidebar, and settings sections are now present in the UI.
   No module code has executed.
6. On first use of a contribution, the shell import()s that module's
   module.mjs, calls createModule(host), links component loaders by
   contribution id, and runs activate().
7. Enable, disable, install, and remove write state and reload the webview
   (v1). Hot-swap replaces step 7 in v2.
```

## Rust command surface

Small, stable, and static by design — it is the part the user has accepted
recompiling.

| Command | Purpose |
| --- | --- |
| `modules_list` | manifests plus source, base URL, enablement |
| `modules_install` | validate and unpack an archive or directory into the user modules dir |
| `modules_remove` | remove a user module; builtins cannot be removed, only disabled |
| `modules_set_enabled` | write enablement state |

Enablement lives in the existing global config (`~/.shipctl/config.yml`,
`core/backend/src/workspace/config.rs`) under a `modules:` section, so it
inherits the config loader, the migration path, and the existing tests.

## What stops being an enablement mechanism

Under a static Rust core, these keep existing but stop changing when a user
toggles a capability:

- `#[cfg(feature = ...)]` in `src-tauri/src/modules/mod.rs` — becomes a
  build-variant switch only.
- `profiles/*-disabled/tauri.conf.json` — the capability set becomes a fixed
  superset; the generated profiles are retired.
- `NATIVE_MODULE_FEATURES` in `ops/modularity/bin/plugout.mjs` — the plugout
  proof changes meaning, from "can this build exclude the module" to "can the
  shell run with this module absent from disk".
- `core/frontend/host/enabledModules.ts` — deleted. Membership comes from
  discovery.

Retiring the generated profiles is a genuine loss of a security property: the
narrow per-build capability sets go away. Chapter 05 records that as a
decision with its cost, not as a cleanup.
