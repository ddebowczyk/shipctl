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
