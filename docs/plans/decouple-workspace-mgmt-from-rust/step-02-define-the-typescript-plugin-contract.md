<!-- markdownlint-disable MD013 -->

# Step 02 — Dissolve `ShipctlModule` and `ModuleHostServices`

## Outcome

The public plugin contract already exists. What remains is to remove its two
host-shaped remnants:

- `ShipctlModule` (`module-api/frontend/src/module/module.ts:42-71`) — one static
  object carrying 15 unrelated contribution families plus lifecycle hooks;
- `ModuleHostServices` (`module-api/frontend/src/host/services.ts:88-97`) — a
  capability bag handed to every plugin regardless of what it declared.

Replace both with contributions registered through the activation context that
already exists, and with declared semantic services that already exist. This is
a **subtraction**, not a new framework layer.

## What already exists — build on it, do not restate it

| Concept the earlier draft proposed | Already implemented as |
| --- | --- |
| Plugin identity, role, provenance, required grants | `ShipctlPluginDefinition` + manifest `application` block (`module-api/frontend/src/module/plugins.ts:11-18`, `modules/*/artifact/module.template.json`) |
| Plugin context resolving declared services | `ModuleActivationContext` (`module-api/frontend/src/protocol/semanticServices.ts:64-69`): `identity`, service access, `disposed`, `own()`. Its host-side provider context currently lacks the effective admitted grants needed to bind services dynamically. |
| Effect scope with mandatory, observable disposal | `ModuleActivationContext.own(cleanup, backgroundEffectId)` + `PluginEffectInspection` |
| Service contract with stable id and version | `defineSemanticService` / `SemanticServiceReference` |
| Artifact manifest for admission and offline discovery | manifest schema v2 `application` block, validated natively and re-checked at load |
| Manifest↔runtime consistency validation | `core/frontend/host/moduleArtifactLoader.ts:300-349` |
| Structured per-plugin diagnostics | `PluginRuntimeInspection`, `publishFrontendRuntimeSnapshot` |

A step that re-proposes any row above will produce a parallel API. The genuinely
missing pieces are a **typed contribution registry reached through the
activation context** and a private admission binding for host-side service
providers. Everything else is already contract.

## Carry admission into host bindings without exposing a second API

The loader already verifies the artifact's admitted `requestedGrants` against
the runtime declaration, but the effective set is discarded before semantic
service providers bind. `SemanticServiceProviderContext` currently contains
only `activation`, `active`, and `own()`. As a result,
`createPluginDataServiceProvider` reconstructs authority with a hard-coded
`DEFAULT_AUTHORIZE` table for two module ids, keys, and schema version.

That is not compatible with a dynamically installed plugin that needs its own
configuration. It is also not a reason to add an authorization service. Carry a
private, immutable **accepted-admission binding** alongside the existing
host-side provider context: module identity, effective admitted grants, and the
accepted artifact identity. It is constructed from the already-validated
candidate and published/disposed with that candidate. It is not exposed through
the public `ModuleActivationContext`, so a plugin cannot forge or inspect other
plugins' authority.

For `shipctl.plugin-data@1`, authorization after this change is deliberately
small: the activation is active, its effective grants include the requested
read/write/migrate verb, and the native request is bound to that activation's
own `ownerModuleId`. Valid keys, scopes, and positive schema versions are
plugin-owned data grammar; they are not a host module-id/key allowlist. If a
future resource needs narrower policy, it is declared in the admitted artifact
contract and checked from this same binding, never through another global table.

The native `HOST_SUPPORTED_ARTIFACT_GRANTS` vocabulary remains a stable kernel
API: adding a new privileged resource may require Rust. Using the existing
`plugin-data.*` grants for a new plugin, key, schema, or configuration namespace
does not.

There is one vocabulary mismatch to repair before relying on migrations:
`PluginDataGrant` and the provider expose `plugin-data.migrate`, but
`HOST_SUPPORTED_ARTIFACT_GRANTS` currently admits only `.read` and `.write`.
Keep `.migrate` as a distinct least-privilege grant, add it once to the native
supported vocabulary and its admission test, and then keep the vocabulary
stable. This is a kernel API alignment, not a per-plugin policy exception.

## The two things to remove

### `ShipctlModule`

Today a plugin declares contributions by *shape*: fifteen optional array
properties on a frozen object. Consequences:

- every plugin depends on the union of all contribution families, so a headless
  plugin still imports the presentation vocabulary;
- contribution identity is only checkable by walking the object
  (`core/frontend/runtime/cordis/staticPluginRuntime.ts:79-109`);
- adding a family means editing the shared interface, the walker, the role
  inference (`hasPresentation`/`hasHeadlessBehavior`, lines 43-65), *and* the
  Rust enum (see below);
- role is *inferred* from which properties are populated rather than declared
  and checked.

Target: contributions are registered from the activation entrypoint against
family-scoped registries obtained from the context. Registration returns a lease
owned by the activation, so disposal is uniform with every other effect. Role
becomes a declared, validated fact rather than an inference.

### `ModuleHostServices`

`MODULE_HOST_SERVICES` (`core/frontend/host/moduleHostServices.ts:60-108`) is a
single frozen bag reaching directly into five host Zustand stores. It is passed
to `notifyModulesProjectOpened`, `notifyModulesBeforeShutdown`, `addRepo`, and
into `CanvasPorts`. Its cost is measurable: **5 of the 7 entries in
`CORE_DEEP_IMPORT_EXCEPTIONS`** exist only to permit its store imports.

Each of its eight members must be classified, and the classification is the
deliverable:

