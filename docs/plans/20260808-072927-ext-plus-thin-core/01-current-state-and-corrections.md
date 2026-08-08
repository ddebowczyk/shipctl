# Current state and corrections

Every claim here was checked against the tree at `cd48d6a`. Where an earlier
analysis was wrong, the correction is stated with its evidence, because the
wrong version made the work look cheaper than it is.

## What already fits the target

The declarative contract is genuinely good and does not need redesign.
`modules/api/frontend/src/module.ts` defines `ShipctlModule` with panels,
global surfaces, global and project navigation, sidebar, project layout,
project actions, a project facts provider, project import, settings, a skills
provider, project lifecycle, scheduled tasks, `beforeShutdown`, and
`activate() -> ModuleDeactivation`.

Two properties matter for this plan:

- Every contribution is either plain data or a lazy `load: () => import(...)`
  thunk returning a React component. Nothing requires eager evaluation.
- `@shipctl/module-api` is consumed as **types only**. Verified across all
  eight module `index.ts` files: no runtime value is imported from it. Type
  imports erase, so this edge costs nothing at runtime.

`modules/*/module.yaml` already exists, already has a schema at
`ops/modularity/schema/module.schema.yaml`, and is already validated by
`ops/modularity/tests/moduleSchema.test.mjs`. It is the natural home for
declarative contributions; it simply does not carry them yet.

Module `package.json` files already declare `react` as a **peer** dependency
and mark CSS under `sideEffects`. They are already shaped for externalisation.

## Correction 1 — modules are coupled to native, not just to the host API

Earlier analysis concluded runtime coupling was near zero on the strength of
the types-only `@shipctl/module-api` edge. That conclusion ignored a second
edge. Every module reaches native directly:

| Module | Direct `@tauri-apps/api` use |
| --- | --- |
| `assistants` | `client.ts` — `Channel`, `invoke` |
| `git` | `client.ts` — `invoke`; `GitPanel.tsx`, `DiffSummaryPanel.tsx` — `listen` |
| `usage` | `client.ts` — `invoke`; `index.ts`, `UsagePanel.tsx` — `listen` |
| `todos` | `client.ts` — `invoke` |
| `ports` | `client.ts` — `invoke` |
| `skills` | `client.ts` — `invoke` |
| `fixture` | `client.ts` — `invoke` |
| `commands` | none — frontend-only |

Consequences:

- `@tauri-apps/api` must be resolvable by a dynamically loaded module, either
  through the import map or through a host-provided port.
- The per-module permission lists in `module.yaml` describe intent but are
  enforced only by the Tauri capability system at the webview level, which is
  per-webview and not per-module. Any module in the webview can call any
  allowlisted command today.
- `commands` is the only module with no native edge, which makes it the
  cleanest early pilot.

## Correction 2 — modules are not code-split apart today

`core/frontend/host/enabledModules.ts` statically imports all seven optional
module entrypoints and gates membership with
`import.meta.env.VITE_SHIPCTL_*_MODULE === "disabled"`. A static import means
the module's `index.ts`, its Zustand store, and its side-effect CSS import
(`import "./todos.css"`) are all in the main chunk regardless of the flag.

Only the panel components are split, because only they sit behind
`load: () => import(...)`.

So "ship everything, decide at runtime which chunk to fetch" does not follow
from the current build. It becomes true only after the module entrypoint
itself is loaded dynamically — which is the same change this plan needs
anyway, but it is work, not a free consequence.

## Correction 3 — the CSP forbids this today

`src-tauri/tauri.conf.json`:

```json
"csp": {
  "default-src": "'self' customprotocol: asset:",
  "script-src": "'self' 'wasm-unsafe-eval'",
  ...
}
```

`script-src` overrides `default-src` for scripts. `asset:` is absent from it,
so a dynamic `import()` of module code served over the asset protocol is
blocked by policy before it is blocked by anything else. `devCsp` omits
`script-src` entirely and therefore falls back to its own `default-src`, which
does include `asset:` — meaning **dev and packaged builds will behave
differently on exactly this axis**. Any experiment must be run in a packaged
build, not only under `pnpm dev`.

Widening `script-src` is a security decision about the signed bundle, not a
config tweak. Chapter 05 treats it as such.

## Correction 4 — teardown is one-way

`core/frontend/host/panelRegistry.ts` exposes `register()`, `panel()`,
`has()`, and `list()`. There is no `unregister()` or `dispose()`.
`globalSurfaceRegistry.ts` is the same shape.

`activateModules()` (`core/frontend/host/moduleComposition.ts:267`) does return
a teardown closure and does call `deactivation.deactivate()`, but only on
activation failure and at application shutdown. There is no path that removes
one module from a running application, and if there were, its panels would
remain registered.

This is why chapter 02 chooses restart-first. Disposal is a prerequisite for
hot-swap, not for dynamic loading.

## Build-time membership, measured

Adding or removing one module touches five systems:

| System | Location |
| --- | --- |
| Frontend membership | `core/frontend/host/enabledModules.ts` |
| Native membership | `#[cfg(feature = ...)]` in `src-tauri/src/modules/mod.rs` |
| Permissions | `src-tauri/tauri.conf.json` plus generated `profiles/*-disabled/tauri.conf.json` |
| Host glue | one `src-tauri/src/modules/<name>.rs` per native module |
| Proof tooling | hardcoded `NATIVE_MODULE_FEATURES` in `ops/modularity/bin/plugout.mjs` |

Measured against `todos`, that is eight files across three languages and two
build systems, plus a full `cargo` and `vite` rebuild.

Under a static Rust core, systems 2, 3, 4, and 5 stop being enablement
mechanisms. They keep existing — the plugins stay compiled and registered —
but they no longer change when a user turns a capability on or off.

## Dependency surface per module

Relevant because each module becomes an independently built artifact.

| Module | Runtime dependencies beyond the API |
| --- | --- |
| `fixture` | `@tauri-apps/api` |
| `commands` | `lucide-react`, `zustand` |
| `ports` | `@tauri-apps/api`, `lucide-react` |
| `skills` | `@tauri-apps/api`, `zustand` |
| `todos` | `@tauri-apps/api`, `lucide-react`, `zustand` |
| `usage` | `@tauri-apps/api`, `lucide-react`, `zustand` |
| `assistants` | `@tauri-apps/api`, `lucide-react`, `zustand` |
| `git` | `@tauri-apps/api`, `lucide-react`, `zustand`, `@pierre/diffs`, `@pierre/trees`, `shiki`, `@shikijs/markdown-it`, `markdown-it` |

`react` is a peer dependency everywhere except `skills`, which omits it and
should be corrected regardless of this plan.

`git` is the worst case by an order of magnitude: `shiki` alone carries
substantial grammar and theme payload. It is the right artifact-size probe and
the wrong first pilot.
