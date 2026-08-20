# Modules

`modules/` contains removable TypeScript features. Every shipping module owns
a public frontend package under `frontend/`, imports no Tauri API, and declares
`frontend.delivery: runtime-artifact`. The build embeds its immutable artifact,
and the host activates it through the same admitted loader used for installed
plugins. When a module needs native authority, it uses a public semantic
service; the permanent provider belongs to `core/backend/` and its private
framework adapter belongs to `core/tauri/`.

Two repository locations are intentionally different from removable features:

- Top-level `module-api/` is the narrow shared contract for TypeScript and
  Rust. It is a leaf dependency, not a feature module or plug-out candidate.
  Its `host/`, `module/`, and `protocol/` source directories mean,
  respectively, host-provided ports, module-provided contributions, and shared
  immutable/wire values. Consumers use the root `@shipctl/module-api` or
  `shipctl-module-api` export, never an implementation subpath.
- `commands/` is frontend-only because it contributes saved-command UI and
  launches through host terminal services; it owns no native capability.

Frontend modules import host services only through `@shipctl/module-api`. The
Tauri shell owns no module implementation or adapter; it only provides the
platform services that admitted artifacts consume through semantic ports.
