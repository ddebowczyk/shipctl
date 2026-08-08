# Phase 6 — current module migration

## Outcome

Move every current feature module through the same artifact, supervisor,
capability, lifecycle, diagnostic, and verification path. Remove static module
composition only after the complete inventory passes independently.

## Common migration task

Each module migration is one independently mergeable task with this contract:

1. Package its frontend as immutable ESM with a runtime manifest.
2. Declare every contribution, capability grant, config field, and resource kind.
3. Replace direct Tauri access with instance-bound mediated ports.
4. Return all listeners, timers, channels, jobs, styles, and registrations to
   its `ActivationScope`.
5. Add module-specific diagnostic probes only for domain facts that the host
   cannot authoritatively observe.
6. Add success, failure, disable, re-enable, update, and cleanup fixtures.
7. Run the generic lifecycle matrix plus the module's characterization tests.
8. Prove absence from public catalogs after disable and remove.

A task is not complete if the module still relies on `ENABLED_MODULES`, a
stable import URL, global owner broadcasts, direct `@tauri-apps/api` access, or
untracked side effects.

## Migration order

The order is derived from dependency and lifecycle risk, not feature priority:

1. `fixture` proves the contract; `commands` proves a frontend-only capability.
2. `todos`, `ports`, and `skills` prove ordinary invokes, settings, and project
   context through mediated ports.
3. `usage` proves subscriptions, scheduled work, persistence, and teardown;
   `git` proves a broad invoke surface, providers, and project lifecycle.
4. `assistants` proves channels, shutdown hooks, terminal ownership, and drain.

The eight feature modules in scope are `assistants`, `commands`, `fixture`,
`git`, `ports`, `skills`, `todos`, and `usage`. `modules/api` is the stable
host/module contract, not a removable feature.

## Native adapter treatment

Existing Rust module crates cannot be dynamically unloaded from the Tauri
binary. During migration, expose their stable mechanisms as host-registered
capability adapters behind mediated ports. The crates may remain with their
owning modules, but their registration is restart-bound. The runtime module owns
behavior and contributions; a dormant compiled adapter owns no public feature
by itself.

Consequences are explicit:

- removing a runtime module physically removes its artifact and public behavior;
- dormant adapter bytes remain until a Shipctl application update;
- adding frontend behavior that uses catalogued host capabilities is live;
- adding a new native command/plugin or changing its registration is
  restart-required; and
- future worker/WASM drivers may add isolated backend behavior without changing
  the registry or CLI contract.

## Diagnostic and verification mechanism

Maintain a generated conformance matrix keyed by module and artifact digest. It
records:

- manifest and capability-catalog validation;
- runtime kind and lifecycle classification;
- declared versus observed contributions;
- requested, effective, and denied grants;
- handle and resource inventories before activation, while active, while
  draining, and after disposal;
- configuration schema/apply results; and
- generic and module-specific test evidence.

The matrix is generated from real `inspect`, `diagnose`, and `verify` responses.
It must not be a hand-maintained checklist that can drift from runtime truth.

## Exit proof

- Each of the eight modules can be independently enabled, inspected, diagnosed,
  verified, reconfigured where its schema permits, disabled, and re-enabled.
- Each module can update from A to B and roll back without a webview reload.
- Removing one module leaves all unrelated module observations unchanged.
- Direct Tauri imports and undeclared capability uses fail modularity checks.
- Static `ENABLED_MODULES` composition and module-scope shell catalog captures
  are deleted only after the generated matrix is complete.
- Profiles and plug-out checks still prove removable frontend packaging.
- Existing module characterization tests and repository gates remain green.

## Primary implementation areas

- `modules/<name>/module.yaml`, `frontend/`, and `backend/` for each feature;
- `modules/api/` for public contracts and generated capability identifiers;
- `core/frontend/host/` for temporary compatibility removal;
- `src-tauri/src/modules/` for native adapter boundary cleanup; and
- `ops/modularity/` plus `ops/module-control/` for generated conformance.
