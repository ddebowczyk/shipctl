# Phase C: Cordis static composition

## Outcome

Cordis owns application activation, service provision, and effect disposal for
the existing build-selected module set. Membership and visible behavior remain
static. This isolates lifecycle change from artifact and live-reconciliation
change.

## Why static first

The current `ShipctlModule` contract already separates declarations and an
optional activation. Adapting it to one Cordis child context lets Shipctl prove
effect ownership with current modules and tests. Loading, native extraction,
and workspace reconciliation remain unchanged.

`commands` is the first compound pilot because it is TypeScript-only, already
uses host terminal services, and has modest resource risk. Its `runtime.ts`
owns saved-command persistence policy, terminal-session tracking, start/stop,
and autostart behavior independently of `CommandsPanel.tsx`. It can therefore
prove application behavior plus optional React, not only view registration.
Ports remains the first native-provider extraction pilot.

A small headless provider/consumer fixture proves the same Cordis application
contract without React. It is a conformance fixture, not an invented public
Shipctl domain service.

## Normative semantics

- **SEM-C-001:** The TypeScript application host creates one Shipctl-owned
  Cordis root and one activation-scoped child context per plugin instance.
- **SEM-C-002:** Every provided service, controller, contribution,
  subscription, timer, worker, connection, style, lease, and background task
  is registered as an effect owned by that activation.
- **SEM-C-003:** Failed activation publishes no contribution or service.
- **SEM-C-004:** Disposal is idempotent and removes exactly the disposed
  activation's effects.
- **SEM-C-005:** Cordis implementation details do not escape the runtime
  adapter into platform, workspace, canvas, or shell APIs.
- **SEM-C-006:** The static Cordis composition produces the same accepted
  service behavior, contribution inventory, and user behavior as legacy
  composition.
- **SEM-C-007:** Plugin package import remains passive; activation starts only
  through the runtime supervisor.
- **SEM-C-008:** A valid plugin may provide and consume services and own
  reversible background effects without importing React or publishing a
  presentation contribution.

## Cordis dependency policy

- Pin the exact accepted source revision in `pnpm-lock.yaml`.
- Start from the inspected local upstream at commit
  `8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4`, subject to implementation-time
  verification.
- Depend only on public `Context`, plugin, service, and effect surfaces.
- Wrap fiber state and disposal in Shipctl types. Do not make private Cordis
  fields part of diagnostics or persisted state.
- Treat Cordis API instability as an adapter maintenance risk, not a reason to
  duplicate its lifecycle engine in Shipctl.
- Use DeepSeek Harness for composition examples, not as a source dependency.

## Work

1. Add `core/frontend/runtime/cordis` with a root factory and activation
   adapter.
2. Register the semantic services from Phase B in the root context.
3. Define a `PluginDefinition` contract that can adapt current
   `ShipctlModule` values without exposing Cordis internals to contributions.
4. Add a headless provider/consumer fixture and prove service injection,
   readiness, and disposal without a DOM.
5. Convert legacy contribution arrays and headless responsibilities to
   provisional effect registrations.
6. Add an activation coordinator outside `AppShell`.
7. Mount `commands` through Cordis, compare both its non-visual runtime behavior
   and accepted contributions, and remove its legacy activation path.
8. Move the remaining static modules through the adapter one at a time.
9. Make `AppShell` subscribe to runtime snapshots instead of calling module
   activate/deactivate functions directly.

## Property cards

### PROP-C-LIFECYCLE-001

- **Claim:** For every generated valid activation history, the runtime's live
  activation states equal an independent model after each mount, readiness,
  failure, replacement, and disposal command.
- **Shape:** state-machine.
- **Evidence:** SEM-C-001, SEM-C-003, SEM-C-004.
- **Domain:** distinct plugin instances, activation failures before and after
  effect registration, repeated disposal, and replacement. Exclude artifact
  import and native process failure.
- **Preconditions:** commands obey the model's valid identity rules; invalid
  commands are generated in a separate denial branch.
- **Oracle:** a pure map-based model with states `absent`, `preparing`, `active`,
  `failed`, and `disposed`. It does not import Cordis.
- **Failure value:** a failed plugin remains visible as active or replaces the
  old instance.
- **Tier:** pull request.
- **Initial status/test ID:** proposed / `architecture.cordis-lifecycle.property`.

### PROP-C-EFFECTS-001

- **Claim:** After every generated activation history, the multiset of live
  effects equals the model's effects for active instances and contains no
  effect owned by a failed or disposed instance.
