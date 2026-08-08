# Experiments

Six experiments, ordered by how much of the plan they can kill. Each states
the question, the method, the pass condition, and what a failure means for the
rest of the plan. None requires migrating a real module.

Scope is described rather than estimated in days, so the reviewer can size
them against their own knowledge of the codebase.

## Stop rule

E1 and E2 gate everything. If either fails and its fallback also fails, the
"TypeScript modules as installed content" model is not reachable in a packaged
Tauri app on this platform, and the plan should be abandoned in favour of the
build-time ergonomics work described in chapter 04 as the fallback track.

Run E1 and E2 before writing any production code.

## E1 — dynamic ESM from disk in a packaged build

**Question.** Can the packaged WKWebView `import()` an ES module served from
outside the app bundle?

**Why first.** Correction 3 in chapter 01: `script-src` is
`'self' 'wasm-unsafe-eval'` and excludes `asset:`. Also, `devCsp` omits
`script-src` entirely and inherits a `default-src` that *does* include
`asset:`. Dev and packaged builds therefore differ on exactly the axis under
test, so a passing result under `pnpm dev` proves nothing.

**Method.**

1. Add an `app.security.assetProtocol` block with `enable: true` and a scope
   covering `$HOME/.shipctl/modules/**`. No such block exists today.
2. Widen packaged `script-src` to include the asset origin.
3. Write `~/.shipctl/modules/probe/module.mjs` exporting a trivial factory.
4. From the host shell, `import(convertFileSrc(path))` and render the result.
5. Build and run the **packaged** app. Repeat under `pnpm dev` and record any
   divergence.

**Pass.** The module loads and renders in the packaged build, and the CSP
required to do it is written down exactly.

**Fallback if it fails.** Register a custom asynchronous URI scheme in Rust
(`register_asynchronous_uri_scheme_protocol`) and serve module files from it.
This gives per-request control and avoids asset-scope globbing, at the cost of
a small Rust surface. Test the same five steps against it.

**If both fail.** Stop. Chapter 04's fallback track becomes the plan.

**Scope.** Config change, a probe module, a temporary loader call site, one
packaged build.

## E2 — dependency injection and React identity

**Question.** Can a module loaded from disk use the host's React such that
hooks and external-store subscriptions work?

**Why.** Two React instances break hooks quietly. This is the difference
between a working system and one that fails in confusing ways under load.

**Method.**

1. Add the static import map from chapter 02 to `index.html`, mapping `react`,
   `react/jsx-runtime`, `react-dom`, and `zustand` to in-bundle shims.
2. Host boot publishes its singletons onto the shim globals.
3. Build the probe module with `react` and `zustand` marked external and the
   automatic JSX transform enabled.
4. The probe renders a component that uses `useState`, `useEffect`, and a
   `zustand` store created **in the host** and consumed **in the module**, and
   a second store created in the module and consumed in a host-rendered
   component.
5. Assert `moduleReact === hostReact` by identity, not by behaviour.

**Pass.** Identity holds, hooks work in both directions, and
`useSyncExternalStore` propagates across the boundary.

**Watch for.** `react/jsx-runtime` is emitted by the JSX transform even though
no source file imports it; omitting its shim fails late and confusingly.

**Fallback.** Generate the import map at boot and inject it before the first
module import. This depends on WebKit accepting a map injected after document
parse, which is the uncertainty the shim design exists to avoid — so treat it
as a fallback, not a default.

**Scope.** Six or so shim files, an `index.html` change, probe module build
config, one assertion harness.

## E3 — module build pipeline and artifact size

**Question.** Can each module be built to a self-contained ESM artifact, and
how large is the worst one?

**Method.**

1. Write a shared Vite library-mode preset: ESM output, `react`,
   `react/jsx-runtime`, `zustand`, and (transitionally) `@tauri-apps/api`
   external; CSS emitted as a sibling `module.css`.