| Member | Likely disposition |
| --- | --- |
| `panels` | superseded by workspace view contributions (Step 06) |
| `terminalSessions`, `terminalPresentation` | already duplicated by `shipctl.terminal-sessions@1` / `shipctl.semantic-terminals@1`; delete the bag path |
| `settings` | project settings become a plugin configuration namespace (Step 05) |
| `skills` | already `shipctl.skill-installation@1`; the bag member is a legacy alias |
| `appearance` | needs a declared semantic service or a presentation-only context field; it is a read-only projection, not authority |
| `notices` | becomes a structured diagnostics/notice sink on the context (Step 03) |
| `externalLinks` | belongs to a desktop port with a grant (Step 04) |

The classification must be written down per member with its target, because the
temptation under time pressure is to keep "just one" convenience member — which
is how a bag regrows.

## Interim constraint: the taxonomy is defined twice

`PluginContributionFamily` (`module-api/frontend/src/module/plugins.ts:29-44`)
and `RuntimeContributionFamily` (`core/backend/src/module_control/artifact.rs:509-525`)
are the same 15 members, maintained by hand in two languages. Native admission
rejects an artifact whose contribution family it does not recognise
(`ARTIFACT_CONTRIBUTION_INCOMPATIBLE`).

Therefore **this step must not change the contribution taxonomy**. It changes
only *how* existing contributions are registered: context registries replace
object properties. Step 09 removes the Rust-owned semantic taxonomy before a
new family is introduced.

This is a sequencing restriction, not an exception to the feature-delivery
invariant. Ordinary new capabilities must compose the stable extension
primitives already provided by the host — services, operations, effects,
schedules, messages, configuration/state, workspace views, and navigation/menu
contributions. A feature must not invent a global contribution family merely to
avoid using those primitives. If a genuinely new host primitive is needed, it
is an explicit plugin-contract evolution; it must still be TypeScript-owned and
must not introduce a per-feature Rust admission rule.

## Contributions: facts in the manifest, behavior at activation

This split already holds and must be preserved: the manifest declares stable
contribution ids, families, and schema versions; the entrypoint registers the
executable behavior; the loader proves they match. The new registries must keep
`collectPluginArtifactDeclarations` able to derive the same declaration set from
a live activation, or the consistency check silently becomes a no-op.

React view bodies remain a peer dependency of the presentation surface. They
must not receive the application runtime, a Tauri object, or a Layman instance.

## Compatibility strategy

`adaptShipctlModule` (`core/frontend/runtime/cordis/staticPluginRuntime.ts:75-77`)
is the existing legacy adapter. Keep it; do not build a second one.

It is **not private today**: it is re-exported from
`core/frontend/runtime/cordis/index.ts:4` and `core/frontend/runtime/index.ts:37`.
Its only application caller is `LiveModuleSupervisor` (`liveModuleSupervisor.ts:220`),
whose `staticModules` input is `ENABLED_MODULES`, i.e. `[]`. Narrowing it to
module-private is therefore free when Step 01 deletes the empty static path;
its final deletion remains Step 08 after the ninth artifact conversion.

The adapter must:

- stay private to `core/frontend/runtime/cordis`;
- never be re-exported from `@shipctl/module-api`;
- reject any legacy contribution family that has no explicit mapping, rather
  than passing it through untyped;
- carry a per-artifact migration matrix in the step's task record;
- be deleted with `ShipctlModule`, `ModuleHost`, and `inferShipctlPluginRole`
  in one commit when the last artifact is converted (Step 08).

## Refactoring actions

1. Write the eight-member `ModuleHostServices` disposition table; get it
   reviewed before writing code. It is the step's real design decision.
2. Add family-scoped contribution registries reachable from
   `ModuleActivationContext`, returning activation-owned leases.
3. Carry the loader's accepted admission into the **private** host-side
   provider-binding context. Replace `DEFAULT_AUTHORIZE` and the matching fake
   default policy table with grant checks from that context; do not add grants
   or raw authority to the public plugin context.
4. Make `role` a declared field validated against registered contributions;
   retain `inferShipctlPluginRole` only for the legacy adapter.
5. Convert one headless artifact first — `commands` is the recorded compound
   pilot (`docs/4-layer-architecture/20-...md:217-228`); a smaller headless
   fixture proves React is optional with less blast radius.
6. Convert one presentation artifact second — `ports` (one navigation item, one
   global surface, one required service) is the smallest real case.
7. Remove `ModuleHostServices` members one at a time, deleting the matching
   `CORE_DEEP_IMPORT_EXCEPTIONS` entry in the same commit.
8. Keep `ShipctlModule` compiling until Step 08 finishes; add no new field to it.

## Validation and exit criteria

- A plugin activates in a `node --test` lane with no DOM and no `@tauri-apps/*`
  import in its closure.
- An undeclared service request and an ungranted native-backed service request
  fail with a structured, attributable error naming plugin, service, and grant.
- A fixture artifact with admitted `plugin-data.read` / `.write` / `.migrate`
  reaches only records whose owner is its activation's module id. The same
  fixture without a grant, or after disposal, cannot read, write, or migrate and
  leaves no record, contribution, route, schedule, or effect behind.
- Candidate activation stays transactional: no contribution, route, schedule, or
  effect is published when validation fails. Cite `PROP-F-ATOMIC-001`; extend it
  only if registries introduce a new publication point.
- `collectPluginArtifactDeclarations` still derives the manifest declaration set
  from a live activation, and the loader mismatch test still fails on a
  deliberate divergence.
- Each removed `ModuleHostServices` member deletes its checker exception in the
  same commit; the `moduleHostServices.ts` entries in
  `CORE_DEEP_IMPORT_EXCEPTIONS` reach zero.
- `@shipctl/module-api` declaration output contains no Cordis and no Tauri type.
- The legacy adapter has a written per-artifact migration matrix and a deletion
  commit planned in Step 08.
