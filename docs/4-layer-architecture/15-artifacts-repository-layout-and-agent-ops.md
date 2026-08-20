# Artifacts, repository layout, and agent operations

## Purpose

The migration needs durable, machine-readable facts. Markdown explains intent,
but it cannot be the only source for dependency order, capability grants,
module disposition, property coverage, or runtime state.

This document defines the durable artifacts used by implementation. The
approved architecture program makes the existing `spec/` paths binding.

## Repository shape

```text
core/
  backend/src/<capability>/       Tauri-free native providers
  tauri/src/<capability>.rs       private Tauri adapters
  frontend/
    platform/<capability>/        only browser-side Tauri clients
    runtime/                      Cordis app root, services, loader, ownership
    workspace/                    semantic document and commands
    canvas/                       renderer-neutral boundary and adapters

module-api/
  frontend/src/
    contract/                     plugin, manifest, contribution contracts
    services/                     semantic public service ports
    runtime/                      activation identity and effect-facing types
    testing/                      fake host and conformance kit

modules/<id>/
  module.yaml                     source descriptor and build inputs
  src/                            TypeScript application plugin source
  src/ui/                         optional React presentation
  tests/                          plugin behavior and conformance

docs/4-layer-architecture/
  spec/
    program.yaml                  indexed program and four-layer invariants
    schema/                       closed schemas for architecture records
    phases/                       semantics, properties, and deletion gates
    capabilities/                 one record per platform service
    migrations/                   module disposition and deletion records

ops/architecture/
  justfile                        repository operation entry points
  bin/                            graph, schema, package, and evidence checks
  tests/                          mutation fixtures for architecture checks

target/architecture-evidence/    ignored run evidence and package reports
```

The current path is `module-api/`, singular. This plan does not rename it to
match the informal phrase “modules API.” A rename provides no boundary by
itself and would create broad import churn before the contract is stable.
The target path contains TypeScript contracts only. The current
`module-api/backend` Rust compatibility crate is a migration input and is
deleted after its contracts move to permanent core capability owners.

## Normative specification artifacts

### Architecture Capability Record

One YAML record defines each public service, whether it is implemented by a
permanent platform adapter or a replaceable plugin. It includes:

- stable service and version ID;
- semantic operations and result types;
- required grants and resource scopes;
- host and activation ownership rules;
- ordering, cancellation, retry, and error semantics;
- privacy and redaction rules;
- provider and adapter locations;
- dependency edges;
- property IDs and deletion gates.

This record is the authority for generated documentation, fake-host coverage,
manifest grant validation, and agent inspection labels.

### Module Disposition Record

One YAML record per current module defines:

- present frontend, Rust, Cargo, Tauri, ACL, message, and artifact edges;
- target plugin responsibilities;
- target platform services;
- migration prerequisites;
- compatibility paths;
- old files and symbols that the slice must delete;
- proof IDs that authorize each deletion.

The checker rejects `complete` while any named old edge remains.

### Plugin Artifact Manifest

The artifact manifest is versioned and closed. It contains identity, digest,
application entrypoint, compatible plugin API range, declared external
modules, required and provided services, requested capabilities, background
and readiness metadata, optional contributions, data-schema versions, and
optional migration entrypoints. It contains no host implementation code,
absolute path, Tauri command, or renderer object. React, CSS, assets, and view
contributions are optional.

Source `module.yaml` remains a build input. The immutable artifact manifest is
the admitted runtime record. The build proves the mapping between them instead
of assuming they are the same document.

### Architecture snapshot

The source and package checker emits one canonical snapshot with:

- workspace members and Cargo features;
- TypeScript package and resolved import edges;
- Tauri commands, plugins, permissions, and ACL projections;
- source module descriptors and built artifact identities;
- native providers, public services, and adapters;
- module disposition status and residual forbidden edges.

This is build evidence. It does not claim to describe a running instance.

### Runtime snapshot

The running host emits one revisioned snapshot with:

- desired and observed plugin state;
- accepted and rejected artifact identities;
- activation IDs and lifecycle states;
- required and provided service bindings and versions;
- owned background effects, controllers, workers, and connections;
- effective capability grants and scopes;
- contribution catalog revision and owners;
- workspace revision and semantic view identities;
- host resources, activation leases, and disposal state;
- last structured failure per transition.

Secrets, terminal contents, credentials, and unrestricted paths are excluded or
redacted by the public inspection contract.

