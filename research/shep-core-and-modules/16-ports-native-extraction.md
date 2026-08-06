# Ports native extraction

Date: 2026-08-06

Beads task: `shep-3w1.8.1.2.2`

## Outcome

The Ports capability's native policy now lives in the optional internal Tauri
plugin at `modules/ports/backend`. The host command monolith no longer owns
listener parsing, process filtering, project matching, framework detection, or
termination policy.

The plugin exposes the namespaced commands:

- `plugin:shep-ports|list_listening_ports`
- `plugin:shep-ports|kill_port`

The frontend still calls the historical flat names in this transition stage.
Those host commands are bounded adapters that delegate to the same plugin core;
the frontend cutover task will remove them.

## Authority boundary

The plugin has no dependency on the Shep host crate and receives two narrow
interfaces:

- `ProjectCatalog`: lists registered project paths.
- `ProcessAuthority`: observes listening TCP sockets, summaries, and working
  directories for selected PIDs, and terminates one selected PID.

The shell commands remain host-owned and fixed. The plugin receives no generic
command executor, filesystem root, or workspace manager. This keeps process
authority auditable while allowing the capability to own its interpretation
and policy.

## Composition and removal

`ports-module` is a default Cargo feature backed by an optional dependency.
`enabled_modules.rs` installs the plugin declaratively when the feature is
enabled. Tauri grants only the two generated command permissions.

`profiles/ports-disabled/tauri.conf.json` removes those permissions while
retaining the TODO module. The disabled build uses:

```sh
pnpm verify:ports-native-disabled
```

This compiles the application with `--no-default-features --features
todos-module`, proving that the host remains healthy without the Ports crate.

## Verification

- `pnpm test:ports-characterization`: 6 frontend contract tests and 7 plugin
  tests passed.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`: 48 tests passed.
- `pnpm tauri build --debug --no-bundle`: enabled application build passed.
- `pnpm verify:ports-native-disabled`: disabled application build passed.
- `git diff --check`: passed.

## Next boundary

The next task should move the Ports frontend client and UI into
`modules/ports/frontend`, switch the client to the namespaced commands, and
delete the two flat host adapters plus their feature-disabled DTO fallback.
