# Assistants host compatibility removal

Date: 2026-08-07

## Outcome

The Assistant module no longer depends on provider-specific compatibility
surfaces in the Shep host. The host now sees Assistant sessions as generic
terminal sessions and the launcher as an ordinary panel contribution.

This slice removes the old flat frontend command wrappers, host-owned session
DTOs, Assistant tab discriminator and fields, hard-coded launcher callbacks,
and retired builtin panel adapters. Provider-specific launch, capture, restore,
branding, and status behavior remains inside `modules/assistants`.

## Generic host contracts

The host terminal tab has one `terminal` kind. A module may attach an opaque
session ID and a generic presentation containing a label, icon, status, and
whether the session should appear in the session list. Rename, move, stop,
focus, and close operations go through the module-session lifecycle port while
PTY identity and xterm state remain host-owned.

New-session UI and keyboard/menu events resolve `newSession` metadata declared
by panel contributions. `AppShell`, `TabBar`, and the sidebar no longer import
or branch on an Assistant launcher implementation.

## Panel persistence migration

The temporary builtin panel registry and hard-coded `commands` and `launcher`
tab variants are gone. Modules declare any pre-registry tab aliases through
`migrationAlias`; the persistence layer records `migrationKind` and reports a
`migrated` source. Current persisted panel references remain unchanged.

This is migration behavior, not a permanent legacy subsystem, so transitional
`legacy` and `builtin` naming has also been removed from the panel API and host
implementation.

## Workspace data

The host workspace schema no longer declares typed Assistant configuration.
Existing human-editable `assistants:` values are retained by the flattened
module-owned capability data map and round-trip through YAML unchanged. A Rust
test protects that preservation.

## Usage ownership boundary

Provider logos still used by quota visualization remain in the host until the
Usage capability is extracted. Their helper is named `usageProviderLogos` and
is imported only by Usage and settings surfaces; it is not an Assistant session
dependency. Moving those resources belongs to the Usage module stage.

## Verification

The enabled composition is covered by:

```sh
pnpm build
pnpm test:module-composition
pnpm test:panels
pnpm test:assistant-providers-characterization
pnpm test:commands-characterization
pnpm test:git-characterization
pnpm test:terminal-sessions
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1
```

The disabled compositions are covered independently by:

```sh
pnpm verify:assistants-frontend-disabled
pnpm verify:assistants-native-disabled
```

The next slice adds a combined physical source-absent plug-out check. It will
copy the staged tree, remove `modules/assistants`, disable both composition
features, and prove that the host still builds with generic unavailable-panel
recovery.

## Rollback

This slice changes no Assistant manifest schema or native persistence path.
Reverting it restores compatibility DTOs and host branches while the extracted
module remains the source of provider behavior.
