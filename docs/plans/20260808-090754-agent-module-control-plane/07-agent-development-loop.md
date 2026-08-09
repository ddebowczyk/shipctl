# Phase 7 — agent module build, pack, and development loop

## Outcome

Give agents one reliable source-to-runtime workflow for TypeScript modules:
build and validate an immutable artifact, publish it, apply it to a named
instance, and verify the exact digest now running.

## Work package 7.1 — deterministic build and pack

Source modules are ordinary npm/pnpm packages. Add public commands for the
Shipctl artifact boundary:

```text
shipctl modules build <source-path>
shipctl modules pack <build-output>
shipctl modules dev <source-path> --watch --instance <name>
```

The builder uses the module's Vite or Rollup configuration, externalizes
host-owned peers, validates manifests and capability contracts including
`defines`, `implements`, `requires`, and declared agent surfaces, and produces
the archive layout from Phase 3. Repeating a build from identical declared
inputs produces the same runtime content digest.

The runtime host never builds TypeScript, reads a half-written source tree,
runs package-manager installation, or executes lifecycle scripts.

## Work package 7.2 — validate, publish, and apply

For each coherent source change the development command:

1. builds into an isolated output directory;
2. validates the package, capability definitions, schemas, assets, and grants;
3. calculates and publishes an immutable development artifact;
4. submits a replacement operation only after validation succeeds;
5. observes the operation through the public instance protocol; and
6. reports the source revision, artifact digest, provider identity, and
   verification result.

A failed build or preflight produces diagnostics but no desired-state revision.
A configuration-only edit invokes reconfigure; it does not synthesize a code
build.

## Work package 7.3 — agent verification

`shipctl modules verify` can assert module identity, selected digest, desired
and applied revisions, provider health, capability bindings, contributions,
grants, resources, and expected or forbidden diagnostic codes.

`shipctl diagnose` joins named-instance, registry, supervisor, capability,
provider, bus-route, scheduler, stream, and resource consistency. It is
read-only and uses public observations rather than private frontend stores.

Evidence bundles are opt-in and contain normalized requests, structured
responses, artifact metadata, redacted diagnostics, and operation correlation.
They exclude secrets, bus payload history, and ordinary terminal content.

## Diagnostic and verification mechanism

Drive the watcher as a subprocess against the fixture package and a running
named instance. Change its exported behavior from A to B and wait on operation
completion rather than sleeping. Prove the exact digest and callable behavior.
Then introduce a compiler or preflight failure, prove B remains active, and
apply a valid subsequent change.

## Exit proof

- Build and pack produce a validated artifact containing code, assets, and
  module-defined capability contracts.
- Editing A to B publishes and activates B only after validation.
- A failed build, preflight, or activation leaves the last good provider live.
- A later valid edit recovers without restarting the watcher or Shipctl.
- Configuration-only changes do not rebuild source.
- The host binary and webview remain unchanged throughout the development loop.
- npm may distribute source or archives, but runtime installation requires only
  the immutable Shipctl artifact.

## Primary implementation areas

- `ops/build/` for deterministic module building and packing;
- `cli/` for build, pack, dev, and verify commands;
- `core/backend/src/module_control/` for publication and operation correlation;
- `examples/module-fixture/` for source-edit scenarios; and
- `ops/module-control/` for subprocess integration proofs.
