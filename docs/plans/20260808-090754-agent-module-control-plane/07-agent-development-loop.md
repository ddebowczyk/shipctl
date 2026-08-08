# Phase 7 — agent development loop

## Outcome

Give agents one reliable source-to-runtime workflow that builds immutable
artifacts, applies them through the public control plane, and verifies the exact
code and configuration now running.

## Work package 7.1 — development artifact builder

Add:

```text
shipctl modules dev <source-path> --watch
```

The command owns source watching and invokes the repository module builder. The
desktop host remains a loader and reconciler; it never executes half-written
source trees or embeds TypeScript build policy.

For each coherent change:

1. build into a temporary output root;
2. run manifest, schema, capability, and package validation;
3. calculate the immutable digest and publish as `development` provenance;
4. submit an update only after the build and preflight succeed;
5. observe the resulting operation; and
6. print the operation, revision, digest, runtime marker, and verification result.

A build failure creates diagnostics but no registry revision. A newer coherent
build may supersede an uncommitted watch result; committed revisions remain in
the journal and are never rewritten.

## Work package 7.2 — expectation-based verification

Make `modules verify` suitable for agent scripts. An expectation can assert:

- module identity, provenance, version, and digest;
- desired enabled state and configuration revision;
- observed runtime state and applied registry revision;
- evaluated runtime marker;
- contribution ids and effective grants;
- resource and drain conditions; and
- required or forbidden diagnostic codes.

The command emits a field-by-field comparison and returns non-zero for unmet
expectations or unavailable required evidence. It does not treat warnings as
failures unless the expectation says so.

Add a top-level `shipctl diagnose` that aggregates instance, registry,
supervisor, module, contribution-owner, and resource consistency checks. It is a
read-only full-application diagnostic, not a repair command.

## Work package 7.3 — reproducible evidence bundles

Every development operation can emit an evidence directory containing:

- normalized command requests and structured responses;
- operation transitions and registry revisions;
- artifact manifest, digest, and provenance;
- redacted inspect, diagnose, and verify results;
- supervisor transition and catalog ownership snapshots; and
- relevant redacted host logs correlated by operation id.

The command prints the evidence path. Secrets and raw terminal content are
excluded by contract. Artifact retention and evidence cleanup remain explicit
operator policy; this plan does not invent a hidden retention threshold.

## Diagnostic and verification mechanism

Test the watcher as a real subprocess against an isolated source fixture and a
running Shipctl host. The test edits the exported behavior marker, waits on the
returned operation rather than sleeping, then verifies the exact evaluated
digest and marker through the CLI.

Failure cases cover compiler failure, schema failure, preflight failure,
activation failure, supervisor disconnect, and a subsequent successful edit.
The evidence bundle itself validates against a versioned manifest.

## Exit proof

- Editing fixture A to B publishes one immutable B only after validation.
- The running instance reports B's exact digest and evaluated marker.
- A failed build or activation leaves the last good module active.
- A later valid edit recovers without restarting the watcher or Shipctl.
- Configuration-only changes use `reconfigure`, not a synthetic code rebuild.
- `verify` can prove both positive and negative expectations from JSON.
- The evidence bundle contains correlated, redacted facts sufficient to replay
  the result without reading private in-memory stores.
- Existing repository gates remain green.

## Primary implementation areas

- `ops/build/` for deterministic module artifact building;
- `src-tauri/src/` for CLI dev/watch adapter and output rendering;
- `core/backend/src/module_control/` for evidence correlation;
- `modules/fixture/` for source-edit fixtures; and
- `ops/module-control/` for subprocess integration tests.