- **Shape:** conservation.
- **Evidence:** SEM-C-002, SEM-C-003, SEM-C-004.
- **Domain:** contribution, subscription, timer, style, lease, and background
  task fixtures with synchronous and asynchronous cleanup. Exclude external
  cleanup that cannot be observed by the fixture.
- **Preconditions:** each effect exposes an independent acquisition and release
  probe.
- **Oracle:** the generated command model tracks expected owner/effect pairs;
  probes report actual pairs.
- **Failure value:** replacing a plugin leaves its old repository watcher or
  CSS active.
- **Tier:** pull request.
- **Initial status/test ID:** proposed / `architecture.cordis-effect-conservation.property`.

### PROP-C-STATIC-PARITY-001

- **Claim:** For every generated legacy module set supported by the adapter,
  Cordis composition and legacy composition publish equivalent normalized
  contribution catalogs in the same declared order.
- **Shape:** differential.
- **Evidence:** SEM-C-006.
- **Domain:** unique and conflicting contribution IDs across every current
  contribution family. Exclude runtime artifacts and live replacement.
- **Preconditions:** both compositions use the same module declarations and
  builtin host contributions.
- **Oracle:** compare normalized snapshots from separately constructed legacy
  and Cordis roots. Normalization removes activation IDs only.
- **Failure value:** moving assistants to Cordis drops its project action while
  tests for its panel still pass.
- **Tier:** pull request.
- **Initial status/test ID:** proposed / `architecture.static-cordis-parity.property`.

### PROP-C-DISPOSE-001

- **Claim:** Disposing any generated activation one or more times produces the
  same final effect and catalog state as disposing it once.
- **Shape:** idempotency.
- **Evidence:** SEM-C-004.
- **Domain:** active, failed, partially prepared, and already disposed fixture
  activations. Exclude process termination policy.
- **Preconditions:** none.
- **Oracle:** compare normalized state after one disposal with state after the
  generated repeated sequence.
- **Failure value:** a second cleanup call removes a newer activation's
  contribution because IDs were reused.
- **Tier:** pull request.
- **Initial status/test ID:** proposed / `architecture.cordis-dispose.property`.

### PROP-C-ROLE-001

- **Claim:** For every generated valid headless, presentation-only, or compound
  plugin definition, activation and disposal preserve exactly its declared
  services, effects, and optional contributions; zero React contributions are
  valid.
- **Shape:** algebraic partition and conservation.
- **Evidence:** SEM-C-002, SEM-C-003, SEM-C-004, SEM-C-008.
- **Domain:** service providers and consumers, timers, subscriptions, commands,
  and optional React contribution fixtures. Exclude artifact loading.
- **Preconditions:** required services are present unless the generated case
  explicitly tests readiness failure.
- **Oracle:** derive the expected owned entities directly from the generated
  role-independent definition, then compare it with runtime inspection before
  and after disposal.
- **Failure value:** a headless plugin is rejected because it registers no view,
  or disposing a compound plugin leaves its background controller active.
- **Tier:** pull request.
- **Initial status/test ID:** proposed / `architecture.cordis-plugin-role.property`.

### PROP-C-BOUNDARY-001

- **Claim:** Plugin imports are passive and plugin code uses only the Shipctl
  runtime contract. No Cordis implementation value or direct lifecycle
  authority escapes into a plugin.
- **Shape:** safety.
- **Evidence:** SEM-C-005, SEM-C-007.
- **Domain:** valid plugin entrypoints plus one injected Cordis import,
  top-level effect, leaked Cordis value, or direct lifecycle operation.
- **Preconditions:** each fixture is a valid ECMAScript module and the
  supervisor is not asked to activate it during the import observation.
- **Oracle:** import tripwires and an independent source graph detect effects
  and forbidden edges without executing the runtime adapter.
- **Failure value:** a plugin imports Cordis directly or activates itself while
  its package loads.
- **Tier:** pull request.
- **Initial status/test ID:** proposed / `architecture.cordis-boundary.property`.

## Exit proof

- all static built-ins have a Cordis activation identity;
- all effects exposed by current module APIs have an owner;
- a headless provider/consumer fixture activates, serves a request, and disposes
  without React or a DOM;
- commands proves one compound activation owns both its current `runtime.ts`
  responsibilities and optional UI contributions;
- `AppShell` no longer calls legacy activation functions;
- legacy and Cordis catalog snapshots are equal for characterized fixtures;
- disposal and failure properties pass;
- application behavior remains build-selected and unchanged.

## Deletion gate

Delete `activateModules*`, activation scheduling helpers, and direct lifecycle
calls only after all static modules use the Cordis coordinator. Keep legacy
contribution projection until the artifact catalog publishes the same UI
families in Phase E.
