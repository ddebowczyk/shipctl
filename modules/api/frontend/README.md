# Frontend module API

`@shep/module-api` is the compile-time contract between the Shep host and
frontend capability modules. It contains data-oriented contribution types and
host ports, not application stores or feature implementations.

Allowed dependency direction:

```text
host composition ──> module public entrypoint ──> @shep/module-api
host internals ─────────────────────────────────> @shep/module-api
```

- The API package may import only platform-neutral types and React types.
- A module may depend on this package, but not on `src/`, another module's
  internals, `AppShell`, or host stores.
- Host composition may import a module's public entrypoint. Other host code may
  not import module implementation files.
- Modules receive narrow host ports; they are not given a generic store,
  command dispatcher, Tauri `invoke`, shell, or filesystem capability.

Executable boundary and enablement checks are introduced in the next migration
task. This package establishes the import boundary without moving any feature
implementation.
