# Add authenticated local instance control

## Outcome

Each running UI instance owns a unique name and state root, publishes a
ready-only descriptor, and can be listed, inspected, and stopped through an
authenticated machine-local protocol without opening a network port.

## Depends on

- Injected instance context and paths.

## Production change

Add name and state-root leases, private runtime descriptors, authenticated
versioned local IPC, readiness publication, live handshake validation,
conservative stale cleanup, and graceful or forced shutdown coordinated with
the application's PTY lifecycle.

## Diagnostic or observability change

Inspection reports identity, liveness proof, protocol/build compatibility,
roots, readiness, and active-work blockers while redacting authentication
secrets. Failure categories distinguish absent, stale, unauthorized,
incompatible, starting, and stopping instances.

## Mechanism-level integration test

Start real control runtimes in separate processes, contend concurrently for
the same name and state root, validate discovery through authenticated
handshakes, exercise stale descriptors, and prove graceful-stop refusal and
forced-stop cleanup with a live-work probe.

## Acceptance evidence

- Same-name and same-root races admit exactly one owner.
- Descriptors are published only after readiness and use UUID identity.
- Listing requires a successful authenticated handshake, not PID existence.
- No TCP listener or REST endpoint is introduced.
- Graceful stop preserves active work; force follows application-owned cleanup.
- Descriptor and lease cleanup is deterministic after normal and stale exits.

## Non-goals

- Module management RPCs.
- Remote-machine control.
- Browser automation.
- Pushing commits to a remote.
