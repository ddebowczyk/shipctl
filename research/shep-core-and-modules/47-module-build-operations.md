# Module build and verification operations

Date: 2026-08-07

This is the operational guide for changing Shep's compile-time module set. Run
commands from the repository root. Use GNU `gtimeout` around every test or
build command so a stuck Vite, Cargo, Tauri, or provider process cannot block
the queue indefinitely.

## Build axes

Each native-capable module has three required shapes:

| Shape | Frontend | Cargo feature | Module source |
| --- | --- | --- | --- |
| Enabled | composed | enabled | present |
| Disabled | omitted | omitted | present |
| Source absent | omitted | removed | physically removed in a disposable copy |

Source-absent verification is stronger than a feature flag. It also checks the
pnpm and Cargo package graphs, permissions, composition references, production
bundle, persisted-panel recovery, and native build.

## Fast checks

```bash
gtimeout 5m pnpm check:module-profiles
gtimeout 5m pnpm test:module-boundaries
gtimeout 10m pnpm test:module-composition
gtimeout 10m pnpm test:panels
gtimeout 10m pnpm test:terminal-sessions
gtimeout 20m pnpm build
gtimeout 30m cargo test --manifest-path src-tauri/Cargo.toml
```

`check:module-profiles` treats one catalogue as an invariant across:

- Cargo default features;
- root Tauri capability blocks and generated command permissions;
- every `<module>-disabled` Tauri profile;
- native-disabled package scripts; and
- plug-out verifier peer-feature lists.

## Complete migration gate

```bash
gtimeout 6h pnpm verify:modular-monolith
```

The master runner executes the generic smoke/recovery suite and the full
enabled, disabled, and source-absent verifier for:

- the inert module fixture;
- Todos;
- Ports;
- Skills;
- Git;
- Commands;
- Assistants; and
- Usage.

The outer timeout protects the complete matrix. The runner adds a 60-minute
timeout around each plug-out verifier, and the shared harness adds a 15-minute
timeout around every child command.

## Verify one module

Use the focused verifier while developing:

```bash
gtimeout 60m pnpm verify:usage-plugout
```

To rerun only physical removal after the enabled and disabled shapes have
already passed at the same commit:

```bash
gtimeout 45m pnpm verify:usage-plugout --source-absent-only
```

Replace `usage` with `todos`, `ports`, `skills`, `git`, or `assistants`.
Commands uses `verify:commands-plugout`; the fixture uses
`verify:module-fixture-plugout`.

## Add a native-capable module

1. Add its feature name to `NATIVE_MODULE_FEATURES` in the shared plug-out
   harness.
2. Add the optional crate dependency and default feature to
   `src-tauri/Cargo.toml`.
3. Install its plugin only in `src-tauri/src/enabled_modules.rs`.
4. Add one namespaced capability block to `src-tauri/tauri.conf.json` using the
   plugin-generated permission identifiers.
5. Add `<module>-disabled/tauri.conf.json`, containing `default` plus every
   non-target module capability.
6. Add an isolated native-disabled package script and a three-shape plug-out
   verifier.
7. Run `gtimeout 5m pnpm check:module-profiles` before longer builds.

Do not add module imports to AppShell, feature commands to the root handler, or
sibling-module dependencies. Cross-module information flow requires a real
consumer and a separate architecture decision.

## Generated permissions

Changing a Tauri plugin's `build.rs` command list regenerates its permission
TOML, reference Markdown, and schema during Cargo build/test. Stage the command
resources and generated indexes together, then run the profile check. A command
is not operationally complete until the default and non-target profiles grant
its namespaced permission.

## Manual operator smoke

After the automated master gate passes, execute the checklist in
`00-migration-baseline-20260806-194429.md` against an isolated, authorized app.
It deliberately covers actions automation must not perform against a user's
live sessions without authorization: project mutation, PTY termination,
provider launch, Keychain writes, restart continuity, and workspace recovery.

Record the app build/commit, isolated config location, checklist result, and
any skipped action. Do not convert an environmental permission gap into a pass.

## Failure handling

- A timed-out child reports the command and timeout; rerun only after checking
  for orphaned Tauri, Vite, provider, or Cargo processes.
- Disposable copies are removed in `finally` blocks. If interrupted outside
  the harness, inspect only the explicit `/tmp/shep-<module>-*` target before
  removal.
- Keep each native profile's `CARGO_TARGET_DIR` isolated. Reusing Cargo output
  across different feature sets can produce misleading generated-permission
  state.
- Run `git diff --check` and inspect `git status --short` before committing so
  unrelated worktree changes are not staged.
