# Seed the truthful static-builtin inventory

## Outcome

The registry records the capability modules compiled into the current Shipctl
build as immutable `static_builtin` inspection metadata with real build
provenance and restart-bound lifecycle, without presenting them as live
artifacts or turning their existing static composition into runtime behavior.

## Dependencies

- Transactional module registry core.
- The current feature-gated native composition in `src-tauri/src/modules/` and
  static frontend profile in `core/frontend/host/enabledModules.ts`.

## Production change

Define a narrow build-composition inventory input for the generic registry.
The registry receives only data; the `shipctl-ui` composition boundary projects
the actually compiled native feature set and the shipped frontend static module
profile into that input when it opens the registry. Keep feature checks and
build identity at that composition edge, not in the registry core and not in
the CLI crate.

Seed idempotently by module identity and current Shipctl build provenance.
Each current module is recorded as `source: bundled`,
`runtimeKind: static_builtin`, and restart-bound; static records use the
Shipctl build identity as their provenance until a separately installed
artifact has a content digest. Preserve user desired selections, operation
history, and prior immutable records when a build inventory is refreshed.
Do not move module contributions, configuration, diagnostics, or activation
logic into Rust: TypeScript artifacts remain their owners through stable core
APIs. The seed is an inspection projection only; desired enable/disable data
does not add or remove Cargo features and cannot change the compiled profile.

## Diagnostic/observability

Make offline records identify their static-builtin classification, bundled
source, build provenance, and restart-bound/unavailable runtime status. Emit a
stable diagnostic when the recorded inventory is absent, stale for the current
build, or cannot be reconciled with the composition input; never claim that a
static record is a live-loadable artifact.

## Mechanism-level integration test

Use data-level representative enabled and disabled inventory fixtures through
the `shipctl-ui` composition adapter, then inspect the one already-compiled,
current host inventory through that adapter into isolated registries. Do not
invoke per-profile Cargo/Tauri builds or recompile Rust. Compare fixture
membership and current native feature/frontend static-profile membership with
the seeded records, restart/reopen the same build, and prove that seeding is
idempotent and does not modify desired state or operation history. Preserve the
transitional truth that current static membership is restart-bound while target
runtime enable/disable is data-only and does not alter compiled membership or
perform a build.

## Acceptance evidence

- Every currently bundled static module is recorded with actual build
  provenance and `static_builtin` runtime kind.
- Seeded static records are restart-bound and are not advertised as executable
  or live-loadable artifacts.
- Reopening or reseeding the same build is idempotent and retains user data.
- The generic registry has no imports of Tauri composition or TypeScript module
  behavior.
- No module enable/disable path changes Cargo features or rebuilds Rust.

## Non-goals

- Installing user or development artifacts.
- Loading ESM, worker, WASM, or new native Rust/Tauri code.
- Changing the existing frontend/native static composition.
- Offline CLI parsing or output formatting.
