<!-- markdownlint-disable MD013 -->

# Step 01 — Close the residual wall and delete what is already dead

## Outcome

Two things, both cheap and both prerequisites for every later step:

1. Add the small number of import-boundary rules that do **not** yet exist, so
   later steps cannot regress silently.
2. Delete the code paths that already have zero production callers, so the
   migration does not carry them forward as permanent legacy.

This step changes no behavior. It is the only step that is safe to land before
any contract work.

## What the repository actually shows today

The plan's earlier baseline was written as if the Tauri wall were still open.
It is not. `just modularity boundaries` already rejects, by named rule:

| Rule id | Enforces |
| --- | --- |
| `tauri-import-outside-platform` | frontend Tauri imports only in `core/frontend/platform` (no ledger, no exceptions) |
| `canvas-tauri-import` | canvas adapters may not import Tauri |
| `canvas-feature-module-import` | canvas adapters may not import feature modules |
| `module-cordis-import` | plugins may not import Cordis |
| `module-renderer-import` | plugins may not import `react-layman` |
| `module-direct-tauri-event` | plugin transport must use declared message routes |
| `module-host-import` / `module-api-deep-import` / `module-sibling-import` | plugin import surface |
| `core-capability-deep-import` / `host-module-deep-import` | capability entrypoint discipline |
| `app-ops-import`, `src-entry-only`, `module-entrypoint-side-effect`, `scenario-port-only` | repository shape and passive imports |

`core/frontend/README.md` still describes a "Phase B" Tauri-import ledger at
`ops/modularity/legacy-tauri-imports.json`. That ledger is gone. The README is
stale and must be corrected in this step; a stale enforcement description is
how an agent reintroduces a removed exception.

The real coupling is indirect, and it is narrower than a file count suggests:

| Location | Actual problem | Owning step |
| --- | --- | --- |
| `core/frontend/shell/AppShell.tsx:124-140,429-582` | React `useEffect` constructs the semantic service registry, workspace authority, persistence port, canvas bridge, catalogue controller, and `LiveModuleSupervisor`. The runtime exists; React owns its lifetime. | 03 |
| `module-api/frontend/src/module/module.ts:42-71` | `ShipctlModule` is one static bag of 15 unrelated contribution families plus lifecycle hooks. | 02 |
| `module-api/frontend/src/host/services.ts:88-97` | `ModuleHostServices` is a capability bag handed to every plugin regardless of declaration. | 02 |
| `core/frontend/platform/tauri.ts` | One module mixing repos, groups, editor/keybinding/terminal/sidebar settings, UI state, fonts, PTY, watcher, and system queries. | 04 |
| `core/backend/src/workspace/config.rs:9-36` | `CanvasAdapter` and `UiSettings` make Rust decide the renderer. `src/main.tsx:16` awaits `get_canvas_adapter` before first render. | 05 |
| `core/backend/src/module_control/artifact.rs:509-525` | The contribution-family taxonomy is duplicated in Rust. | 09 |
| `cli/src/offline_modules.rs` | Offline module inspection/verify/diagnose/enable policy reimplemented in Rust. | 10 |

## Delete now: paths with zero production callers

These are not "candidates for later cleanup". They are already unreferenced and
carrying them forward is what turns a migration into a permanent half-state.

| Path | Proof it is dead |
| --- | --- |
| `core/backend/src/state/workspace_layout.rs` (852 lines) | Only referenced by `state/mod.rs`, `state/paths.rs`, `state/providers.rs`, its own tests, `core/tauri/src/state.rs`, and `src-tauri/src/lib.rs` registration. **No TypeScript, no CLI caller exists.** |
| `load_workspace_layout` / `save_workspace_layout` | Registered at `src-tauri/src/lib.rs:309-310`; no frontend or CLI invoker. |
| `WorkspaceLayoutStore` state management + `paths.workspace_layouts` + its durable-configuration source entry | `src-tauri/src/lib.rs:136-137,199,483`; `core/backend/src/state/paths.rs:12,40,69` |
| `core/frontend/host/enabledModules.ts` and the `COMPOSITION_FILES` exception in `ops/modularity/lib/module-boundaries.mjs:19-21` | `ENABLED_MODULES` is `[] as const`. The rule `host-module-import-outside-composition` guards an empty list. |
| The static-module path in `LiveModuleSupervisor`: option `:56`, field `:166`, uses `:209`/`:214`/`:220`, filter `:229`, snapshot merge `:401` | Its only production caller is `AppShell.tsx:490` passing `ENABLED_MODULES` (`[]`). All other callers are tests. |
| Public re-export of `adaptShipctlModule` from `core/frontend/runtime/index.ts:37` and `runtime/cordis/index.ts:4` | With the static path gone, no application code calls it; Step 02 requires it to be module-private. |

