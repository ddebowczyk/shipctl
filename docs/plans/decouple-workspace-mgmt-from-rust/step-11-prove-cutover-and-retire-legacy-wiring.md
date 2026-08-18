<!-- markdownlint-disable MD013 -->

# Step 11 — Prove cutover and retire legacy wiring

## Outcome

Make the refactor safe to complete: add property-oriented tests and operational
diagnostics for the new runtime, roll out through compatibility bridges, and
delete the old React/native/static wiring only when the new path has concrete
evidence of correctness.

The existing 4-layer architecture specification and property-method documents
are the starting point. This step extends them to the workspace, contribution,
configuration, runtime-activation, and headless-operation boundaries described
in this plan.

## Required property families

| Property | Generator/domain | Oracle |
| --- | --- | --- |
| Workspace structural validity | documents, view instances, split/stack/floating layouts, operations | validator accepts only reachable, non-cyclic trees with valid focus and available/recoverable instances |
| Operation atomicity | valid/invalid open, close, move, split, resize, float, dock, maximize, reset requests | invalid/stale request leaves document and revision unchanged; valid request has one deterministic revision outcome |
| Renderer projection | valid semantic workspace documents and gesture intents | projection is deterministic; renderer gestures map only to supported semantic operations; no renderer state becomes canonical |
| Configuration safety | defaults, overrides, invalid values, migrations, concurrent revisions | resolve is deterministic; invalid config does not commit; migration is idempotent; stale write fails |
| Generic document CAS | namespaces, revisions, payloads and interleavings | exactly one competing expected-revision write wins; recovery preserves a readable previous or committed state |
| Candidate graph transaction | manifests, dependency graphs, grants, broken contributions, routes and schedules | rejected candidate publishes no partial catalogue/effects/routes/schedules and leaves prior accepted graph live |
| Manifest/runtime consistency | artifact manifests and registered contributions | runtime cannot register undeclared identity/role/capability; declared mandatory output cannot disappear silently |
| Deactivation/recovery | removed/upgraded/rejected plugins plus active workspace views | valid workspace remains; unavailable views preserve identity and recovery path; old effects are disposed |
| Grant enforcement | plugin requests and supplied port sets | undeclared/withheld capability cannot be reached in UI or headless mode |
| UI/headless equivalence | fixture artifacts/config/documents | compatible operations produce equivalent semantic results and diagnostics, excluding explicitly live-only fields |

Property tests complement focused examples. They should shrink failures into a
saved fixture document, manifest graph, operation sequence, and runtime
revision so a developer or agent can reproduce them.

## Contract and integration test layers

1. Unit/property tests for pure workspace/configuration/runtime resolution.
2. Contract tests for every TypeScript semantic port with native fake and real
   adapter implementations.
3. Tauri integration tests for resource behavior: terminal/process,
   credentials, filesystem, notifications, window intent, and durable CAS.
4. Artifact admission tests using bundled and deliberately malformed fixtures.
5. Headless versus UI runtime parity tests.
6. End-to-end smoke tests for a compatibility workspace and a multi-plugin
   Layman workspace.

The test matrix must avoid browser snapshots as the sole source of truth.
Semantic documents and structured runtime events are the assertion surface;
visual tests then verify that the renderer faithfully exposes them.

## Observability and agent inspection

User notices are not a diagnostic store. Add a separate structured diagnostics
stream/file with retention and correlation ids. A notice should reference the
diagnostic event id, plugin id, runtime revision, capability/operation, phase,
and causal error where safe to expose.

The runtime and CLI inspection surface should expose:

- accepted and rejected runtime revisions with reason;
- artifact/manifests, effective grants, and dependency graph;
- active contribution catalogue and workspace profile/document revision;
- scheduled routes/effects owned by each accepted plugin;
- recent structured errors and recovery actions;
- configuration source/provenance and pending migration state.

This replaces reliance on manual reproduction of transient notifications such
as failed terminal attachment or rejected runtime revisions.

## Rollout sequence

1. Land static dependency walls and runtime test bootstrap without behavior
   change.
2. Run the extracted ApplicationRuntime behind the current AppShell and
   compatibility workspace profile.
3. Enable the TypeScript configuration reader with legacy native config as
   read-only import input.
4. Ship the workspace plugin and Layman compatibility pane behind a selected
   profile/configuration flag.
5. Convert built-ins one by one, preserving legacy adapters only where a
   conversion is still active.
6. Add CLI inspect/validate, then plan/apply after transaction properties hold.
7. Enable new paths by default only after diagnostics show successful
   activation/migration and parity tests pass.
8. Remove compatibility renderers, native config writers, raw layout store,
   static module wiring, and legacy adapters in explicitly reviewed deletions.

Each rollout state needs a documented rollback: return to the last accepted
runtime revision and/or preserve a backed-up configuration document. Rollback
must not overwrite newer user modifications.

## Completion gates

The refactor is complete only when all of the following are true:

- the TypeScript ApplicationRuntime is the one composition root for UI and
  headless operation;
- all current modules are direct artifacts using the public plugin contract;
- workspace, frame/menu/navigation policy and configuration are TypeScript
  owned and agent-operable;
- native code offers only documented resource/durability providers and Tauri
  translation;
- raw Tauri use, Cordis internals, and private host imports are absent from
  plugin packages;
- no production writer persists Layman snapshots as workspace state;
- invalid candidate graphs/configuration/layout operations leave the prior
  accepted state intact;
- an installed lean CLI can inspect and validate the same configuration and
  workspace semantics as the app;
- legacy AppShell/static catalogues/native configuration/legacy module adapter
  have been deleted, not merely deprecated;
- automated static, property, contract, integration, package, and smoke checks
  cover the listed invariants.

At that point Layman is genuinely valuable: it is one replaceable renderer for
a user-configurable, plugin-composed workspace, rather than an embedded static
layout library.
