# Modules

`modules/` contains removable TypeScript features. A migrated module owns a
public frontend package under `frontend/`, has no Rust crate, and imports no
Tauri API. When it needs native authority, it uses a public semantic service;
the permanent provider belongs to `core/backend/` and its private framework
adapter belongs to `core/tauri/`.

Some modules still have feature-gated Rust under `backend/` and a typed host
adapter under `host/`. These directories are migration sources, not the target
pattern. Ports, Todos, Git, Skills, and Semantic Terminal already use the
frontend-only shape. Commands, Ports, Todos, Git, Skills, and Thin Terminal also
declare `frontend.delivery: runtime-artifact`; the build embeds their immutable
output, and the host activates it through the same loader used for installed
plugins.

Two repository locations are intentionally different from removable features:

- Top-level `module-api/` is the narrow shared contract for TypeScript and
  Rust. It is a leaf dependency, not a feature module or plug-out candidate.
  Its `host/`, `module/`, and `protocol/` source directories mean,
  respectively, host-provided ports, module-provided contributions, and shared
  immutable/wire values. Consumers use the root `@shipctl/module-api` or
  `shipctl-module-api` export, never an implementation subpath.
- `commands/` is frontend-only because it contributes saved-command UI and
  launches through host terminal services; it owns no native capability.

Frontend modules import host services only through `@shipctl/module-api`.
Transitional native modules can import the Rust compatibility API and expose a
host entrypoint. The Tauri shell retains direct optional dependencies only for
those remaining plugin ACL manifests; it does not implement module behavior or
adapters.
