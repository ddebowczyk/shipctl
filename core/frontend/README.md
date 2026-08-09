# `@shipctl/core` — the host's own capabilities (frontend)

Everything the app does that is *not* a pluggable module lives here, split by
capability rather than by file kind. A capability owns its logic, its stores,
its components and its assets in one directory, so that changing one concern
touches one directory.

`core/backend/` is the Rust half of the same split, capability for capability —
see `../backend/README.md`.

## Layout

| Directory | Owns | Depends on |
| --- | --- | --- |
| `platform/` | Tauri IPC bindings, the types those calls exchange with Rust, error extraction | nothing |
| `shared/` | building blocks that more than one capability already imports: notices, UI state, `ContextMenu`, `a11y`, tab-kind metadata, well-known surface ids | `platform` |
| `appearance/` | themes, custom themes, fonts (`fonts/`), `globals.css`, terminal colour derivation | `platform` |
| `terminal/` | host terminal projection, xterm views/replay, terminal + keybinding stores, module session adoption | `platform`, `shared`, `appearance` |
| `settings/` | user preferences not owned by another capability: editor choice and its logos (`logos/`) | `platform` |
| `projects/` | repositories, grouping for the navigation, per-project settings, module-contributed project facts | `platform`, `shared` |
| `host/` | module activation and composition, `ModuleHostServices`, panel and global-surface registries, module session chrome | every capability above |
| `shell/` | **not a capability** — the app shell, tab bar, sidebar, settings panel, theme applicator and updater: the one place allowed to combine several capabilities into a single screen | everything |

`shell/` sits inside this package because it is frontend code and belongs next to
what it composes, but it is the one directory here that is *not* reusable and not
a capability. Nothing may import it except `src/main.tsx`, which is now the whole
of `src/` alongside `vite-env.d.ts`. If you find yourself importing
`@shipctl/core/shell` from a capability, the thing you want has to move down into a
capability instead — see rule 4 below.

The host runtime imports **concrete capability files**, never capability
barrels: `@shipctl/core/terminal` pulls in `@xterm/xterm`, which is CommonJS and
breaks the vite-SSR test lanes.

## Where does a new file go?

Answer in this order; the first match wins.

1. **Does exactly one capability use it?** Put it in that capability's directory.
   This is the common case and it needs no discussion.
2. **Do two or more capabilities already use it?** Put it in `shared/`.
   "Already", not "might" — a file does not earn a place in `shared/` by
   speculation.
3. **Does it talk to Rust?** It belongs in `platform/`, regardless of who calls it.
4. **Does it combine several capabilities into one screen?** It is not a
   capability member. It is a composition surface and belongs in `shell/`.
   `SettingsPanel` is the worked example: it reads project settings, repo state,
   terminal settings and themes at once, so no single capability can own it and
   no ordering of the capabilities makes its imports point one way.
5. **None of the above?** The capability boundaries are wrong for what you are
   building. Say so and fix the boundaries rather than parking the file in the
   nearest directory.

Assets follow their consumer. Editor logos sit in `settings/logos/` and terminal
fonts in `appearance/fonts/` because that is who reads them; a top-level
`assets/` bucket is what this layout exists to avoid.

## Two mechanical rules

**Every capability is a package export.** Cross-capability imports go through
`@shipctl/core/<capability>`, never through a relative path into another
capability's files. The `exports` map in `package.json` is the public surface,
and it resolves identically in Node, `tsc` and Vite — which is why capabilities
are a workspace package rather than a `tsconfig` path alias.

**`index.ts` is JSX-free; `views.ts` carries React.** The `node --test` lanes run
through Node's type stripping, which handles `.ts` but not `.tsx`. A capability
with components therefore exports two entry points: `@shipctl/core/terminal` for
logic and `@shipctl/core/terminal/views` for components. Re-exports inside these
files carry explicit `.ts`/`.tsx` extensions, because Node's ESM resolver does
not guess them.

## Enforcement

`just modularity boundaries` rejects cross-capability deep imports, files left
under `src/`, app imports into `ops/`, and host/module direction violations.
Cross-capability imports use an exported `@shipctl/core/<capability>` entrypoint;
`platform/` and `shared/` remain leaf foundations that may be imported directly.

The checker carries exact exceptions for the host-service adapter's concrete
store/session imports. Loading the corresponding barrels there would pull the
whole UI and xterm into Node test lanes. New deep imports are still rejected.
