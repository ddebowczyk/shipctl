# Risks, decisions, and open questions

## Decisions this plan makes

1. Rust and the Tauri command surface stay static. All module plugins compile
   in and register unconditionally.
2. Enablement is TypeScript-side data, held in `~/.shipctl/config.yml`.
3. Builtin modules ship in the same artifact format as installed ones and load
   through the same path.
4. Contributions are declarative data in the manifest; only behaviour stays in
   code.
5. v1 is restart-first. Hot-swap is v2, gated on real disposal.
6. Modules reach native only through a mediated port, checked against the
   manifest's declared permissions.
7. Dependency injection uses a static import map pointing at in-bundle shims,
   not a runtime-generated map.
8. Third-party module installation stays **off** until the isolation question
   below is answered. The mechanism ships; the open door does not.

## Risk 1 — in-webview isolation cannot be enforced

Every module shares one webview with the host shell. A module that bundles its
own `@tauri-apps/api`, or simply reads `globalThis.__TAURI_INTERNALS__`, calls
any allowlisted command regardless of what its manifest declares. It can also
read host state, patch prototypes, and reach the DOM.

The permission check in chapter 02 is therefore **advisory**. It is still worth
building: it makes intent explicit, gives an audit point, catches honest
mistakes, and is the same check a future enforcing boundary would apply. But
it must not be described to users as a security boundary.

Enforcement requires the process or isolated-webview boundary from
[`docs/plans/fully-modular-tauri/`](../fully-modular-tauri/README.md) chapters
04 and 07. Until then the honest trust model is the one pi states outright:
modules run with the application's full authority, and the user must trust
their source.

**Consequence for decision 8.** First-party builtins and locally developed
modules are fine under this model. An open third-party ecosystem is not.

## Risk 2 — widening `script-src` is a real security change

Today `script-src` is `'self' 'wasm-unsafe-eval'`. Allowing script from the
asset origin means anything that can write to `~/.shipctl/modules/` can execute
code inside the application's webview with all of its capabilities.

The mitigating argument is that on a single-user desktop, anything that can
write there can already write to the user's shell profile, so the marginal
authority gained is small. That argument is sound but it is an argument, not a
proof, and it should be made explicitly to a reviewer rather than assumed.

The custom URI scheme fallback from E1 is meaningfully better here: it lets
Rust decide per request what to serve, so the policy can be "only files under
the modules directory, only `.mjs` and `.css`, only for installed and enabled
module ids" rather than a blanket origin grant. **If E1's primary path and its
fallback both work, prefer the custom scheme** even though it costs more Rust.

## Risk 3 — losing the narrow per-build capability profiles

`profiles/*-disabled/tauri.conf.json` currently produce builds whose capability
set genuinely excludes a disabled module's permissions. A fixed superset is
broader than any of those profiles.

This is a real reduction in defence depth, traded for the ability to toggle
without recompiling. It is the direct cost of the user's stated constraint, and
it should be accepted knowingly. If it is not acceptable, the alternative is a
runtime capability broker in Rust that checks the calling module id — which
requires the host to prove which module is calling, which brings back Risk 1.

## Risk 4 — `ModuleHostServices` becomes a public API

Once modules live outside the repository, `ModuleHostServices` and the manifest
schema stop being internal contracts. Changing them breaks installed modules.
This is the first risk listed in `fully-modular-tauri`
chapter 11 and it applies here in full.

Mitigations: keep the port narrow, version it with `api_version`, add
compatibility fixtures that build an old-shaped module against the current host
and assert it still loads. Do this at phase 2, not after the surface has grown.

## Risk 5 — duplicate React

If any module artifact bundles React, hooks break in ways that look like
application bugs. E2 proves the mechanism works; nothing stops a future module
build from regressing it.

Mitigation: a CI check that greps each built artifact for a React signature and
fails if found. Cheap, and it catches the failure at build time rather than at
runtime in a user's session.

## Risk 6 — artifact size and cold load

`git` pulls `shiki`, `markdown-it`, `@shikijs/markdown-it`, `@pierre/diffs`,
and `@pierre/trees`. E3 measures it. If cold `import()` is slow enough to be
visible when the panel first opens, the mitigations are lazy `shiki` grammar
loading, prefetch on idle, or keeping `git` builtin-only until it is trimmed.

## Risk 7 — debuggability

A module loaded from disk with no source map is much harder to debug than one
in the main bundle, and errors will attribute to the shell rather than to the
module. The build preset must emit source maps, and `reportModuleFailure` must
name the module id and artifact path in every failure it reports.

## Requirement — the agent development loop

The motivation for this work is that agents should be able to add and modify
capabilities. That imposes a requirement the phases above do not yet satisfy: a
developer or agent must be able to point the application at a module **source**
directory and have changes take effect without a package step.

VS Code solves this with the Extension Development Host (`F5`); pi solves it
with `-e ./path.ts` and auto-discovery of `.pi/extensions/`. Shipctl needs the
equivalent: a dev-mode module path, watched and rebuilt, loaded ahead of
builtins. Without it, the agent loop is edit → build → install → reload, which
is slow enough that agents will keep editing the repository instead — and the
whole exercise gains nothing over the fallback track.

This should be scheduled in phase 2, not deferred, because it is what the
feature is *for*.

## Open product questions

- Third-party modules ever, or first-party plus local development only? This
  determines whether the isolation work in `fully-modular-tauri` is on the
  roadmap or off it.
- Is enablement global, or per project? `ModuleSettingsPort` is global today;
  per-project would follow the workspace config in
  `core/backend/src/workspace/config.rs`.
- Does removing a module delete its data?
- Should user-installed modules require a signature, given the fork now owns
  its own signing key?

## Open technical questions

- Asset protocol or custom URI scheme? Risk 2 argues for the latter; E1
  decides whether both are viable.
- Is the fixed capability superset acceptable, given Risk 3?
- Externalise `lucide-react`? Seven of eight modules use it.
- What is the `api_version` support window — how many host versions must
  accept an old module?
- Does `skills` need a `react` peer dependency added? It is the only module
  without one, which looks like an oversight independent of this plan.

## Stop conditions

Pause and re-plan if:

- a packaged build cannot load module code from disk under any policy the
  reviewer will accept;
- React identity cannot be guaranteed across the boundary;
- manifest data cannot describe a module's contributions without loading its
  code, which would defeat lazy activation;
- the mediated native port requires exposing arbitrary internal commands;
- disabling a module cannot be made visually and operationally complete, even
  with a reload;
- `git`'s artifact is large enough that first-open latency is worse than the
  status quo and cannot be mitigated;
- the dev loop for an agent-authored module is slower than editing the
  repository directly.