### Property evidence record

Each recorded run links semantics, property, executable test, repository
revision, runner version, seed, shrink path, classifications, minimized
counterexample, replay command, and supported deletion gate. The schema marks
the difference between a fresh campaign and regression replay.

## Generated and handwritten boundaries

Handwritten sources define meaning:

- service semantics;
- grant intent;
- plugin disposition;
- property claims and independent oracle descriptions;
- migration and deletion decisions.

Generated outputs reduce duplication:

- TypeScript manifest and snapshot validators;
- Rust or TypeScript protocol fixtures where generation is practical;
- capability reference pages;
- static graph snapshots;
- proof indexes that map semantics to tests;
- package inventories.

Generated code must identify its source record and must fail a drift check when
stale. Do not generate provider behavior or independent property oracles from
the implementation under test.

## Agent operation surface

Repository operations belong under `ops/` and integrate with `just`. The
implemented Phase A operations are:

- `just architecture validate` validates schemas, indexes, references,
  dependency graphs, property coverage, test status, and deletion proofs;
- `just architecture test` runs negative examples and the generated
  specification, passive-import, module-composition, and replay properties;
- `just architecture inspect` emits the current runtime-artifact source
  snapshot as JSON;
- `just architecture baseline` compares current source facts with the reviewed
  `spec/baseline/source-architecture.json` file;
- `just architecture boundaries` enforces dependency boundaries and passive
  module public entrypoints;
- `just architecture graph` emits the phase, capability, and module graph as
  JSON;
- `just architecture all` runs the complete Phase A contract, snapshot drift
  check, and TypeScript and Rust replay proof.

Later focused operations add the following runtime and package evidence:

- validate the architecture specification graph;
- emit the current source architecture snapshot as JSON;
- compare the snapshot with a phase expectation;
- run one property by ID and replay one stored counterexample;
- build and inspect plugin artifacts;
- inspect a packaged app for forbidden or missing components;
- emit a compact proof report for one deletion gate.

The architecture operation is registered beside `just modularity`,
`just module-control`, `just message-bus`, `just test`, and `just check`. Its
checker emits JSON and uses a stable nonzero exit for rejection.

Runtime operations extend the current `shipctl modules` surface. It already
supports preflight, add, list, inspect, capability inspection, diagnosis,
offline verification, enable, and disable. The target adds enough structured
fields and watch behavior to answer:

- Which artifact and activation provide this contribution?
- Which activation provides this application service, and which consumers are
  bound to it?
- Which grants and resource scopes are effective?
- Which desired revision caused this transition?
- Which effects and resource leases are still live?
- Which background work is active, ready, draining, or failed?
- Why was a candidate rejected?
- Did the running catalog and workspace converge?

These facts must come from the control plane, not React DOM scraping.

## Runtime identity and correlation

Stable correlation keys cross every layer:

```text
artifact digest
    -> desired revision
    -> activation ID
    -> service request ID
    -> contribution owner
    -> workspace view instance
    -> native resource lease
```

Logs, notices, CLI snapshots, and property failures use these keys. A user
notice stays brief. Its diagnostic record keeps the structured cause and
correlation IDs. This prevents high-volume runtime logging from hiding the
small set of user-visible failures.

## Required mutation fixtures

The checker suite must include deliberate invalid fixtures for:

- a plugin importing Tauri, core, Layman, or another plugin;
- a Rust crate or Cargo feature left under a completed module;
- an unresolved or cyclic specification dependency;
- a manifest requesting an unknown capability or excess grant;
- an artifact whose required service is absent or whose declared provider does
  not register that service;
- a headless artifact rejected only because it has no React or presentation
  contribution;
- a built artifact whose digest, externals, or manifest mapping is wrong;
- a property marked implemented without an executable test;
- a contribution or resource without an activation owner;
- a package that contains a removed implementation;
- a runtime snapshot with a stale or decreasing revision.

The check is not trusted until each fixture fails for its intended reason.

## Artifact retention

- Normative schemas and records are versioned source files.
- Accepted minimized counterexamples are versioned beside tests.
- Large run logs, temporary packages, and fresh campaign output remain under
  ignored `target/architecture-evidence/`.
- A release stores the compact proof report and artifact digests with its build
  provenance.
- Notices and diagnostic logs use separate sinks when their retention and
  signal needs differ, but they share correlation IDs.
