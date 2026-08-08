# Expose the read-only offline module CLI

## Outcome

The separate `shipctl` CLI reads an existing per-instance registry without a
running webview and provides deterministic offline list, inspect, diagnose,
and expectation verification commands through the compiled binary.

## Dependencies

- Transactional module registry core.
- Truthful static-builtin inventory seeding.

## Production change

Extend `cli/`, not `src-tauri`, with:

```text
shipctl modules list --offline
shipctl modules inspect <module-id> --offline
shipctl modules diagnose [<module-id>] --offline
shipctl modules verify <module-id> --expect <expectation.json> --offline
```

Resolve the selected state root with the established explicit/environment/
default precedence and derive its registry path through `ShipctlPaths`. The
offline adapter opens the registry read-only, uses the Step 0D contracts for
inspection and verification data, and never launches `shipctl-ui`, contacts
the local control socket, prompts, migrates, or writes the registry. Render
TOON by default and canonical JSON with `--output json`; write successful
structured data only to stdout and structured errors only to stderr.

Add an explicit offline read-model wrapper with `runtimeAvailable: false`.
It must show desired state and last reported observations separately, and must
never infer a live runtime from either. `diagnose` runs the registry checks;
`verify` parses the caller expectation through the canonical contract and
returns a non-zero exit status for an unmet expectation.

Add an isolated fixture generator and public `ops/module-control` command that
create only test-root registry state for the compiled-binary tests.

## Diagnostic/observability

Give every command a stable operation/code/status envelope and include schema
version, registry revision, resolved redacted paths, offline runtime
availability, and canonical diagnostics. Distinguish unavailable runtime as
information from registry corruption, missing records, failed diagnostics, and
verification mismatch.

## Mechanism-level integration test

Build the real `shipctl` binary, create a fixture registry under an isolated
state root, then invoke every offline command against it. Assert process exit
status, stdout, stderr, TOON/JSON data equivalence, `runtimeAvailable: false`,
desired-versus-last-observed separation, successful and failed expectation
results, corruption diagnostics, and that no UI process, control endpoint, or
production default profile is touched.

## Acceptance evidence

- The compiled CLI exposes exactly the four Phase 1 offline command families.
- Offline reads use the injected registry path and leave its bytes unchanged.
- JSON golden outputs contain Step 0D-compatible contract data and explicit
  unavailable runtime state.
- Diagnose reports schema/integrity, revisions, provenance, missing digest
  references, operation-journal checks, and runtime unavailability accurately.
- Verify exits non-zero on mismatch while still emitting a machine-readable
  result.
- The repository-owned isolated CLI integration lane and relevant existing
  gates pass.

## Non-goals

- Online module commands, local-control protocol changes, or runtime polling.
- Artifact installation, preflight, lifecycle, or supervisor behavior.
- CLI-to-Tauri dispatch or frontend rendering in `src-tauri`.
- Cargo-feature changes or Rust rebuilds for a runtime toggle.
