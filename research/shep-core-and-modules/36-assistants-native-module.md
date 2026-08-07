# Assistants native module

Date: 2026-08-07

## Outcome

Assistant-provider native behavior now lives in
`modules/assistants/backend` as the internal `shep-assistants` Tauri plugin.
The module owns:

- durable Claude and Codex session records and manifest persistence;
- transcript identity capture and the bounded no-guess policy;
- provider-specific new-session and resume argument construction;
- capture, placement, label, discard, re-arm, restore, warning, and shutdown
  command handlers;
- plugin state registration and explicit generated permissions.

Frontend calls use the `plugin:shep-assistants|...` namespace. The flat host
command registrations and host-owned `AssistantSessionRegistry` state are
gone.

## Host port

The plugin receives one narrow `TerminalAuthority` port. It submits an
already-authorized command, arguments, cwd, environment, dimensions, and color
theme, and can stop a terminal by its runtime identifier. The host adapter in
`src-tauri/src/assistants_module.rs` delegates those requests to the generic
PTY manager.

Provider selection, argument policy, provider session identifiers, manifests,
and restore semantics do not cross this port. PTY process ownership, output
transport, resize, input, focus, and termination remain host infrastructure.

Shared native terminal launch/output DTOs live in `shep-module-api`; they do
not name an Assistant provider.

## Shutdown ordering

The frontend module contributes `beforeShutdown`. It asks the native plugin to
capture any final Codex identities, retain only ready records with provider
session IDs, arm them for the next launch, persist the manifest, and freeze
further record removal. Only after all module shutdown callbacks succeed does
the host run its generic PTY shutdown command.

The source characterization test protects this ordering and proves that the
host shutdown command no longer references Assistant registry internals.

## Enablement and permissions

The host enables the plugin through the optional `assistants-module` Cargo
feature. The default feature set includes it. `src-tauri/tauri.conf.json`
grants only the plugin's thirteen namespaced commands to the main window.

The reproducible native-disabled profile is:

```sh
pnpm verify:assistants-native-disabled
```

It omits `assistants-module`, removes Assistant permissions from the merged
Tauri capability configuration, retains the TODO, Ports, Skills, and Git
native modules, and completes a debug application build.

The frontend-disabled profile remains independent:

```sh
pnpm verify:assistants-frontend-disabled
```

The final plug-out task combines both profiles and proves a physically
source-absent build.

## Verification

The extraction passed:

```sh
pnpm test:assistant-providers-characterization
pnpm test:module-composition
pnpm test:terminal-sessions
pnpm verify:assistants-native-disabled
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1
```

The staged extraction has 43 native tests: 19 plugin tests plus 24 host tests.
The live mixed worktree additionally contains two unstaged model-catalog tests;
those remain with their user-owned implementation instead of being folded into
this commit. The disabled Tauri application build also runs module-boundary
checks, TypeScript, and a production Vite build before compiling the host
without the Assistant plugin.

## Remaining compatibility cleanup

The frontend has completed its command cutover, but the next slice removes
dead flat Assistant wrappers and DTOs from `src/lib/tauri.ts` and host types,
then removes bounded builtin/legacy panel adapters after all consumers are
confirmed migrated. That cleanup is deliberately separate from this native
movement so each commit remains independently buildable and reversible.

## Rollback

The persistence path and manifest schema are unchanged. Reverting this slice
restores the host-owned registry and flat command registrations without
changing existing saved Assistant records.
