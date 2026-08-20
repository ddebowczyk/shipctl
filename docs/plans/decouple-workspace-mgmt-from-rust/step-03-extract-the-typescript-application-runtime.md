<!-- markdownlint-disable MD013 -->

# Step 03 — Move the existing runtime out of React

## Outcome

The application runtime already exists. `AppShell.tsx` owns its *lifetime*, not
its logic. This step relocates construction and gives the runtime an explicit
lifecycle owner outside React. It adds no new composition root and no new facade
type.

## The precise problem

`core/frontend/shell/AppShell.tsx` constructs the runtime in two places:

- module scope, lines 124-140: `SEMANTIC_SERVICE_PROVIDERS` (nine providers),
  `SEMANTIC_SERVICES`, `CORE_ACTIVATION`, `CORE_MODULE_ACTIVATIONS` — evaluated
  at import time, so importing the shell starts service construction;
- a single mount effect, lines 429-582: `WorkspaceAuthority.open` with a
  fallback to `InMemoryWorkspacePersistence`, `WorkspaceCanvasBridge`,
  `AcceptedWorkspaceCatalogController`, and `LiveModuleSupervisor` with five
  more inline providers (workspace, messages, scheduler, terminal sessions,
  semantic terminals), plus `publish`, `reportApplied`, and `reportRejected`
  callbacks that push user notices.

Consequences that matter beyond tidiness:

1. **The runtime cannot start without React.** There is no way to activate the
   accepted graph in a `node --test` lane or headless process, which blocks
   Steps 06 and 10 outright.
2. **Provider composition is split across module scope and effect scope**, so
   which providers exist depends on where the code runs.
3. **Failure reporting is a `pushNotice` call.** A rejected runtime revision is
   reported as a transient toast (lines 548-563) with the structured record sent
   separately to `reportModuleReconciliationFailure`. An agent cannot read the
   toast, and the notice is the only thing a user sees.
4. **Persistence failure silently degrades to in-memory** (lines 443-456) with a
   notice. The workspace then accepts writes that will never survive restart.
   That is a correctness decision made in a React catch block.

## The rule for this step

> Nothing may be created here that is not already created in `AppShell.tsx`.

The deliverable is a `core/frontend/runtime` entrypoint that accepts injected
ports and returns the same objects AppShell builds today, plus start/dispose.
If the diff introduces a new abstraction, an interface with one implementation,
or a "runtime facade" wrapping `LiveModuleSupervisor`, it has failed the step.

`core/frontend/runtime` already exports `SemanticServiceRegistry`,
`LivePluginReconciler`, `AtomicRuntimePublication`, `createActivationHostServiceGate`,
`assertCompleteRuntimeFamily`, and `CordisStaticPluginRuntime`. The new
entrypoint composes those. `LiveModuleSupervisor` (currently in
`core/frontend/host`) moves to `core/frontend/runtime` because it is the
lifecycle owner, and the new `runtime-import-boundary` rule from Step 01 will
then hold it React-free.

## Inputs and outputs

Inputs are ports, supplied by whoever starts the runtime:

| Input | Supplied today by |
| --- | --- |
| Native semantic service providers | the nine `create*ServiceProvider()` calls at `AppShell.tsx:124-133` |
| Activation-scoped provider factories | the five inline factories at `AppShell.tsx:492-510` |
| Workspace persistence port | `createTauriWorkspacePersistencePort()` (`AppShell.tsx:440`) |
| Artifact source, admission, and effective grants | `moduleArtifactLoader` / `runtimeModuleLoader` via the supervisor; the accepted admission binding reaches host-side providers, not plugin code (Step 02) |
| Diagnostics sink | `reportModuleReconciliationFailure` + `publishFrontendRuntimeSnapshot` |

Outputs are a subscribable accepted snapshot, the semantic service resolver, the
contribution catalogue, and lifecycle controls. React subscribes; it does not
construct.

## Lifecycle model

The candidate→publish sequence is already implemented by `LivePluginReconciler`
and `AtomicRuntimePublication` and is proved by `PROP-F-ATOMIC-001`. Do not
re-specify it. Two things this step must fix in it:

1. **Persistence degradation becomes an explicit mode, not a catch block.** If
   the durable port is unavailable, the runtime starts in a named
   `persistence: "unavailable"` state that is visible in the accepted snapshot
   and in CLI inspection, and workspace writes fail loudly rather than
   succeeding into memory. Falling back silently to `InMemoryWorkspacePersistence`
   in production is a data-loss path disguised as resilience.
2. **Rejection reporting is structured first.** The runtime emits a diagnostic
   record; React maps selected records to `pushNotice`. The notice references
   the diagnostic id. No failure may exist only as a toast.

## Bootstrap variants

| Composition | Ports | Purpose |
| --- | --- | --- |
| Tauri UI | all platform adapters + React renderer | desktop app |
| Test | deterministic fakes from `@shipctl/module-api/testing` + fixture artifacts | contract and property tests |
| Headless | durable records + explicitly allowed non-UI ports | Step 10 |

`module-api/frontend/src/testing/*` already provides fakes for every semantic
service (assistant launch, credentials, git, messages, plugin data, processes,
project documents, scheduler, semantic services, semantic terminals, skill
installation, terminal sessions, usage sources). The test bootstrap composes
those; it does not need new doubles.

The test bootstrap is the **exit criterion**, not an optional extra: without it
this step cannot be shown to have removed the React dependency.

## Refactoring actions

1. Move `liveModuleSupervisor.ts` from `core/frontend/host` to
   `core/frontend/runtime`; confirm `runtime-import-boundary` (Step 01) passes.
2. Add a runtime entrypoint that takes the ports listed above and performs the
   construction currently in `AppShell.tsx:124-140` and `429-582`, unchanged.
3. Make provider composition a single ordered list supplied by the caller;
   remove the module-scope/effect-scope split and the import-time side effect.
4. Replace the in-memory persistence fallback with an explicit degraded mode
   surfaced in the accepted snapshot.
5. Emit structured diagnostics for applied and rejected revisions; have React
   subscribe and map to notices by diagnostic id.
6. Reduce `AppShell` to: subscribe to the snapshot, hold canvas model/actions/
   ports, render `CanvasHost`. Its remaining `useEffect`s should be listeners,
   timers, and imperative integrations only, per `CLAUDE.md`.
7. Add the in-memory test bootstrap and one activation test with no DOM.
8. Leave `src/main.tsx` alone in this step; the `get_canvas_adapter` bootstrap
   dependency is Step 05's.

## Validation and exit criteria

- A `node --test` case starts the runtime with fixture artifacts and fake ports,
  activates a plugin, resolves a service, and disposes — with no DOM and no
  `@tauri-apps/*` in the import closure.
- `AppShell.tsx` constructs no `SemanticServiceRegistry`, `WorkspaceAuthority`,
  `WorkspaceCanvasBridge`, `AcceptedWorkspaceCatalogController`, or
  `LiveModuleSupervisor`, and has no module-scope service construction.
- Importing `@shipctl/core/shell` performs no service construction
  (`module-entrypoint-side-effect` reasoning, applied to the host).
- `runtime-import-boundary` passes with no exception entry.
- A failed candidate graph leaves the prior accepted revision, catalogue, and
  effects unchanged — existing `PROP-F-ATOMIC-001` evidence still replays.
- With the durable port unavailable, the runtime reports a degraded persistence
  mode and workspace writes fail with a structured error; no write silently
  lands in memory.
- Every activation failure is retrievable from the diagnostics stream after the
  notice has been dismissed.
