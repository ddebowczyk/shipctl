# TODO extraction plug-out gate

## Outcome

TODO is a removable production module rather than a host feature stored in a
new directory. Its React implementation, state, styles, characterization
tests, native implementation, native tests, permission resources, and client
live under `modules/todos/`.

The host contains only two declarative enablement points:

- `src/core/modules/enabledModules.ts` imports the public frontend package;
- `src-tauri/src/enabled_modules.rs` installs the optional internal plugin.

## Generic tab cutover

Contributed panels now open as generic tabs containing a stable namespaced
`panelId`. The host tab union no longer contains a `todos` kind, and module
navigation no longer translates a contribution back into host vocabulary.

The TODO panel declares its old `todos` tab kind as module-owned migration
metadata. Generic persistence code uses that metadata when the module is
present and retains unavailable current references when it is disabled or
absent. No TODO-specific persistence branch remains in the host.

## Generic settings preservation

Project settings retain the two core project behaviors as typed fields. All
additional capability values are flattened into an extension map and round
trip through the human-editable YAML unchanged. Existing TODO settings
therefore survive the migration, while Rust and TypeScript host schemas no
longer declare or default TODO-owned keys.

## Reusable removal proof

`scripts/lib/module-plugout.mjs` provides the disposable-worktree, command,
dependency-graph, and cleanup harness for future module extractions.
`scripts/verify-todos-plugout.mjs` supplies the TODO-specific composition
markers and verification matrix.

Run the complete matrix with:

```sh
pnpm verify:todos-plugout
```

The verifier proves three distinct states:

1. Enabled: characterization, composition, panel, frontend, Rust, and full
   Tauri builds pass.
2. Disabled: a disposable copy omits frontend composition and compiles the
   native host without the TODO feature or permission grant.
3. Source absent: another disposable copy removes both module trees and all
   dependency, feature, capability, and composition wiring; dependency graph
   assertions plus frontend, Rust, and full Tauri builds still pass.

The separate `shep-todos` installable agent skill remains host-owned. It is
documentation for agents and does not import, invoke, or depend on the TODO UI
or native module.
