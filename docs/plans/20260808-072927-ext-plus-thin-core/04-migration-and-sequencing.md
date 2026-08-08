# Migration and sequencing

## Principle

Front-load the work that pays off even if the dynamic loading never ships.
Phase 1 is valuable on its own, is reversible, and carries no platform risk.
Everything after it depends on E1 and E2 passing.

## Pilot order

| Order | Module | Why here |
| --- | --- | --- |
| 1 | `fixture` | Exists to be a test fixture. One native call (`ping`). Nothing user-visible breaks if it misbehaves. |
| 2 | `commands` | Only module with no native edge. Real UI, real store, real CSS. Proves the loading path without the native port. |
| 3 | `todos` | Smallest module with a real native edge. First user of the mediated port. |
| 4 | `ports`, `skills` | Small, independent, no cross-module coupling. |
| 5 | `usage` | Uses `listen` in two places plus a scheduled refresh. Exercises event teardown. |
| 6 | `assistants` | Only user of `Channel`. Owns PTY-adjacent lifecycle and `beforeShutdown`. |
| 7 | `git` | Heaviest dependencies, largest contribution surface, the project-facts provider. Last on purpose. |

## Phase 0 — experiments

Chapter 03. E1 and E2 gate everything. E4 runs in parallel.

**Exit gate.** E1, E2, E3, and E4 pass, and the required CSP is written down
and reviewed as a security change rather than a config edit.

## Phase 1 — manifest-first composition, still statically bundled

No dynamic loading. Contributions move from TypeScript object literals into
`module.yaml` under `contributes:`; the host builds its registries from that
data; module code still arrives through the existing static imports.

- Extend `ops/modularity/schema/module.schema.yaml` to `schema_version: 2`
  with `contributes`, `api_version`, and `permissions`.
- Add the codegen check from E4 so manifest and code cannot drift.
- Registries populate from manifest data; `moduleComposition.ts` reads
  contributions from manifests and matches component loaders by contribution
  id.
- Add `just modularity new <id>` generating every touchpoint from one manifest.
- Write `ops/modularity/skills/adding-a-module/SKILL.md`. That directory
  currently holds a README saying procedures live there, and
  `ops/modularity/capability.yaml` declares `skills: []`.

**Exit gate.** All eight modules declare contributions in their manifest; the
UI is built from manifest data; the drift check passes in CI; adding a module
is one generator invocation plus implementation.

**Value if the plan stops here.** The five-system membership problem collapses
to one file, and the missing procedure exists. This is the fallback track.

## Phase 2 — loader, shims, artifact format

- Vite library preset producing `module.mjs` plus optional `module.css`.
- Import map and shim files in the host shell.
- Rust: asset scope (or custom URI scheme, per E1's outcome) and
  `modules_list`.
- Builtin modules built into `resources/modules/<id>/` at package time.
- `fixture` and `commands` load dynamically; the remaining six still load
  statically. Both paths coexist behind one composition entry point.

**Exit gate.** A packaged build runs with `fixture` and `commands` loaded from
disk, and deleting their directories degrades gracefully rather than crashing.

## Phase 3 — migrate the remaining modules

Pilot order 3 through 7. Each module: build to artifact, migrate off
`@tauri-apps/api` onto the native port, verify existing tests.

At the end of this phase:

- `core/frontend/host/enabledModules.ts` is deleted.
- `profiles/*-disabled/` and the `profiles-check` / `profiles-sync` commands
  are retired; the capability set becomes a fixed superset.
- `NATIVE_MODULE_FEATURES` in `ops/modularity/bin/plugout.mjs` stops being an
  enablement list; the plugout proof changes meaning to "the shell runs with
  this module absent from disk", which is both cheaper to run and closer to
  what users will actually do.
- The `@tauri-apps/api` entries are removed from the import map. That removal
  is the checkpoint proving the native migration is complete.

**Exit gate.** Every module loads from disk. No module imports
`@tauri-apps/api`. `rg "@tauri-apps" modules/*/frontend/src` returns nothing.

## Phase 4 — lifecycle and management UI

- `modules_install`, `modules_remove`, `modules_set_enabled`.
- Enablement in `~/.shipctl/config.yml` under `modules:`.
- A settings surface listing installed modules with source, version, and
  enablement — host-owned, not module-contributed.
- Install and enable take effect on webview reload.

**Exit gate.** A module can be installed, disabled, re-enabled, and removed
from the running application with a reload, without a rebuild.

This is the phase that satisfies the original ask.

## Phase 5 — hot-swap

E6. Disposal, then activate/deactivate without reload.

**Exit gate.** Repeated activate/deactivate cycles show no registry, listener,
timer, style, or subscription growth.

## Interaction with the updater

Two cases, and they differ:

- **Builtin modules** live inside the bundle and are replaced wholesale by an
  app update. No compatibility question.
- **User-installed modules** live in `~/.shipctl/modules/` and survive app
  updates. An app update can therefore move the host past a module's declared
  `api_version`. The shell must refuse to load incompatible modules and say so
  in the management UI rather than failing at a random call site.

This is the `engines.vscode` problem, and the mitigation is the same:
declare a range, check it before loading, report clearly. Worth stating
explicitly because the fork now owns its own update channel and signing key
(`docs/plans/20260807-115937-fork-release-identity/`), so shipping a host
update that silently breaks installed modules is a reachable failure.

## Ops capability changes

| Command | Change |
| --- | --- |
| `just modularity new <id>` | new — scaffold from one manifest |
| `just modularity build <id>` | new — produce the module artifact |
| `just modularity profiles-check` | retired at phase 3 |
| `just modularity profiles-sync` | retired at phase 3 |
| `just modularity plugout <module>` | redefined — absence from disk, not from build |
| `just modularity boundaries` | extended — modules must not import `@tauri-apps/api` or `@shipctl/core` |

`ops/modularity/capability.yaml` needs its `owns`, `generates`, `commands`,
and `skills` fields updated to match. The `generates:
profiles/*-disabled/tauri.conf.json` entry goes away.

## Fallback track

If E1 or E2 fails with both fallbacks exhausted, stop after phase 1 and take
only these:

- manifest-first composition and the drift check;
- `just modularity new <id>`;
- `ops/modularity/skills/adding-a-module/SKILL.md`;
- optionally, dynamic `import()` of module entrypoints **from inside the
  bundle**, which needs no CSP change and still lets enablement be a runtime
  setting rather than a build flag.

That last item is worth noting: it delivers *runtime enable and disable of
shipped modules* without any of the platform risk. It does not deliver
installable third-party content. If the reviewer wants to de-risk hard, this
is the version to build first — it is phase 1 plus a dynamic import of
in-bundle chunks, and it satisfies "no recompilation to turn a capability on
or off" while leaving "installable content" for later.
