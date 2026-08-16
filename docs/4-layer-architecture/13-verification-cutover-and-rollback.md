# Verification, cutover, and rollback

<!-- markdownlint-disable MD013 -->

## Purpose

This migration changes the owner of behavior. A successful compile does not
prove that authority, lifecycle, resource ownership, or packaged behavior is
correct. Each cutover must prove both behavior preservation and removal of the
old authority path.

The proof unit is one vertical slice. A slice can be one service client, one
plugin lifecycle, one native provider, or one contribution family. A broad
phase can contain several independently reversible slices.

## Proof lanes

| Lane | Question | Required evidence |
| --- | --- | --- |
| Source graph | Are forbidden dependencies absent? | Resolved TypeScript, Cargo, Tauri feature, ACL, manifest, and artifact graphs |
| Contract | Do records and schemas state one valid meaning? | Schema validation, unique IDs, resolved dependencies, and semantic coverage |
| Unit | Does each pure component obey its local contract? | Focused Rust and TypeScript tests |
| Property | Does the seam hold over generated values and histories? | Seeded run, classifications, shrink data, replay command, and accepted regressions |
| Integration | Do adapters and services preserve cross-layer behavior? | Browser, Tauri, CLI, and cross-language fixtures |
| Package | Does the installed product contain and load the intended graph? | Built app, small CLI, artifact inventory, signatures or hashes, and launch proof |
| Live control | Can an agent inspect and operate the running state? | Structured desired, observed, activation, service, effect, grant, contribution, and resource snapshots |

The current `just` surface already groups checks under `check`, `test`,
`modularity`, `module-control`, and `message-bus`. Phase A must add focused
architecture checks to those existing families. It must not create a second
unrelated command system.

## Gate by phase

| Phase | Minimum proof before cutover | Old path that can then be removed |
| --- | --- | --- |
| A: contract foundation | Specification graph, passive imports, legacy composition characterization, and evidence schema pass | No behavior path; only duplicate informal architecture claims |
| B: semantic service wall | Adapter parity, fake-host conformance, activation context, and forbidden-import checks pass for the migrated service | Direct module import of Tauri and raw command or event names for that service |
| C: Cordis static composition | Lifecycle model, headless role, effect ownership, compound `commands` parity, and disposal properties pass | Its direct call in the static activation loop |
| D: provider extraction | Provider parity or explicit replacement semantics, authorization, ownership, package, and closure properties pass | That module's Rust crates, Cargo feature, ACL projection, and host adapter |
| E: immutable artifacts | Roundtrip, digest, external-closure, manifest parity, headless artifact, and built-in compound parity properties pass | Direct source import of the migrated built-in implementation |
| F: live reconciliation | State-model, service routing, revision, atomicity, failure, restart, and inspection properties pass | Restart-only activation and secondary lifecycle authority |
| G: workspace and closure | Workspace, renderer, layout, cleanup, absence, package, and agent-control proofs pass | Static membership and remaining compatibility shims; the legacy canvas has its own product deletion decision |

## Characterize before change

Before a slice changes authority:

1. Capture public requests, results, errors, events, durable writes, and owned
   resources for the current path.
2. State which behavior is required and which behavior is an accidental
   compatibility constraint.
3. Create a differential property for behavior that must remain equal.
4. Create a semantic property for behavior that must change.
5. Inject a deliberate defect to show that the property and oracle detect a
   real failure.

A differential result is not permission to copy an unsafe behavior. A stated
semantic change takes priority and must have its own reviewed rule.

## Cutover protocol

Every slice uses this order:

```text
baseline capture
    -> new path behind the existing public service
    -> shadow or isolated differential proof
    -> one selected authority
    -> packaged and live inspection proof
    -> delete the old path
    -> rerun the source graph and behavior proofs
```

The system must never use two writers for one durable state. A shadow path can
compare pure calculations or writes to isolated roots. It cannot mutate the
same registry, workspace document, usage database, repository, or terminal
session as the active path.

At the authority switch, the adapter selects either the old provider or the
new provider. It does not merge their results. The selection has one owner and
is visible in the runtime snapshot.

## Rollback rule

Rollback is a property of a slice, not a permanent architecture mode.

