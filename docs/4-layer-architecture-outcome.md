# Four-layer architecture: repository outcome

## Purpose

This document makes the conceptual four-layer architecture concrete on disk.
It distinguishes the intended repository outcome from the transitional layout
that exists while capabilities are being migrated.

The architectural layers are expected to have enforceable physical
boundaries. They do not, however, map one-to-one onto four top-level
directories. The permanent trusted Shipctl platform comprises both the native
kernel and the TypeScript application host, so both live under `core/`.

## Canonical layers

<!-- markdownlint-disable MD013 -->

| Layer | Responsibility | Repository location |
| --- | --- | --- |
| 1. Native kernel | OS authority, PTYs, processes, filesystem access, credentials, Git execution, durable resources, admission, grants, and native inspection | `core/backend/`, `core/tauri/`, and `src-tauri/` |
| 2. Trusted application host | Private IPC adapters, Cordis runtime, plugin loading, lifecycle, contribution catalogs, workspace, canvas, diagnostics, and application composition | `core/frontend/` |
| 3. Public plugin API | Semantic service contracts, plugin manifests, lifecycle and contribution types, stable IDs, grants, and testing fakes | `module-api/frontend/` |
| 4. Application plugins | TypeScript workflows, application services, background effects, commands, controllers, and optional React presentation | `modules/<plugin-id>/` |

<!-- markdownlint-enable MD013 -->

The dependency and authority direction is:

```text
Layer 4: TypeScript application plugin
        |
        | imports contracts and receives services
        v
Layer 3: TypeScript plugin API
        ^
        | implemented by trusted host adapters
        |
Layer 2: Trusted TypeScript application host
        |
        | private typed IPC
        v
Layer 1: Rust/Tauri native kernel
```

The Chinese wall is between the trusted permanent platform and replaceable
plugins. It is not between Rust and TypeScript:

```text
trusted permanent platform       replaceable userland
---------------------------+--------------------------------
core/backend               |
core/tauri                 |
core/frontend              |  module-api contracts
                           |
                           |  modules/<plugin-id>
```

Plugins may cross this wall only through the public plugin API. They cannot
import Tauri, private host code, native bindings, Layman, a concrete Zustand
store, or another plugin implementation.

## Target source tree

The intended source layout is:

```text
shipctl/
|-- core/                         permanent trusted platform
|   |-- backend/                  Layer 1: Tauri-free Rust
|   |   `-- src/<capability>/
|   |-- tauri/                    Layer 1: private Tauri adapters
|   |   `-- src/<capability>.rs
|   `-- frontend/                 Layer 2: trusted TypeScript host
|       |-- platform/             private IPC and semantic adapters
|       |-- runtime/              Cordis, activation, loading, reconcile
|       |-- contributions/        reversible registries and catalogs
|       |-- workspace/            semantic workspace model
|       |-- canvas/               legacy and Layman renderers
|       `-- shell/                startup and top-level React composition
|
|-- module-api/                   Layer 3: public TypeScript plugin API
|   `-- frontend/src/
|       |-- contract/             manifests and contribution contracts
|       |-- services/             semantic service interfaces
|       |-- runtime/              activation and disposal contracts
|       `-- testing/              fake host and conformance kit
|
|-- modules/                      Layer 4: plugin artifact sources
|   `-- <plugin-id>/
|       |-- module.yaml           source descriptor and build inputs
|       |-- src/                  TypeScript application logic
|       |   `-- ui/               optional React presentation
|       `-- tests/                behavior and conformance tests
|
|-- src-tauri/                    Layer 1 application-bundle shell
|-- cli/                          CLI executable over native core
|-- src/                          minimal Vite entrypoints
|-- ops/                          repository operations, not runtime code
`-- docs/                         specifications and durable reference
```

`src-tauri/` is not a fifth layer. It is the Tauri application composition
shell for Layer 1 and remains beside `tauri.conf.json` because the crate using
`tauri::generate_context!()` must live there.

Likewise, `cli/` is not another architectural layer. It is a separate product
executable that reuses Tauri-free native capabilities from `core/backend`.

## Why `core/` contains two layers

`core/` means permanent trusted Shipctl code, not Rust-only code. It contains:

- Layer 1, which owns native authority and durable native resources; and
- Layer 2, which owns the permanent application runtime in the webview.

The TypeScript application host cannot be an ordinary plugin. A permanent
owner must exist to:

- load, validate, activate, replace, and dispose plugins;
- own the Cordis application root;
- mediate private native calls;
- publish immutable service and contribution catalogs;
- reconcile the semantic workspace;
- host the canvas renderer;
- provide React, React DOM, Cordis, and plugin API singleton identities; and
- expose runtime state and failures to agents.

Layer 2 is trusted platform code even though its first execution realm is the
main webview.

## Platform capabilities are vertical slices

A native platform capability appears in several layer-specific directories.
This is intentional dependency inversion, not boundary leakage:

```text
modules/<consumer>/src/                 Layer 4 consumer
             |
module-api/frontend/src/services/       Layer 3 semantic contract
             |
core/frontend/platform/                 Layer 2 trusted adapter
             |
core/tauri/src/                         Layer 1 Tauri transport
             |
core/backend/src/<capability>/          Layer 1 native implementation
```

