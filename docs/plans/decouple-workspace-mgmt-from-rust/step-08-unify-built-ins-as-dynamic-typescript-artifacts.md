<!-- markdownlint-disable MD013 -->

# Step 08 — Replace `module: ShipctlModule` in the nine artifact entrypoints

## Outcome

All nine built-ins are already dynamic artifacts. Their entrypoints already
declare role and required services. The single remaining change is that each
still hands the runtime one `ShipctlModule` object.

This step converts those entrypoints to register contributions through the
activation context (Step 02), then deletes the legacy path.

## What is already done — do not re-plan it

The draft described discovery, admission, manifests, and dynamic loading as work
to be introduced. They exist:

- `modules/*/artifact/module.template.json` — schema-v2 manifests with
  `application { role, requiredServices, providedServices, backgroundEffects,
  contributions }`, `messages`, and `requestedGrants`;
- `modules/*/artifact/src/index.ts` — each exports
  `createShipctlPlugin(host): ShipctlPluginDefinition` calling
  `host.pluginApi.defineShipctlPlugin({ module, role, requires })`;
- `core/frontend/host/moduleArtifactLoader.ts:300-349` — validates declarations,
  messages, and grants against the manifest before activation;
- `ENABLED_MODULES = []` (`core/frontend/host/enabledModules.ts:7`) — no static
  membership remains.

The same activation path must accept an artifact that was not present in the
source checkout or bundled-module seed. A bundled artifact is only a convenient
delivery source; its entrypoint, manifest, grants, lifecycle, and inspection
must be indistinguishable from a plugin packed and installed after Shipctl was
released. Step 09 supplies the post-package proof.

Role is **already declared**, not inferred, in all nine entrypoints
(`role: "presentation" | "compound"`). `inferShipctlPluginRole` therefore has one
remaining caller: `adaptShipctlModule`.

## The one shape that remains

Every entrypoint is the same three lines:

    return host.pluginApi.defineShipctlPlugin({
      module: <feature>Module,      // ← a ShipctlModule: 15 optional arrays
      role: "...",
      requires: [...],
    });

`module` is the last host-shaped surface. Target:

    export function createShipctlPlugin(host: ArtifactHost) {
      return host.pluginApi.defineShipctlPlugin({
        id: "...",
        role: "presentation",
        requires: [host.pluginApi.processesService],
        activate(context) { /* register contributions, own() effects */ },
      });
    }

`collectPluginArtifactDeclarations` must still derive the same declaration set
from the converted activation, or the manifest consistency check at
`moduleArtifactLoader.ts:300-349` silently becomes a no-op. That is the
conversion's hard invariant, and it must be tested per module.

The equality proof includes `requestedGrants`. A conversion must pass the
already-admitted effective grants into its host-side provider bindings (Step 02)
instead of relying on a module-id/key table. A module that declares
`plugin-data.*` may use only its activation-derived namespace; a module that
does not declare it receives no durable-data authority.

## The legacy path is already dead in production

`LiveModuleSupervisor.staticModules` is the only consumer of
`adaptShipctlModule` in application code (`liveModuleSupervisor.ts:220`), and its
only production caller passes `ENABLED_MODULES`, which is `[]`
(`AppShell.tsx:490`). Every other reference is a test
(`ops/architecture/tests/cordisStaticComposition.test.mjs`,
`pluginArtifacts.test.mjs`).

Two consequences:

1. The static-module code path in `LiveModuleSupervisor` — the option
   (`:56`), the field (`:166`), the three uses (`:209`, `:214`, `:220`), the
   filter (`:229`), and the snapshot merge (`:401`) — is dead weight that can be
   deleted with `ENABLED_MODULES` in Step 01, **before** any entrypoint changes.
2. `adaptShipctlModule` is not currently private. It is re-exported from
   `core/frontend/runtime/index.ts:37` and `runtime/cordis/index.ts:4`. Step 02
   requires it to be private; that narrowing can also happen now, because no
   application code outside the supervisor calls it.

Do not sequence the deletion behind the nine conversions. Deleting the static
path first makes the conversions smaller and removes a live second entry point
into activation.

## Migration order

Convert in increasing blast radius, one artifact per commit:

