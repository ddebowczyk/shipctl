# Generic terminal session rail

## Outcome

The host now exposes a capability-neutral `terminalSessions` service through
`ModuleHostServices`. It is the second Commands migration rail, after generic
project capability data. Commands has not been cut over yet; that is the next
independent stage.

The contract contains no Commands DTO, command status, Zustand store, PTY ID,
xterm instance, or tab ID. A module supplies an opaque owner key and receives
an opaque runtime session ID.

## Public contract

A launch request preserves:

- project placement and opaque owner key;
- executable, argument vector, environment, and working directory;
- user-visible label; and
- terminal columns and rows.

The service supports `launch`, `stop`, `focus`, and lifecycle subscriptions.
Lifecycle events are discriminated as:

- `started`;
- `exited` with `manual-stop`;
- `exited` with `zero-exit`; or
- `exited` with `nonzero-exit`.

The exit code is nullable because an explicit stop is deterministic at the
host-service boundary even when native channel delivery of the final process
status arrives later.

## Host ownership

`usePty` remains the runtime owner of PTY creation, process termination, xterm
output, activity state, terminal tabs, and cleanup. It keeps the private mapping
between the public session ID and native PTY/tab identities.

An exited session remains focusable until its terminal tab is removed. Stopping
an already-exited session removes that tab without publishing a second exit
event. Closing a tab or removing a project uses the same idempotent completion
path.

The stable service object delegates to the mounted React runtime. Binding is
token-safe: cleanup from an older Strict Mode render cannot unbind a newer
runtime.

## Compatibility boundary

The existing `startCommand`, `stopCommand`, and Commands store integration are
unchanged in this stage. Their characterized tab, status, and exit behavior
continues to pass. The Commands module cutover can now replace those direct
closures with only:

1. `projectData` for catalogue persistence; and
2. `terminalSessions` for runtime behavior.

Once that cutover passes its own characterization and plug-out gate, the
Commands-specific branches can be removed from `usePty` and `AppShell`.

## Verification

- `pnpm test:terminal-sessions`
- `pnpm test:commands-characterization`
- `pnpm test:module-composition`
- `pnpm test:project-surfaces`
- `pnpm test:git-characterization`
- `pnpm test:skills-characterization`
- `pnpm check:module-boundaries`
- `pnpm build:module-fixture`
- `pnpm build`
- `cargo test --manifest-path src-tauri/Cargo.toml`

The focused terminal tests cover complete request forwarding, lifecycle
subscription/unsubscription, all exit classifications, unavailable-runtime
behavior, and stale React cleanup.