- Before the authority switch, rollback means removing the unused new path.
- After the switch but before deletion, rollback means selecting the old
  provider at the same service boundary.
- After deletion, rollback means reverting the complete slice in source and
  rebuilding. The product must not retain an untested hidden legacy path.
- A data-format change needs a read-old/write-new migration and a tested
  downgrade decision before cutover. If safe downgrade is not possible, the
  slice is not reversible and needs explicit reviewer approval.
- Terminal, watcher, ingest, and session resources must declare what survives
  adapter or plugin replacement. Rollback must not kill a host-owned resource.

Temporary cutover switches must name an owner, a removal gate, and the old
paths that they protect. A switch without a deletion gate is rejected.

## Property evidence and replay

Every gate records the evidence fields defined in
[Specification and property method](05-specification-and-property-method.md).
The repository keeps minimized counterexamples and their deterministic replay
commands. CI run logs are not the only copy of a known failure.

Fresh campaigns use lane settings derived from measured execution time and CI
policy. This plan does not define arbitrary case counts or durations. A gate
fails if the run cannot show which operation classes it exercised.

## Packaged-product proof

Source tests do not prove the product graph. A release candidate must show:

- the `.app` starts through the normal macOS launch path;
- the separate `shipctl` executable operates the installed registry and the
  running UI instance;
- the selected built-in artifacts match the accepted digests;
- no removed module crate, Tauri plugin, ACL entry, or source implementation is
  present in the package;
- a plugin can be enabled and disabled through `shipctl modules` and the live
  observed revision converges to the requested revision;
- a failed plugin reports a structured reason while the host and unrelated
  plugins remain operable;
- open terminal and assistant resources follow their stated ownership policy
  through plugin replacement and app restart.

The current CLI already provides `modules preflight`, `add`, `list`, `inspect`,
`inspect-capability`, `diagnose`, `verify`, `enable`, and `disable`, with JSON
output. The migration extends these existing controls. It does not require UI
scraping as proof.

## End-state acceptance proofs

The architecture contract is complete only when all these claims are true in
source, built artifacts, and a running packaged app:

1. A headless artifact containing TypeScript and a manifest can provide an
   application service, consume native platform services, and run reversible
   background work without React, Rust source, or a host rebuild.
2. A compound artifact containing TypeScript, optional React views, CSS,
   assets, schemas, and a manifest can be installed without Rust source or a
   host rebuild.
3. A plugin cannot resolve Tauri, private core, Layman, or another plugin
   implementation through its supported source or artifact dependency graph.
4. A plugin uses only injected, versioned semantic services and its declared
   artifact-local dependencies.
5. Enabling a plugin creates a Cordis activation and publishes its complete
   provided-service, effect, and optional contribution set atomically.
6. A plugin can provide a versioned application service to another plugin
   through Cordis without either plugin importing the other's implementation.
7. An agent can inspect the plugin's artifact, provenance, grants, required
   and provided services, background effects, contributions, health,
   resources, desired revision, applied revision, and activation identity
   through stable structured output.
8. Replacing a plugin loads a new digest-qualified artifact while the webview
   and unrelated activations remain alive.
9. A failed candidate or replacement leaves the complete previous accepted
   graph active and reports a correlated structured failure.
10. Disabling or removing a plugin disposes all activation-owned services,
    controllers, workers, effects, leases, styles, subscriptions, caches, and
    visible contributions.
11. Host-owned terminals and other durable resources keep stable identity and
   state through plugin replacement unless an explicit authorized destructive
   operation changes them.
12. The semantic workspace reconciles removed, failed, and restored view
    definitions without corrupting its document; renderer state is not the
    durable authority.
13. Built-in and installed plugins use the same artifact admission,
    activation, replacement, disposal, and inspection path.
14. Adding a new native privilege requires a reviewed permanent platform
    capability and a new Shipctl release; a plugin artifact cannot introduce
    native code or raw IPC.

### Repository closure proofs

1. `core/frontend/platform` is the only frontend Tauri import boundary, and
    native authority is grouped by stable platform capability.
2. No Rust crate remains under `modules/` or `module-api/`, and removing any
    individual plugin leaves the host and unrelated plugins operable.

Passing these proofs authorizes closure. It does not require deletion of the
legacy canvas unless product review separately selects Layman as the sole
renderer.