| Order | Module | Role | Why here |
| --- | --- | --- | --- |
| 1 | `commands` | compound, no native service | proves headless activation and contribution registration with no React and no port |
| 2 | `ports` | presentation, one service (`processes`) | smallest presentation case: one navigation item, one surface |
| 3 | `todos` | compound (`project documents`) | adds project-scoped state |
| 4 | `git` | compound | adds the `MODULE_PLATFORM_EVENT_LISTENERS` exception (`git-fs-changed`); resolve or carry it explicitly |
| 5 | `skills` | compound | adds a provider contribution |
| 6 | `thin-terminal`, `semantic-terminal` | presentation | high-frequency presentation; keeps `terminal-presentation` contributions and mount stability (Step 07) |
| 7 | `assistants` | compound | credentials, processes, terminal sessions |
| 8 | `usage` | compound | nine grants, schedules, messages, background effects — the full surface |

Each conversion preserves artifact identity and user-visible behavior. Do not
combine a conversion with a feature change; a mixed commit makes the manifest
diff unreadable.

## Import discipline after conversion

A converted module may import: its own package, stable `@shipctl/module-api`
entrypoints, explicitly permitted pure shared libraries, and React only for a
declared presentation body.

It may not import: `core/frontend` private paths or stores,
`core/frontend/platform`, `AppShell`, canvas adapters, `react-layman`, Tauri
packages, or another module's private path.

These are already enforced by `module-host-import`, `module-api-deep-import`,
`module-sibling-import`, `module-cordis-import`, `module-renderer-import`, and
`module-direct-tauri-event`. This step adds no rule; it must not add an
exception either.

Cross-plugin collaboration goes through declared public services. Asking
`shipctl.workspace@1` to open a view is fine; importing `WorkspaceAuthority` is
not.

## Deactivation invariants

Already implemented by `LivePluginReconciler` / `AtomicRuntimePublication` and
covered by `PROP-F-ATOMIC-001`. Each conversion must not weaken them:

1. the candidate graph validates before the accepted graph changes;
2. the workspace receives a whole accepted catalogue revision, never a partial
   list;
3. instances whose definition disappears enter `missing-definition`, retaining
   their data;
4. effects, schedules, routes, and terminal presentation handlers are disposed
   with the old graph;
5. diagnostics record old identity, new identity, cause, and recovery action.

The realistic regression risk in this step is (4): a contribution registered
through a new registry whose lease is not owned by the activation. Every
registration must return an activation-owned lease — that is why Step 02 makes
`own()` the single disposal mechanism.

## Refactoring actions

1. Delete the static-module path and `adaptShipctlModule` first (with Step 01).
2. Convert the nine entrypoints in the order above, one commit each.
3. Add a per-module test asserting that
   `collectPluginArtifactDeclarations` on the converted activation equals the
   manifest declaration set including requested grants, and that a deliberate
   declaration or grant divergence fails.
4. Move any remaining static visual list into contribution registries and
   workspace profiles (Step 07).
5. Verify each bundled artifact is inspectable without activating its views.
6. Delete `ShipctlModule`, `ModuleHost`, `inferShipctlPluginRole`, and the
   contribution-walking code in `staticPluginRuntime.ts:79-109` in one commit
   after the ninth conversion.
7. Update or delete the `ops/architecture` tests that construct
   `ShipctlModule` values directly; they are the largest remaining consumer and
   will otherwise keep the type alive.

## Validation and exit criteria

- No `modules/*/artifact/src/index.ts` passes a `module:` property.
- `rg "ShipctlModule"` returns no match outside deleted history.
- The manifest↔activation declaration equality test passes for all nine
  modules, and fails on an injected divergence.
- A converted stateful module receives plugin-data access only through its
  admitted grant and activation-derived namespace; no entrypoint depends on a
  host module-id/key allowlist.
- Every bundled module is discoverable and inspectable as an artifact without
  activating a view.
- No converted entrypoint relies on bundled-module seeding or a compiled
  feature-membership list; the same contract is usable by a separately packed
  installed artifact.
- Disabling a module leaves no stale contribution, schedule, route, terminal
  presentation handler, or effect handle in the accepted runtime.
- At least one module activates and exposes operations in the headless runtime
  (Step 03's test bootstrap; Step 10's runtime).
- At least one view from each presentation-capable module can be placed in a
  workspace profile by its declared view identity.
- `CORE_DEEP_IMPORT_EXCEPTIONS` contains no `moduleHostServices.ts` entry
  (Step 02's deletion proof).
