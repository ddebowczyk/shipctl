# Dynamic TypeScript extensions on a static Tauri core

Status: proposal for senior review. No implementation. Three experiments in
chapter 03 must pass before chapter 04 is worth scheduling.

Snapshot: 2026-08-08 on `main` at `cd48d6a`.

## The ask

- Rust and the Tauri command surface stay static. Changing them means a
  recompile, and that is acceptable.
- TypeScript capabilities are content: installable, replaceable, and
  removable without recompiling the application.
- Every module that exists today becomes that kind of content, running on the
  static Tauri core through a thin TypeScript shell that loads it.

## Bottom line

This is feasible, and the existing `ShipctlModule` contract is most of the
way there — but not for the reason stated in earlier analysis. Three claims
made before this plan were wrong, and correcting them changes the work:

1. Module coupling to the host is **not** near zero. All eight modules import
   `@tauri-apps/api` directly for `invoke`, `listen`, and `Channel`.
   `ModuleHostServices` is not the only channel to native; it is one of two.
2. Vite does **not** already code-split modules apart. Only panel components
   sit behind `load: () => import(...)`. Each module's `index.ts`, its store,
   and its CSS are statically imported by `core/frontend/host/enabledModules.ts`
   and land in the main chunk.
3. The current CSP **forbids** the entire approach. `script-src` is
   `'self' 'wasm-unsafe-eval'`, so a dynamic `import()` of a module served from
   the asset protocol fails before any other design question is reached.

Correcting these turns a "mostly done" story into four real pieces of work:
manifest-first composition, a module build pipeline, a mediated native port,
and a CSP change that is a deliberate security decision rather than a config
tweak.

## Shape of the target

| Layer | Mutability | Contents |
| --- | --- | --- |
| Rust / Tauri core | recompile | all module plugins, always registered; fixed capability superset; a small module-registry command surface |
| TypeScript host shell | recompile | boot, import map, registries and disposal, host services, discovery, enablement, layout, terminal, projects, settings, appearance |
| TypeScript modules | install / replace / remove | pre-built ESM plus a declarative manifest, loaded from disk |

Builtin modules ship inside the bundle in the **same artifact format** as
user-installed ones and load through the same path. That is what makes
"all current modules become installable content" true rather than aspirational.

## Two decisions that shrink the problem

**Restart-first.** Install, enable, and disable take effect on webview reload
in v1. This removes correctness pressure from teardown, which is the single
largest source of ghost-state bugs. Runtime hot-swap is v2 and is gated on
disposal being real. VS Code required a reload for exactly this reason for
most of its life.

**Native stays compiled and always registered.** The user has accepted a
static Rust core, so module enablement no longer needs Cargo features or
generated Tauri profiles. The capability allowlist becomes a fixed superset,
and enablement moves entirely into TypeScript-side data.

## Chapters

1. [Current state and corrections](01-current-state-and-corrections.md)
2. [Target architecture](02-target-architecture.md)
3. [Experiments](03-experiments.md)
4. [Migration and sequencing](04-migration-and-sequencing.md)
5. [Risks, decisions, and open questions](05-risks-and-decisions.md)

## What this plan deliberately does not do

It does not build a microkernel. It does not add process isolation, WASM, or
isolated webviews. It does not attempt enforceable sandboxing of module code —
chapter 05 states plainly why in-webview isolation cannot be enforced and what
that costs. Those remain the province of
[`docs/plans/fully-modular-tauri/`](../fully-modular-tauri/README.md), which
this plan is a strict subset of and does not contradict.
