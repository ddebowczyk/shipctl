# Native module API

`shipctl-module-api` is the leaf dependency reserved for narrow contracts that
must cross from the Shipctl host into an internal native module.

Its implementation tree separates `src/host/` host-provided authorities,
`src/module/` module-provided traits, and `src/protocol/` shared IDs, DTOs,
errors, and observations. `src/lib.rs` is the complete compatibility façade:
consumers import `shipctl_module_api::*`, never a directional submodule.

The crate exports only contracts with a production caller. Its first concrete
surface is the terminal transport DTOs used by the Assistant provider module
to launch through a host-owned PTY authority without importing host
implementation types. It remains deliberately smaller than a generic module
context, service locator, or shared error abstraction.

Dependency direction:

```text
src-tauri host -> native module crate -> shipctl-module-api
```

`shipctl-module-api` must remain a leaf. It may not depend on `src-tauri`, a
feature module, Tauri application state, PTY/process infrastructure, or project
storage implementations.
