# Phase 3 — artifacts, capabilities, and preflight

## Outcome

Allow agents to add validated, immutable module artifacts without activating
them. Establish one capability vocabulary and a preflight result that truthfully
classifies each requested change as live, live-with-drain, restart-required, or
unsupported.

## Work package 3.1 — module package contract

Evolve `module.yaml` from repository composition metadata into a versioned
runtime manifest. Preserve build metadata in an appropriate build section, and
add runtime declarations for:

- module identity, version, API range, and runtime kind;
- frontend entry point and artifact files;
- declarative contributions and stable contribution ids;
- requested invoke, subscribe, channel, and host-service grants;
- configuration schema, secret fields, and supported scopes;
- resource kinds the module may own; and
- lifecycle support and restart classification inputs.

Create one authoritative capability catalog under `modules/api/`. Generate or
check the manifest schema, Rust identifiers, TypeScript identifiers, and grant
documentation from it. Unknown grants fail closed.

## Work package 3.2 — immutable artifact store

The add pipeline performs:

1. copy into an isolated staging directory;
2. reject path traversal, links escaping the package, and undeclared files;
3. validate manifest and API compatibility;
4. calculate and verify the content digest;
5. validate entry points, contributions, capability requests, and config schema;
6. atomically publish at an id/version/digest-qualified location; and
7. commit an installed-but-disabled registry revision.

Never overwrite a published digest directory. Re-adding the same artifact is
idempotent and returns the existing artifact record. A conflicting request id
or same version with different content is a structured conflict.

Add:

```text
shipctl modules add <archive-or-directory>
shipctl modules inspect <module-id> --artifact <digest>
shipctl modules diagnose <module-id> --artifact <digest>
```

`add` is noninteractive and does not imply `enable`.

## Work package 3.3 — mediated capability ports

Extend `ModuleHostServices` so every granted operation is a closure bound to an
exact host-created module instance identity. Module code never passes its own
module id as authority.

Keep invoke, subscription, channel, and service grants distinct. Handles
returned by ports must be registerable in the Phase 4 activation scope.

The trust model remains explicit: frontend ESM in the shared webview is trusted
code with mediated access, not a sandbox. A package needing untrusted native
execution requires a supported isolated worker or WASM driver; absent such a
driver, preflight returns unsupported or restart-required.

## Work package 3.4 — preflight service

Preflight is a pure, inspectable plan built before desired state changes. It
reports:

- artifact and manifest checks;
- host API compatibility;
- requested, effective, and denied grants;
- contribution id and route conflicts;
- runtime-driver availability;
- CSP and import-policy compatibility;
- configuration migration requirements; and
- resource ownership support.

New Rust, Tauri command/plugin registration, static shell, or CSP policy changes
are restart-required. That result leaves the active revision unchanged.

## Diagnostic and verification mechanism

Each check emits a stable code, status, redacted evidence, and remediation. The
preflight response is stored with the operation and can be reproduced by
`diagnose` without committing.

The artifact integration suite invokes the compiled CLI against an isolated
registry and covers valid content plus tampering, invalid schema, unknown grant,
API mismatch, contribution conflict, traversal, interrupted staging, and an
unsupported runtime kind.

## Exit proof

- A valid package is atomically visible by digest and remains disabled.
- The evaluated file set exactly matches the files covered by its digest.
- A failed add leaves neither a registry reference nor a published partial
  directory.
- Re-adding identical content is idempotent.
- Every rejected package returns check-level diagnostics through `diagnose`.
- Restart-required and unsupported requests do not advance desired activation.
- Capability catalog generation and existing schema/manifests checks are green.
- Existing repository gates remain green.

## Primary implementation areas

- `ops/modularity/schema/` and module manifests for the evolved package schema;
- `modules/api/` for capability vocabulary and public module contract;
- `core/backend/src/module_control/` for staging, hashing, and preflight;
- `core/frontend/host/` for mediated ports; and
- `ops/module-control/` for adversarial artifact fixtures.
