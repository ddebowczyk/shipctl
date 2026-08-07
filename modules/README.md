# Modules

`modules/` contains features that can be removed from a build. A normal module
owns a public frontend package under `frontend/` and, when native behavior is
needed, a feature-gated Tauri plugin under `backend/`.

Two directories are intentionally different:

- `api/` is the narrow host-to-module contract for both TypeScript and Rust. It
  is a leaf dependency, not a feature module.
- `commands/` is frontend-only because it contributes saved-command UI and
  launches through host terminal services; it owns no native capability.

Modules import host services only through `@shep/module-api` or
`shep-module-api`. Host composition imports module public entrypoints only.
