---
upstream: "4dce7ea"
subject: "Integrate next-release dependency upgrades"
authored: "2026-08-06"
reviewed: "2026-08-07"
verdict: adapt
integration: replace
seam: workspace.dependencies
areas: [build, dependencies, git]
bd: [shep-he0]
integrated: "4bf779e"
---

## What upstream did

Completed a broad JavaScript and Rust dependency refresh, migrated markdown-it 15 APIs,
raised the Rust toolchain floor, and replaced the custom icon script with Tauri tooling.

## Why it matters to us

Several upgrades are useful, but the patch assumes the upstream monolith and deletes or
edits paths whose ownership changed in the fork.

## Mapping into our tree

Rust upgrades span the core and module workspaces; markdown changes belong in
`modules/git/frontend/`; icon and root package changes must be judged against current ops
ownership. Upstream lockfiles cannot be adopted verbatim.

## Seam feedback

The workspace manifests provide the seam, but there is no single monolithic dependency
surface anymore. Compatibility must be checked per owning package and crate.

Two frictions surfaced while landing this, neither in scope here:

- `tauri` is declared verbatim in ten crate manifests. A `[workspace.dependencies]` entry
  would make the next Tauri bump one edit instead of ten.
- `modules/git/frontend/src/` imports relative modules without file extensions, which the
  bundler resolves and Node does not. Two were fixed because the markdown tests need them;
  the rest still block `node --test` coverage of that module.

## Verdicts

Accepted, landing in the owning manifest rather than a root-only one:

| Change | Landed | Evidence |
| --- | --- | --- |
| Vite 7.3.1 → 8.2.1 | root | build, dev server, and all gates green; 4 advisories cleared |
| `@vitejs/plugin-react` → 6.0.5 | root | required by Vite 8; both new peers are optional |
| `@tauri-apps/api` → 2.11.1 | core + 7 modules | typecheck and build green |
| `@tauri-apps/cli` → 2.11.4, `plugin-dialog` → 2.7.2, `plugin-updater` → 2.10.1 | root | build green |
| `tailwindcss` + `@tailwindcss/vite` → 4.3.3 | root | build green |
| `lucide-react` 0.577 → 1.30.0 | root + 6 modules | typecheck and build green |
| `shiki` + `@shikijs/markdown-it` → 4.4.2 | modules/git | typecheck, build, markdown tests green |
| markdown-it 14 → 15 | modules/git | 9 characterization tests pass on both 14 and 15 |
| `@types/markdown-it` removed | modules/git | markdown-it 15 ships its own types |
| `@pierre/diffs` → 1.3.5 | modules/git | build green |
| Tauri 2.10.3 → 2.11.5, tauri-build → 2.6.3 | all 10 crates | `cargo check`, `cargo test`, clippy at baseline |
| `portable-pty` 0.8 → 0.9, `notify` 7 → 8, `core-text` 21 → 22 | core/backend | ditto |
| `rusqlite` 0.33 → 0.40 | modules/usage | ditto |

Adapted rather than adopted:

- **`rust-version`.** Upstream raised the floor to 1.95. Measured against this repo's
  resolved tree, the true floor is **1.88** — the highest declared MSRV among all 626
  locked crates (`home` 0.5.12 and `time` 0.3.47). The fork's previous 1.77.2 was already
  understated; 1.95 overstates it by seven releases with nothing requiring it. Set to 1.88
  in `[workspace.package]`, and the two crates that repeated the literal now inherit it.
  `fix-path-env` is a git dependency and publishes no index metadata, so it is excluded
  from that measurement.
- **markdown-it 15 linkify.** The upgrade turns off bare-domain linkification, so
  `markdown.linkify.set({ fuzzyLink: true })` restores it. Verified by deleting the line
  and watching the bare-domain test fail, then restoring it.
- **`sharp`.** Upstream deleted `generate-icon.mjs` for `tauri icon`. Rejected: that
  script composites the SVG logo with padding and rounded corners, which `tauri icon` does
  not do — it consumes an already-composited PNG. Bumped `sharp` to 0.35.3 instead, which
  clears the libvips advisories and keeps the capability. The regenerated
  `assets/icon-1024.png` is byte-identical.

Rejected:

- **TypeScript 7.0.2.** `tsc --noEmit` passes, but the compiler API our ops tooling uses is
  not at the package's default entry any more: under 7.0.2 `import ts from "typescript"`
  yields exactly two exports, `version` and `versionMajorMinor`, so
  `ops/modularity/bin/check-module-boundaries.mjs` fails at `ts.ScriptTarget.Latest` and
  `ops/modularity/bin/plugout.mjs` fails the same way. The API is not gone — it moved to
  `typescript/unstable/*` and was redesigned around projects, snapshots and node handles,
  without single-file `createSourceFile`, `forEachChild`, `isStringLiteralLike`, or the
  position helpers both scripts use for diagnostics. Adopting TypeScript 7 therefore means
  reworking both scripts against a different parser, which is its own piece of work.
  TypeScript 7 also removes `baseUrl`, which
  `ops/modularity/fixtures/module-fixture/tsconfig.json` still sets. Full evidence, affected
  API list and options in
  `research/handoffs/2026-08-07T1904-typescript-7-compiler-api.md`.
- **`pnpm.overrides`.** See `4bd529f.md`.
- **`"icons": "tauri icon assets/shep.png"` script.** Belongs to the ops build capability
  in this tree, not to the root package manifest.
