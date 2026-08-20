# Frontend application runtime

This capability owns trusted TypeScript application lifecycle and semantic
service binding. It has no React or Tauri dependency. The platform capability
implements native adapters. Modules receive only the activation-scoped public
contracts from `@shipctl/module-api`.

`createApplicationRuntime()` owns the existing workspace bridge, accepted
catalog controller, and live-supervisor lifetime behind a small snapshot
client. Desktop composition injects persistence, native catalog, artifact, and
message ports. If durable workspace storage is unavailable, the client records
that fact and rejects writes; it never substitutes in-memory persistence.

Module composition retains each exact activation context and supplies it to
the module's rendered contributions. A view therefore resolves the same
service binding as the module activation that published it; it does not read a
process-wide service locator.

Cordis integration lives in `runtime/cordis/`. The exact upstream source
revision is pinned in `core/frontend/package.json`. The architecture build
script compiles that source into the private `vendor/cordis.js` boundary, so
Shipctl does not type-check Cordis with its own compiler policy. The adjacent
declaration exposes only the public Cordis operations used by the adapter.
The rest of the host must use Shipctl runtime types instead of Cordis state.
