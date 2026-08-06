# Native module API

`shep-module-api` is the leaf dependency reserved for narrow contracts that
must cross from the Shep host into an internal native module.

The crate intentionally exports no contracts yet. The first fixture plugin
needs Tauri's plugin interface but no host service, so inventing a generic
module context or error abstraction here would make the boundary broader than
the behavior exercises. Add a contract only with the first production caller;
registered-project authorization is the expected initial candidate.

Dependency direction:

```text
src-tauri host -> native module crate -> shep-module-api
```

`shep-module-api` must remain a leaf. It may not depend on `src-tauri`, a
feature module, Tauri application state, PTY/process infrastructure, or project
storage implementations.
