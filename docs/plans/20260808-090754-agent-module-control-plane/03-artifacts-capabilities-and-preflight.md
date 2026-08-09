# Phase 3 — module packages, capability contracts, and preflight

## Outcome

Install an immutable TypeScript module artifact without activating it. The
artifact may define new versioned capabilities and declare providers and
consumers for built-in or module-defined capabilities. Agents can inspect all
of this while the module is disabled.

## Work package 3.1 — capability meta-contract

Define one versioned meta-contract for capability definitions. A capability
declares:

- stable ID, semantic version, and definition digest;
- typed command and query ports;
- emitted events and observable topics;
- dedicated stream contracts where ordered continuous data is required;
- request, response, event, and stream schemas;
- provider cardinality and selection rules;
- supported instance, workspace, or global scopes; and
- which surfaces agents may inspect, invoke, watch, or attach to.

`modules/api` owns this meta-contract and built-in host capability definitions.
Installed modules may contribute additional definitions. Preflight rejects an
attempt to reuse the same capability ID and version with different content.

A module does not receive one universal inbox. It implements capability ports
and may publish declared events, use directed channels, and expose dedicated
streams. Every surface is explicit and schema validated.

Capability definitions own the public semantic surfaces: ports, events, topics,
and streams. The artifact manifest separately declares any typed directed
channels it handles or publishes for coordination and binds them to its
provider identity. A module is not required to have a channel, and a declared
channel never grants ambient authority or substitutes for a capability port.

## Work package 3.2 — runtime module package

Extend `module.yaml` into a runtime manifest with:

- module ID, human-readable name, version, API range, and runtime kind;
- JavaScript entry point, styles, assets, and integrity metadata;
- typed message contracts plus declared directed-channel and topic bindings;
- `capabilities.defines`, `capabilities.implements`, and
  `capabilities.requires`;
- UI contributions and stable contribution IDs;
- requested host grants and native-adapter requirements;
- configuration schema, secret references, and supported scopes; and
- live, drain-required, restart-required, or unsupported lifecycle class.

Source modules remain normal npm/pnpm packages built with Vite or Rollup. The
runtime payload is an immutable Shipctl archive containing the manifest,
JavaScript, chunks, styles, assets, capability/message schemas, and an integrity
index. React, React DOM, and the Shipctl module API are host peers so a loaded
module shares the host React singleton.

The archive layout and integrity serialization are canonical: equivalent
declared runtime content produces the same content identity regardless of its
source provenance.

Runtime installation never runs package-manager lifecycle scripts, creates a
`node_modules` tree, rebuilds Rust, or reloads the webview.

## Work package 3.3 — immutable artifact store

The add pipeline:

1. stages the archive in an isolated directory;
2. rejects traversal, escaping links, undeclared files, and digest mismatch;
3. validates the manifest, capability definitions, bindings, schemas, API
   compatibility, grants, and lifecycle classification;
4. calculates the complete content digest;
5. atomically publishes the artifact under that digest; and
6. registers it disabled without changing the active runtime snapshot.

Artifact identity is content-derived. Provenance and source affect trust and
replacement policy but are not part of identity.

Phase 3 validates and publishes disabled artifacts only. It does not load
artifact code, publish runtime routes, or alter frontend composition; provider
activation and loader attachment begin in Phase 4.

A disabled artifact exposes only inspectable manifest and capability metadata.
It publishes no callable port, channel, event topic, or stream; Phase 4 atomic
snapshot publication is the sole activation point for those surfaces.

## Work package 3.4 — preflight and offline inspection

Preflight returns structured results for:

- artifact and manifest integrity;
- capability-definition conflicts;
- provider and consumer compatibility;
- missing or denied grants;
- host API and peer-dependency compatibility;
- native-adapter availability; and
- the truthful lifecycle class.

Offline commands expose installed modules, artifact digests, capability
definitions, provider requirements, requested grants, and preflight results.
They read through the repository boundary and do not activate code or edit the
registry directly.

## Diagnostic and verification mechanism

Use one fixture archive that includes JavaScript, a stylesheet or asset, a new
capability definition, a typed provider port, an emitted event declaration, a
UI contribution, and a scheduler-addressable message contract. Create valid A
and B artifacts plus invalid variants for tampering, incompatible capability
redefinition, missing grants, and unsupported native requirements.

## Exit proof

- Fixture A can be built, added disabled, and inspected by module and
  capability ID.
- Its new capability is discoverable before a provider is active.
- The stored artifact digest covers code, styles, assets, and contracts.
- Repacking identical content yields the same identity regardless of source.
- Incompatible same-ID/version capability content and tampered files are
  rejected before publication.
- Add and preflight do not rebuild the Rust host, reload the webview, or write
  runtime events.

## Primary implementation areas

- `modules/api/` for the meta-contract and built-in host contracts;
- `examples/module-fixture/` for the first package and capability definition;
- `core/backend/src/module_control/` for artifact and preflight services;
- `core/frontend/host/` for host-peer contract definitions only; and
- `ops/module-control/` for archive and public inspection proofs.