`docs/4-layer-architecture/12-phase-g-workspace-contributions-and-closure.md:71`
describes the raw-layout bridge as "retained only as an inactive migration and
rollback artifact". Deleting it requires stating that no rollback consumes it.
That statement is this step's deliverable, not a later step's.

Deletion of `enabledModules.ts` requires `AppShell.tsx` to stop importing
`ENABLED_MODULES` and `LiveModuleSupervisor` to accept an empty static set by
construction. If that is not trivially true, keep the file, record the reason,
and move the deletion into Step 03 with a named gate — do not leave it silent.

## Add the rules that do not yet exist

Extend `ops/modularity/lib/module-boundaries.mjs`. Do not create a second
mechanism; `just modularity boundaries` is already the enforcement point and is
already covered by `ops/modularity/tests/moduleBoundaries.test.mjs`.

| New rule | Why it is needed now |
| --- | --- |
| `runtime-import-boundary`: `core/frontend/runtime` may not import React, `@tauri-apps/*`, `core/frontend/canvas`, `core/frontend/shell`, or any feature package. | The runtime is about to become the composition root (Step 03). Without this rule, moving code from AppShell can silently drag React and renderer imports with it. This is the single highest-value missing rule. |
| `canvas-persistence-import`: `core/frontend/canvas` may not import `core/frontend/workspace/persistence.ts`, `core/frontend/platform/workspacePersistence.ts`, or `shipctl.plugin-data`. | The renderer must never be a durable writer. `canvas-tauri-import` does not catch a persistence import that routes through a port. |
| `module-api-purity`: the built declaration output of `@shipctl/module-api` may not reference Cordis or `@tauri-apps/*` types. | `run-module-api-backend-closure-properties.mjs` covers the backend closure; a declaration-level assertion is what prevents a type leak through `import type`. Confirm coverage before adding; if the existing property already asserts this, cite it and add nothing. |

Do **not** add a rule for "only platform adapters may name native invoke command
strings". `tauri-import-outside-platform` already makes `invoke` unreachable
elsewhere, so a command-name string outside `platform/` is inert. A rule that
cannot fail meaningfully is noise in the checker.

## Exceptions are the ledger

`ops/modularity/lib/module-boundaries.mjs` carries the migration's real debt as
three literal sets. They are the honest inventory; a separate ledger document
would duplicate them and drift.

| Constant | Current contents | Removal condition |
| --- | --- | --- |
| `CORE_DEEP_IMPORT_EXCEPTIONS` (7) | 5 exist only for `core/frontend/host/moduleHostServices.ts` reaching `appearance`, `projects` (×2), and `terminal-host` (×2) stores. 2 for `host/index.ts` and `host/projectFacts.ts`. | Deleting `ModuleHostServices` (Step 02) removes exactly 5. This is the step's deletion proof — not a count target, a named set. |
| `COMPOSITION_FILES` (1) | `core/frontend/host/enabledModules.ts` | This step, once `ENABLED_MODULES` is gone. |
| `MODULE_PLATFORM_EVENT_LISTENERS` (1) | `@shipctl/module-git` → `git-fs-changed` | Step 09, when Git repository observation is delivered as a semantic event source rather than a raw Tauri event. |

Every future exception must name the step that removes it, in a comment beside
the entry. A permanent exception is a boundary decision and belongs in a
`spec/` record, not in the checker.

## Refactoring actions

1. Correct `core/frontend/README.md`: remove the Phase B ledger paragraph;
   state that the Tauri rule is unconditional; describe
   `CORE_DEEP_IMPORT_EXCEPTIONS` as the live exception set.
2. Correct `modules/README.md`: no module has a `backend/` Rust crate or a
   `host/` adapter any more; all nine have `artifact/`. The current text
   describes a shape that no longer exists.
3. Delete the raw Layman layout store, its two Tauri commands, its state
   registration, its path entry, and its tests. Record in the commit message
   that no rollback path consumes it.
4. Delete `enabledModules.ts` and its checker exception, or record the blocking
   reason and defer it to Step 03 with a named gate.
5. Add `runtime-import-boundary` and `canvas-persistence-import`, with negative
   fixtures in `ops/modularity/tests/moduleBoundaries.test.mjs`.
6. Confirm whether module-api declaration purity is already asserted. Add the
   assertion only if it is not.
7. Annotate each remaining checker exception with its removing step.

## Validation and exit criteria

- `just modularity boundaries`, `just modularity all`, `just check all`,
  `just test fast`, and `cargo test --workspace` pass unchanged.
- The new rules fail on a deliberately added negative fixture.
- `rg workspace_layout` returns only history; the store, commands, state
  registration, path entry, and tests are gone together.
- Both READMEs describe the enforcement that exists.
- Every entry in the three exception sets names the step that removes it.
- No behavior change: startup, terminal, and module activation tests are green.