2. Build `fixture` (floor) and `git` (ceiling — `shiki`, `markdown-it`,
   `@pierre/diffs`, `@pierre/trees`).
3. Record artifact sizes and cold `import()` time in the packaged app.

**Pass.** Both build and load. `git`'s size and load time are recorded and
judged acceptable, or a mitigation is identified (lazy `shiki` grammar
loading is the obvious one).

**Note on CSS.** Library mode emits CSS as a separate file rather than
injecting it. Prefer that: the shell adds a `<link>` per activated module and
removes it on deactivation, which gives teardown a handle it would not have if
CSS were inlined into JS. This is a small win that only shows up in E6.

**Decision this experiment forces.** Whether `lucide-react` is externalised
too. Seven of eight modules use it; bundling it per module duplicates it seven
times. Unlike React, duplication is merely wasteful rather than incorrect, so
this is a size decision, not a correctness one.

**Scope.** One preset, two builds, a measurement table.

## E4 — manifest coverage

**Question.** Can `contributes:` in `module.yaml` describe the full
declarative surface of all eight existing modules with no residue?

**Why.** If some contribution cannot be expressed as data, the manifest-first
composition in chapter 02 does not hold, and the shell would have to load
module code to build the UI — which reintroduces eager loading.

**Method.** Mechanical, no runtime. For each module, transcribe its
contributions from `index.ts` into a draft `contributes:` block. Then write a
codegen check that derives the block from the code object and diffs it against
the manifest, so the two cannot drift during migration.

**Pass.** All eight modules transcribe cleanly. Any contribution that resists
being data is listed explicitly with the reason.

**Known suspects.** `projectFactsProvider` and `projectImport` carry functions
(`getFacts`, `subscribe`, `refresh`) rather than data — these are behaviour and
belong in the runtime object, but the host must know *that a module provides
them* before loading it. Expect the manifest to need a declaration flag
(`providesProjectFacts: true`) distinct from the implementation.

**Scope.** Paper exercise plus one codegen check. Can run in parallel with
E1–E3.

## E5 — mediated native port

**Question.** Does routing `invoke` and `listen` through
`ModuleHostServices.native` work without behaviour change, and does manifest
permission checking catch undeclared calls?

**Method.** Migrate `todos` — the smallest module with a native edge — off
`@tauri-apps/api` onto the port. Run its existing tests. Then add a call to a
command not in its manifest and confirm a structured rejection.

**Pass.** No behaviour change; undeclared calls rejected with a useful error.

**Also determines.** Whether `Channel` (used only by `assistants`) needs a
port shape of its own, and whether `listen` unsubscription can be tied to
module deactivation. The second matters for E6.

**Scope.** One module migrated, port implementation, permission check.

## E6 — disposal and hot-swap

**Question.** Can a module be removed from a running application without
leaving ghost UI, listeners, timers, styles, or store subscriptions?

**Why last.** v1 is restart-first precisely so this is not on the critical
path. Run it only when v1 works.

**Method.**

1. Add `unregister()` to `PanelRegistry` and `GlobalSurfaceRegistry`.
2. Make every registration return a disposable owned by the module instance.
3. Activate a module, open its panels, start its scheduled tasks and event
   listeners, then deactivate.
4. Assert: no registry entries, no `<link>` for its CSS, no live `listen`
   handles, no pending timers, no retained store subscriptions.

**Pass.** All five assertions hold, and repeating activate/deactivate in a
loop shows no growth.

**Scope.** Two registries, the disposable tree in `activateModules`, one
leak-assertion harness.

## Order

```text
E1 ─┬─> E2 ─> E3 ─> E5 ─> v1 ─> E6 ─> v2
    │
E4 ─┘   (independent, run in parallel)
```

E4 is independent of the loading mechanism and can start immediately; it is
also the experiment most likely to be done by an agent rather than a human,
since it is mechanical transcription with a codegen check to verify it.