For example, the final credential-store slice should resemble:

```text
modules/assistants/src/
  consumes CredentialStoreService

module-api/frontend/src/services/credentials.ts
  defines credential identities, operations, grants, and results

core/frontend/platform/credentials.ts
  authorizes the activation and translates semantic calls to private IPC

core/tauri/src/credentials.rs
  binds typed requests to Tauri and native authorization

core/backend/src/credentials/
  owns credential persistence and secret-handling policy
```

The Assistant plugin owns Assistant policy. It does not own the credential
store merely because it is currently the first consumer.

## Current transitional layout

Today, `modules/<name>/` is still a migration container rather than the final
plugin artifact source:

```text
modules/assistants/
|-- backend/                       transitional Rust/Tauri implementation
|-- host/                          transitional native composition glue
|-- frontend/                      future plugin mixed with legacy edges
`-- module.yaml
```

At the target it becomes:

```text
modules/assistants/
|-- module.yaml
|-- src/
|   `-- ui/
`-- tests/
```

It will contain no Rust crate, native host crate, Tauri ACL, direct
`@tauri-apps/*` import, or private host dependency.

The migration deliberately closes boundaries before relocating
implementations:

1. characterize existing behavior;
2. define a semantic service in Layer 3;
3. implement a trusted Layer 2 adapter over the existing command;
4. migrate the feature frontend to that service;
5. extract platform-worthy native behavior into Layer 1;
6. move feature workflows and policy into the TypeScript plugin;
7. prove parity, authorization, ownership, and disposal; and
8. delete the old Rust module, feature, ACL, and compatibility paths.

Consequently, a capability can temporarily have its public contract and
trusted frontend adapter in their target locations while its native
implementation remains under `modules/<name>/backend`. That is migration
residue, not the architectural outcome.

## `module-api/` is not a feature module

`module-api/` is Layer 3: the public SDK boundary between the trusted platform
and plugins. Its internal names express contract direction, not separate
runtime layers:

- `host/` contains contracts implemented by the host;
- `module/` contains contributions implemented by plugins;
- `protocol/` contains shared semantic values; and
- `testing/` contains fakes and conformance helpers.

The current `module-api/backend/` Rust crate is a migration compatibility
crate. It is deleted after native contracts move to their permanent
`core/backend` and `core/tauri` owners. The final public plugin API is
TypeScript-only.

Renaming `module-api/` to `plugin-api/` would improve visual clarity, but the
architecture defers that rename until the contract is stable. A rename does
not itself establish the boundary and would currently create broad import
churn.

## Built-in and installed plugins

Built-in source lives under `modules/<plugin-id>/`, but runtime installation
does not execute that source tree directly. It produces an immutable artifact:

```text
<plugin-id>/<content-digest>/
|-- plugin.json
|-- plugin.js                       required application entrypoint
|-- plugin.css                      optional
|-- assets/                         optional
|-- schemas/                        optional
`-- integrity.json
```

Externally installed plugins use the same artifact format. Built-in and
installed plugins pass through the same validation, admission, import,
activation, contribution, disposal, and inspection paths. A built-in is only
an artifact that ships with Shipctl and is enabled by default.

Plugins may be:

- headless, providing services and background effects without React;
- presentation-only, contributing views or other UI surfaces; or
- compound, owning application behavior and optional presentation under one
  activation and disposal tree.

“Plugin backend” therefore does not imply Rust. Headless TypeScript workflows
belong to Layer 4. Only behavior requiring native authority, durable
cross-plugin ownership, or native enforcement belongs to Layer 1.

## Architecture taxonomy inconsistency

The narrative architecture defines these canonical four layers:

1. native kernel;
2. trusted TypeScript application host;
3. TypeScript plugin API; and
4. TypeScript-only application plugins.

However, `docs/4-layer-architecture/spec/program.yaml` currently lists:

1. native kernel;
2. Tauri adapters;
3. application runtime; and
4. application plugins.

Those are two different taxonomies. The YAML promotes Tauri adapters, which
are an internal part of Layer 1, into a separate layer and omits the public
plugin API layer. Because `program.yaml` is described as executable authority,
this is a specification defect rather than harmless wording.

The program should be reconciled to the canonical model:

```yaml
target_layers:
  - id: native-kernel
  - id: application-host
  - id: plugin-api
  - id: application-plugins
```

Tauri adapters should then be represented as an internal component of the
native kernel, not as one of the four public architecture layers.

## Final interpretation

The intended outcome is physically enforceable:

- `core/backend`, `core/tauri`, and `src-tauri` contain native authority;
- `core/frontend` contains the permanent trusted application host;
- `module-api/frontend` contains public TypeScript contracts only; and
- `modules/<id>` contains TypeScript-only application plugins.

The fact that `core/` contains Layers 1 and 2 is deliberate. The Rust and host
directories still make the internal boundary explicit. Rust and direct Tauri
edges currently found under `modules/` are transitional and must disappear
before the four-layer migration is complete.
