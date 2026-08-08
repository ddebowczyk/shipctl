# Step 0D — module contracts and loader test kernel

## Outcome

Build the stable module vocabulary and executable loader feasibility proofs on
the named-instance foundation delivered by Steps 0A–0C. This step makes no
module lifecycle claim. It removes uncertainty before the module registry and
agent module commands depend on it.

## Work package 0D.1 — extend injected paths for module control

Consume the immutable `InstanceContext` and `ShipctlPaths` from Step 0C. Extend
their derived paths with:

- the immutable module artifact root;
- the registry database path; and
- module-control evidence paths used by repository operations.

Module-control tests inherit the Step 0 isolation guard and must fail if they
touch the production state root. Migration of a future module-specific path is
required when that module enters Phase 6.

## Work package 0D.2 — canonical domain contracts

Define versioned, serializable Rust contracts before implementing storage:

- `ModuleIdentity`: id, semantic version, content digest, source, runtime kind;
- `DesiredModuleState`: selected artifact, enabled state, configuration revision;
- `ObservedModuleState`: instance id, applied registry revision, lifecycle state;
- `ModuleOperation`: request id, target revision, transitions, result;
- `Diagnostic`: stable code, severity, check, summary, redacted evidence, remedy;
- `ResourceLease`: owner instance, resource kind, resource identity, drain state;
- `ModuleInspection`: manifest, desired, observed, grants, contributions, leases;
- `VerificationExpectation` and `VerificationResult`.

The canonical model serializes to JSON. Generate or check the TypeScript shapes
used by the supervisor from the same schema fixtures. Do not make UI stores,
Tauri command names, or database rows part of this public contract.

Diagnostic codes are hierarchical and stable, for example:

```text
module.artifact.digest_mismatch
module.manifest.invalid
module.runtime.activation_failed
module.runtime.revision_not_observed
control.instance.ambiguous
```

Messages may improve without breaking automation; codes and evidence fields may
not change without a schema-version decision.

## Work package 0D.3 — module-control protocol overlay

Extend the Step 0 `shipctl` CLI and the existing running-instance protocol with
`modules` and `operations` command families. Do not add mode dispatch to
`shipctl-ui` or a second local endpoint. Keep parsing and rendering outside the
registry domain service.

Define a versioned JSON frame protocol for local request, response, event, and
stream completion messages. CLI TOON is presentation only; it is not the wire
protocol.

## Work package 0D.4 — loader feasibility tripwires

Extend the existing fixture build into executable production-path checks:

1. Build two frontend ESM artifacts with different exported runtime markers.
2. Serve each from its content-digest-qualified production URL.
3. Import both through the packaged Tauri CSP and custom-protocol path.
4. Prove both use the host React singleton.
5. Prove the evaluated marker changes from A to B without a webview reload.
6. Prove a failed import leaves A evaluable and reports a structured phase.

Also classify the current native boundary:

- trusted frontend ESM is live-loadable through mediated ports;
- already compiled host adapters can be called but are not module artifacts;
- new Rust/Tauri registration is restart-required;
- unimplemented worker or WASM runtime kinds are rejected as unsupported, not
  accepted with a false live-lifecycle promise.

Failure of the production-path dynamic-import or React-identity proof blocks
Phases 3–8 and forces a loader design decision. It must not be hidden by a dev
server-only test.

## Diagnostic and verification mechanism

Add schema golden fixtures for success and every contract-level failure class.
The contract runner emits one `VerificationResult` containing:

- fixture identity and schema version;
- expected and observed result;
- diagnostic codes;
- resolved isolated paths; and
- artifact markers and digests for loader probes.

Planned entry point:

```text
just module-control contract --output json
```

## Exit proof

- Contract fixtures round-trip Rust to JSON and validate in TypeScript.
- Invalid versions, unknown fields, secret leakage, and malformed diagnostics
  fail with stable codes.
- Tests prove the production state root and unrelated runtime descriptors were
  untouched.
- Packaged-path ESM A and B report their exact evaluated digests and share React.
- Failed C produces a structured diagnostic and leaves A/B evidence intact.
- Existing `just check all` and `just test full` remain green.

## Primary implementation areas

- `core/backend/src/` for module-derived paths and domain contracts;
- `core/frontend/host/` for generated or checked frontend contract types;
- `ops/modularity/fixtures/` for production-path loader artifacts; and
- `ops/module-control/` for contract runners and evidence collection.
