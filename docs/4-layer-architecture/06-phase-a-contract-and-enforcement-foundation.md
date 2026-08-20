# Phase A: contract and enforcement foundation

## Outcome

Create an executable architecture specification, property-test harnesses, and
baseline characterization without changing runtime behavior.

This phase is first because every later deletion depends on a stable statement
of what replaces it. If Shipctl never adopts dynamic plugins, the result still
improves architecture enforcement and regression replay.

## Normative semantics

- **SEM-A-001:** A normative architecture record changes before the test and
  code that implement a changed rule.
- **SEM-A-002:** Every dependency edge in the specification resolves and the
  graph is acyclic.
- **SEM-A-003:** Every implemented property identifies an executable test and
  every required property failure can be replayed from recorded evidence.
- **SEM-A-004:** Importing a plugin package performs no I/O, registration,
  timer creation, or native call.
- **SEM-A-005:** A compatibility bridge names the old path that it will delete
  and the proof that permits deletion.
- **SEM-A-006:** Existing static module behavior remains the baseline until a
  later semantic record explicitly changes it.

## Work

1. Create the versioned capability-record schema and records named in
   [Artifacts and agent operations](15-artifacts-repository-layout-and-agent-ops.md).
2. Add `ops/architecture` to the operations manifest and top-level `just`
   dispatch.
3. Extend the existing AST modularity checker with reusable rule configuration
   instead of adding another source scanner.
4. Add `fast-check` to the test workspace and `proptest` to the Rust crates that
   own properties. Do not add Hegel.
5. Add property evidence and replay helpers.
6. Capture the current static membership, direct Tauri import sites, native
   module crates, module manifests, and startup runtime behavior as an
   inspectable architecture snapshot.
7. Add characterization properties for current module composition and
   manifest parsing.

## Property cards

### PROP-A-SPEC-001

- **Claim:** Every generated capability-record set is accepted exactly when
  all IDs are unique, every dependency resolves, the graph is acyclic, and all
  property evidence references local semantics.
- **Shape:** differential.
- **Evidence:** SEM-A-001, SEM-A-002.
- **Domain:** generated records with valid and invalid IDs, dependency edges,
  cycles, property IDs, and evidence references. Exclude filesystem I/O errors.
- **Preconditions:** records conform to the lexical YAML schema when testing
  cross-record rules.
- **Oracle:** an independent in-memory graph and set model computes validity.
  It shares no traversal code with the production checker.
- **Failure value:** a cyclic migration graph passes validation and produces an
  impossible task order.
- **Tier:** pull request.
- **Current status/test ID:** implemented / `architecture.spec.graph.property`.

### PROP-A-IMPORT-001

- **Claim:** Importing any generated plugin entrypoint without calling its
  exported constructor causes no observable I/O, timer, registration, or Tauri
  access.
- **Shape:** safety.
- **Evidence:** SEM-A-004.
- **Domain:** generated import orders over fixture plugins with optional module
  dependencies. Exclude explicit constructor calls.
- **Preconditions:** each fixture is a syntactically valid module.
- **Oracle:** fresh child-process tripwires record filesystem, network, timer,
  global registry, and Tauri-proxy access. The probes live outside plugin code.
- **Failure value:** importing a usage plugin starts ingest or opens storage.
- **Tier:** pull request.
- **Current status/test ID:** implemented / `architecture.plugin.passive-import.property`.

### PROP-A-COMPOSITION-001

- **Claim:** For every generated ordered set of distinct modules, the
  characterized contribution inventory equals the independent model of the
  same declared contributions and rejects the same duplicate ownership cases.
- **Shape:** differential.
- **Evidence:** SEM-A-006.
- **Domain:** module objects with commands, panels, surfaces, settings, message
  declarations, and lifecycle hooks. Exclude React rendering behavior.
- **Preconditions:** generated values satisfy current TypeScript contracts.
- **Oracle:** a test-only normalized inventory model retains the declarations
  and applies only the documented ownership rules.
- **Failure value:** runtime composition later drops a settings contribution.
- **Tier:** pull request.
- **Current status/test ID:** implemented / `architecture.module-composition.property`.

### PROP-A-REPLAY-001

- **Claim:** Every minimized property failure artifact replays to the same
  property ID and normalized counterexample on an unchanged repository
  revision.
- **Shape:** roundtrip.
- **Evidence:** SEM-A-003.
- **Domain:** generated TypeScript and Rust failure records with seeds, paths,
  property IDs, and serialized counterexamples. Exclude runner version changes.
- **Preconditions:** the recorded repository and runner identities match.
- **Oracle:** compare the stored normalized failure with a new isolated replay.
- **Failure value:** a lifecycle defect cannot be reproduced after an agent
  hands control back to a developer.
- **Tier:** pull request.
- **Current status/test ID:** implemented / `architecture.property-replay.property`.

## Exit proof

- schema and cross-record checks pass;
- the dependency graph is inspectable as JSON;
- TypeScript and Rust property smoke tests shrink and replay a deliberate
  failure;
- the current architecture snapshot is generated from source;
- no runtime product path changed;
- each later phase has a record, semantics, properties, and deletion gate.

## Deletion gate

This phase deletes no runtime path. It can delete any ad hoc architecture
inventory script only after `ops/architecture inspect --json` produces the
same required facts.

## Implementation evidence

Phase A is implemented without changing an application runtime path:

- `ops/architecture/bin/inspect.mjs` emits the current nine-module
  runtime-artifact source snapshot. The reviewed baseline is
  `spec/baseline/source-architecture.json`.
- The existing modularity AST scanner resolves the public entrypoint's static
  dependency closure and rejects filesystem, network, timer, registry, and
  Tauri work evaluated anywhere in that closure.
- Fresh-process import probes and the static scanner independently classify
  generated passive and active entrypoints.
- The module-composition property compares generated module projections and
  duplicate-owner outcomes with an independent model.
- `fast-check` and `proptest` deliberate failures shrink, emit schema-valid
  evidence under ignored `target/architecture-evidence/`, and replay in a new
  process against the same repository identity.

Run `just architecture all` from a complete operations checkout, or run
`just --justfile ops/architecture/justfile all` directly.
