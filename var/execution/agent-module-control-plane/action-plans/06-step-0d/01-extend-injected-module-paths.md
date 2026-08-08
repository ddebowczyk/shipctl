# 0D.1 Extend injected paths for module control

## Outcome

The immutable `InstanceContext` and `ShipctlPaths` expose canonical per-instance
module artifact, registry, and module-control evidence paths without touching
the production profile from isolated tests.

## Dependencies

- Step 0C named-instance path and isolation foundation.

## Production change

Derive the immutable module artifact root, registry database path, and
module-control evidence paths from the validated instance context. Keep path
ownership injectable and ready for future module-specific migrations. Keep
these paths independent of Cargo feature selection and Tauri registration so
future per-instance runtime state can use them without compile-time gating;
this package does not implement or verify that lifecycle.

## Diagnostic/observability

Expose a redacted path inventory containing instance identity, resolved roots,
path owners, and derivation sources. Record resolved isolated paths in every
module-control verification result and fail on production-root access.

## Mechanism integration test

Run two real backend compositions with distinct state and runtime roots; write
and read the module paths and evidence through the production path service;
assert each instance sees only its own files and the default profile remains
untouched.

## Acceptance evidence

- Module artifact, registry, and evidence paths are canonical and instance-owned.
- Isolation guards detect any production-root access.
- Path derivation is independent of Cargo features and Tauri registration.
- Existing instance path and check gates remain green.

## Non-goals

- Module registry behavior or lifecycle commands.
- Dynamic loading or frontend runtime changes.
- New native Rust module registration.
- Recompiling Rust as a module enable/disable mechanism.
