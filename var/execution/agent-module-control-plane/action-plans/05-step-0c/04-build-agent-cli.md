# Build the named-instance agent CLI

## Outcome

Agents can start, list, inspect, and stop named UI instances using stable,
non-interactive commands and deterministic structured output.

## Depends on

- Split CLI and UI executables.
- Authenticated local instance control.

## Production change

Implement `shipctl ui start`, `shipctl instances list`, `shipctl instances
inspect`, and `shipctl instances stop`, including explicit state/runtime roots,
idempotent start behavior, deterministic paired-UI discovery, readiness
waiting, graceful/forced stop semantics, and defined exit classes.

## Diagnostic or observability change

Make TOON the compact default output and canonical JSON an explicit option.
Every response carries operation, status, instance identity where available,
and a stable diagnostic/error code suitable for assertions.

## Mechanism-level integration test

Drive independently built CLI and UI processes through the public command
surface: start two names with isolated roots, list and inspect them, verify
idempotence and conflicts, stop them, and assert stdout, stderr, and exit
status contracts.

## Acceptance evidence

- Bare `shipctl`, `shipctl ui`, and `shipctl ui start` retain documented roles.
- Two named instances can run concurrently and are individually addressable.
- Repeated start is idempotent only for the same canonical identity and root.
- TOON and canonical JSON represent the same response data.
- Usage, operational failure, and success/no-op exit classes are stable.
- Public-command integration and CLI contract tests pass.

## Non-goals

- Adding a general-purpose daemon.
- TCP/REST transport.
- Module lifecycle commands.
- Pushing commits to a remote.
