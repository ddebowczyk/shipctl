# Modules

`modules/` contains features that can be removed from a build. A normal module
owns a public frontend package under `frontend/` and, when native behavior is
needed, a feature-gated Tauri plugin under `backend/`. When native model or
driver logic must also serve the CLI, it belongs in a Tauri-free `core/` crate;
the backend plugin depends on that crate, never the reverse. If the plugin
needs a host-owned service, its typed adapter belongs in `host/`; it exports
the module installation function and is the only code that sees both module and
host.

Two directories are intentionally different:

- `api/` is the narrow host-to-module contract for both TypeScript and Rust. It
  is a leaf dependency, not a feature module.
- `commands/` is frontend-only because it contributes saved-command UI and
  launches through host terminal services; it owns no native capability.

Modules import host services only through `@shipctl/module-api` or
`shipctl-module-api`. Host composition imports module `host` entrypoints only.
The Tauri shell retains the direct optional backend dependency required for ACL
manifest discovery, but it does not implement module behavior or adapters.
