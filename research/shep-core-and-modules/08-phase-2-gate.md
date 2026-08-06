# Phase 2 gate: internal module fixture

Date: 2026-08-06

## Outcome

Phase 2 proves that one capability can span TypeScript UI code and an internal
Rust Tauri plugin while remaining optional and removable. The disposable
`shep.fixture` module is test infrastructure: it is not registered in the
default product profile or exposed in normal navigation.

The product and module language remains TypeScript (`.ts` and `.tsx`). The
Node-native `.mjs` file added for this gate is a build-verification runner, not
runtime application or module code.

## Fixture contract

- Frontend module: `modules/fixture/frontend/` contributes `fixture.panel` and
  invokes the exact command `plugin:shep-fixture|ping`.
- Native module: `modules/fixture/backend/` provides a side-effect-free
  `fixture:pong` response through the internal `shep-fixture` Tauri plugin.
- Native authority: the fixture profile grants only
  `shep-fixture:allow-ping` in addition to the default capability.
- Enablement: the app registers the native plugin only when Cargo feature
  `fixture-module` is selected.
- Persistence recovery: a saved `fixture.panel` reference hydrates to the
  generic unavailable-panel state when the fixture module is disabled, with
  retry and remove actions available.

## Reusable verification

Run the complete gate from the repository root:

```sh
pnpm verify:module-fixture-plugout
```

The command verifies three profiles:

1. Source present, fixture disabled: module composition, default frontend and
   Tauri builds, and default Rust tests pass.
2. Source present, fixture enabled: the fixture-feature Tauri build and Rust
   tests pass with the explicit fixture capability.
3. Source absent: a clean `HEAD` archive is copied to a uniquely named OS
   temporary directory, all fixture composition entries and source directories
   are removed, and the default frontend build, Rust tests, and Tauri build
   pass.

The source-absent profile additionally proves that no fixture implementation
reference remains in core source or manifests and that neither the pnpm nor
Cargo workspace graph contains the fixture package. The verifier removes only
the exact temporary directory it created; it never mutates the working tree.

For focused development of the deletion path, run:

```sh
node scripts/verify-module-fixture-plugout.mjs --source-absent-only
```

## Quarantine and rollback

The fixture remains quarantined under `modules/fixture/`, `profiles/fixture/`,
and `scripts/smoke/module-fixture/` so later architecture work can rerun the
same proof. It has no default product registration. Removing those directories
and their declarative package, Cargo feature, dependency, and plugin entries is
the demonstrated rollback path.

This gate establishes the removal mechanism required before extracting a real
capability. It does not authorize runtime-loaded native plugins or a module
marketplace.
