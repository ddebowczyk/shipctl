# Usage native module

Date: 2026-08-07

## Outcome

Usage persistence, transcript ingestion, provider quota adapters, normalization,
queries, startup refresh, and native data commands now live in the internal
`tauri-plugin-shep-usage` crate under `modules/usage/backend`.

The frontend invokes seven explicitly permissioned commands through the
`plugin:shep-usage|...` namespace. The host no longer opens the Usage database,
starts ingestion, emits completion events, or registers flat Usage data and
refresh commands.

## Native ownership

The plugin owns:

- the SQLite schema, connection, migrations, transcript cursors, and pricing
  snapshot;
- Claude, Codex, Gemini, and Antigravity provider adapters;
- local transcript ingestion and normalization;
- snapshots, details, overview, alias-review, and observed-model queries;
- startup and requested background ingestion;
- the `usage-ingest-complete` event emitted after background ingestion;
- plugin state and the fallback to an in-memory database when the persistent
  database cannot be opened.

The module exposes narrow public DTOs and query aliases only for a temporary
compatibility layer. Internal database, provider, ingestion, and query files
are not host modules.

## Host authority seam

Remote quota refresh needs the four provider visibility flags stored in shared
global configuration. The plugin therefore accepts a read-only
`ProviderSettingsAuthority` when it is installed. The host adapter returns only
`ProviderVisibility`; it does not expose `WorkspaceManager`, the global config
schema, or mutation authority to the module.

Usage settings commands remain host-owned in this slice because their typed
field is still part of shared global configuration. Removing that ownership
before global writes were atomic could have allowed one capability to overwrite
another capability's concurrent settings update. The prerequisite subsequently
landed through the generic transaction documented in
`43-atomic-global-config-mutations.md`.

## Bounded compatibility seam

The Assistant model picker still uses a flat host command. It combines live CLI
catalogues with models observed by Usage, so the plugin temporarily also manages
a compatibility `UsageDb` state and the host retains a small re-export shim.
These are transitional, not target architecture:

- the frontend Usage data path already uses only namespaced plugin commands;
- flat Usage data and refresh wrappers are not registered with Tauri;
- compatibility removal is the next migration slice;
- a durable cross-capability solution belongs behind a typed host capability
  contract, not direct sibling-module imports or a generic event bus.

The broader typed inter-module information-flow design is tracked by
`shep-3w1.8.8`.

## Native-disabled profile

`pnpm verify:usage-native-disabled` builds the application with the Usage Cargo
feature and permissions omitted while retaining the other native modules. It
uses a dedicated Cargo target directory so generated Tauri metadata cannot be
contaminated by earlier source-removal fixtures that used disposable paths.

This proves the host compiles without the plugin. Physical source removal and
persisted-surface recovery remain part of the later Usage plug-out gate.

## Change isolation

The source Usage files and `commands.rs` contained pre-existing local work when
this extraction began. The migration commit records the original Usage blobs as
renames into the module and stages only the feature gates added to
`commands.rs`. The pre-existing semantic and formatting deltas remain unstaged
at their new module paths for their owner to continue.

## Verification

The following checks passed in the extraction worktree:

```sh
cargo check -p tauri-plugin-shep-usage
cargo check -p shep
pnpm test:usage-characterization
pnpm exec tsc --noEmit
pnpm test:module-boundaries
pnpm test:module-composition
pnpm build
pnpm verify:usage-native-disabled
```

The Usage characterization suite runs the plugin's Rust tests and verifies
plugin ownership, namespaced client calls, permissions, host installation, and
absence of flat Usage data-command registration.
