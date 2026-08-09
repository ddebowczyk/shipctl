# Static module fixture

This self-contained example proves Shipctl's compile-time module boundaries.
Its frontend, native plugin, manifest, message schema, permissions, and tests
live together here. The fixture is excluded from the default application build
and is enabled only by the `fixture-module` Cargo feature and fixture profile.

Run its focused checks from the repository root:

```sh
pnpm exec node --test examples/module-fixture/tests/fixtureContract.test.mjs
just build module-fixture
cargo check -p shipctl-ui --features fixture-module
```

The build host under `ops/modularity/fixtures/module-fixture/` is operations
infrastructure; this directory owns the example itself.
