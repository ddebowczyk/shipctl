# Execution order and task contract

## Critical path

```text
Step 0A named-instance contract
  -> Step 0B saved-state contract
  -> Step 0C packaged launch/list/inspect/save/load/stop foundation
  -> Step 0D module contracts + loader tripwires
  -> Phase 1 durable registry
  -> Phase 2 module inspection over exact running-instance access
  -> Phase 3 immutable artifact and preflight
  -> Phase 4 supervisor + atomic snapshot + scopes
  -> Phase 5 generic lifecycle + config + leases
  -> Phase 6 all current module migrations
  -> Phase 7 source-to-runtime agent loop
  -> Phase 8 packaged full-application proof
```

Step 0C is the implementation starting point. Do not begin module registry,
broad migration, settings UI, or developer-watch UX while executable packaging,
named identity, path isolation, state round-trip, and the public automation gate
are unresolved.

## Gate dependencies

<!-- markdownlint-disable MD013 -->

| Work | May proceed when | Must not claim yet |
| --- | --- | --- |
| Named-instance foundation | Steps 0A and 0B are approved | Module lifecycle |
| Module contract and loader work | Step 0C public automation gate passes | Runtime module lifecycle |
| Registry repository | Step 0D contracts are stable | Live module observation |
| IPC adapters | Registry read model exists | Mutation support |
| Artifact pipeline | Loader tripwires pass | Live enable/update |
| Fixture supervisor | Artifact and IPC diagnostics exist | All-module support |
| Generic lifecycle | Fixture A/B/failure/rollback is proven | Current modules migrated |
| Module migrations | Generic matrix passes for fixture | Packaged mission complete |
| Watcher and UI management | Public lifecycle contract is stable | Release readiness |
| Packaged E2E | Every in-scope module matrix passes | None after proof passes |

<!-- markdownlint-enable MD013 -->

## Implementation task template

Create one task per work package in the phase chapters. Each task description
must contain:

```markdown
### Outcome
One observable behavior this task adds.

### Depends on
Exact prior contract, task, or file-level interface required.

### Production change
Smallest code and schema changes needed for the outcome.

### Diagnostic change
New or extended inspect, diagnose, operation, or verification evidence.

### Mechanism integration test
Test through the production boundary available at this phase.

### Acceptance evidence
Command, expected structured fields/codes, and invariants that prove completion.

### Non-goals
Nearby claims that fail the mission-necessity test.
```

A task cannot defer its diagnostic or integration test to a later observability
task. Schema and golden-fixture changes land before or with their first producer.

## Verification ladder

Run only the evidence necessary for the changed contract, then its containing
gate:

1. focused unit and schema fixtures;
2. phase-specific compiled-binary or running-host integration test;
3. `just module-control contract` and the affected integration matrix;
4. existing `just check all` and `just test full`; and
5. `just module-control e2e` when a runtime, lifecycle, resource, module, or
   packaging claim changes.

`just module-control all` composes the established module-control gates. It
must not duplicate test logic or turn a generated metric into an arbitrary
threshold.

## Review checkpoints

Human review is required at these contract boundaries before dependent work is
scheduled:

- after Steps 0A and 0B: executable roles, naming, state-root isolation,
  shutdown, and saved-state semantics;
- after Step 0C: packaged launch, IPC framing, selector behavior, state-provider
  coverage, and black-box automation evidence;
- after Step 0D: schema ownership, SQLite registry shape, and loader tripwires;
- after Phase 3: manifest v2, capability catalog, artifact trust policy, and
  preflight classification;
- after Phase 4: atomic snapshot, activation scope, observation model, and
  fixture failure proof;
- after Phase 5: lifecycle semantics, configuration scopes, drain behavior, and
  CLI contract; and
- after Phase 8: evidence sufficiency for the product claim.

This document pack is the review artifact. It does not create Beads tasks; after
approval, convert its work packages into an epic without changing their
dependencies or acceptance evidence.

## Explicitly rejected claims

- Reload-safe PTY reattachment is useful resilience work, but deleting planned
  reloads is the direct prerequisite for module lifecycle safety.
- A REST listener is unnecessary; same-user local IPC provides instance access
  without opening a network service.
- Statically linked Tauri plugins are not runtime-installable modules. New native
  registrations remain restart-required until an isolated runtime driver exists.
- Desired state alone does not prove runtime success. Verification must join
  registry and per-instance observed state by revision and digest.
- Terminal and assistants behavior cannot define a generic lifecycle. They are
  high-risk conformance cases for the same ownership contracts used elsewhere.
- Observability is not a late phase. Each phase produces its own diagnostics and
  integration evidence before dependent behavior starts.

## First implementation slice

Begin with Step 0C work packages 0C.1 and 0C.2 together: split `shipctl` from
`shipctl-ui`, create immutable `InstanceContext` and `ShipctlPaths`, inject them
before initialization, and package both executables. Then add leases and the
ready handshake so the first vertical proof can start, list, inspect, and stop
one named isolated instance. State snapshot providers and the complete
two-instance black-box gate close Step 0C before module contracts begin.
