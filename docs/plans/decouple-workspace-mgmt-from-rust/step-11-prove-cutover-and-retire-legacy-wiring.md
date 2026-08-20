<!-- markdownlint-disable MD013 -->

# Step 11 — Add the missing properties and write the deletion gates

## Outcome

The evidence harness exists. `docs/4-layer-architecture/spec/phases/*.yaml`
already carries **48 property records** across phases A–G, with fresh and replay
campaigns driven by `ops/architecture/justfile`
(`validate`, `boundaries`, `evidence`, `test`).

This step does two things and nothing else:

1. adds the small number of properties this plan genuinely introduces;
2. converts the plan's completion checklist into `deletion_gates` entries with
   named artifacts, so every compatibility path has a removal condition.

**It creates no second property format, harness, or spec authority.**

## Most of the draft's property table already exists

| Draft property family | Existing record(s) | Verdict |
| --- | --- | --- |
| Workspace structural validity | `PROP-G-WORKSPACE-001`, `PROP-G-LAYOUT-001` | covered |
| Renderer projection | `PROP-G-RENDERER-001`, `PROP-G-LAYMAN-MOVE-001`, `PROP-G-LAYMAN-SPLIT-001` | covered for move/split |
| Candidate graph transaction | `PROP-F-ATOMIC-001`, `PROP-F-SCHEDULE-ATOMIC-001`, `PROP-F-REVISION-001` | covered |
| Manifest/runtime consistency | `PROP-E-MANIFEST-RUNTIME-001`, `SEM-E-003` | covered |
| Deactivation / recovery | `PROP-F-RECONCILE-001`, `PROP-F-CONTINUITY-001`, `PROP-G-CONTRIBUTION-CLEANUP-001`, `PROP-G-ABSENCE-001` | covered |
| Restart continuity | `PROP-F-RESTART-001` | covered |
| Runtime inspection | `PROP-F-INSPECTION-001` | covered |
| Import boundary | `PROP-A-IMPORT-001`, `PROP-A-COMPOSITION-001`, `PROP-C-BOUNDARY-001` | covered |
| Headless operation | `PROP-E-HEADLESS-001` | **partially** — see new properties |
| Grant enforcement | `PROP-E-EXTERNALS-001`, `PROP-E-TAMPER-001`, `SEM-E-008` | **partially** — admission is covered; runtime denial is not |

Restating a covered family as new work produces a duplicate oracle and a second
place to keep in sync. Cite the id instead.

## The properties this plan actually adds

Each belongs in a new phase record (or an amendment to `phase-g` / `phase-h`),
in the existing `phase/v1` schema, with the same `id` / generator / oracle shape.

| Proposed id | Property | Introduced by | Oracle |
| --- | --- | --- | --- |
| `PROP-G-WORKSPACE-OPERATIONS-001` | The rendererless public workspace service reaches every retained mutable layout/open-view field, validates and plans without writing, and commits a complete apply batch once or not at all | Step 06 | use public service operations; reject a later batch step and assert the document/revision are byte-identical to the pre-apply state. `profileId` and `stateRef` are removed during v1 normalization rather than treated as mutable fields. |
| `PROP-*-CONFIG-MIGRATE-001` | Configuration migration is idempotent, atomic, and never commits an invalid document | Step 05 | replay the same `migrationId`; assert `replayed: true`, no revision advance, and identical records. Feed an invalid legacy value; assert nothing is written. |
| `PROP-*-CONFIG-RESOLVE-001` | Configuration resolution is deterministic and identical in UI and headless | Steps 05, 10 | same fixture → byte-equal resolved result in both runtimes |
| `PROP-*-PARITY-001` | Compatible agent operations produce equivalent semantic results and diagnostics online and offline | Step 10 | shared fixture; diff structured responses excluding an explicit live-only allow-list. **The allow-list is part of the property**, not an escape hatch. |
| `PROP-*-GRANT-DENIAL-001` | A withheld grant is unreachable at runtime, in UI and headless, and fails before any contribution/route/schedule/effect is published | Steps 04, 08 | activate a plugin declaring a grant the host withholds; assert structured failure naming plugin, grant, and phase, and that no publication occurred |
| `PROP-*-PLUGIN-DATA-ISOLATION-001` | An arbitrary admitted plugin can read/write/migrate only its activation-derived namespace; a denied, peer, or disposed activation cannot create or alter its records | Steps 02, 04, 05 | generate two module ids, grant sets, scopes, keys, revisions, and a disposal point; assert owner isolation, zero writes on denial, and no product module-id/key table in the provider or fake policy |
| `PROP-*-PERSISTENCE-DEGRADED-001` | With the durable port unavailable, workspace writes fail loudly and no write lands in memory | Step 03 | remove the persistence port; assert the accepted snapshot reports the degraded mode and every write returns a structured error |
| `PROP-*-POST-PACKAGE-PLUGIN-DEPLOY-001` | A plugin artifact created after a host package is built installs and activates after restart without changing the host package | Step 09 | build/package host, record native and host-frontend hashes, pack an independent fixture artifact outside bundled seeding, install/enable through the public registry, restart, and assert inspection plus one operation/contribution/configuration write; unchanged hashes and no build/release action are required |

The 2026-08-19 owner decision in Phase G fixes the activation boundary:
workspace catalogue reconciliation is post-commit and diagnostic-only. The
batch property above proves one workspace-document transaction only; it must not
assert that a reconciliation failure rolls back, unpublishes, or otherwise
changes an already accepted runtime family.

`PROP-*-PERSISTENCE-DEGRADED-001` remains a high-value addition because it
closes the pre-extraction data-loss path without silently falling back to memory.

Failures shrink into a saved fixture — document, manifest graph, operation
sequence, runtime revision — reproducible by a developer or an agent.

## Test layers

Unchanged in principle; stated here so no layer is skipped:

1. property and unit tests for pure workspace/configuration/runtime resolution;
2. contract tests for every semantic port against both the fake
   (`module-api/frontend/src/testing/*`) and the real adapter;
3. Rust integration tests for resource behavior — PTY/process, credentials,
   filesystem, notifications, window intent, durable CAS;
4. artifact admission tests with bundled and deliberately malformed fixtures;
5. headless-vs-UI parity;
6. end-to-end smoke for a compatibility workspace and a multi-plugin workspace.

Browser snapshots are never the sole oracle. Semantic documents and structured
runtime events are the assertion surface; visual tests then confirm the renderer
exposes them faithfully.

## Diagnostics

`PROP-F-INSPECTION-001` already requires runtime inspection. What this plan adds
is the rule from Step 03: **a failure must not exist only as a toast.**

The structured diagnostics stream carries retention and correlation ids; a
notice references a diagnostic event id, plugin id, runtime revision,
capability/operation, phase, and safe causal error. The inspection surface
exposes accepted/rejected revisions with reason, manifests and effective grants,
the active contribution catalogue and workspace revision, routes/effects per
accepted plugin, recent structured errors with recovery actions, and
configuration provenance plus pending migration state.

## Rollout

1. Land the boundary rules and dead-code deletions (Step 01) — no behavior
   change.
2. Move runtime construction out of React with the in-memory test bootstrap as
   the exit criterion (Step 03).
3. Read configuration through TypeScript with the native file as read-only
   import input (Step 05).
4. Convert the nine artifact entrypoints one at a time (Step 08).
5. Dissolve the compatibility canvas region by region (Step 07).
6. Ship CLI inspect/validate, then plan/apply once the transaction properties
   hold (Step 10).
7. Default to the new paths only after diagnostics show successful activation
   and migration and parity passes.
8. Execute the deletions below, each as a reviewed commit.

Every rollout state has a rollback: return to the last accepted runtime revision
and/or a backed-up configuration record. Rollback must never overwrite a newer
user modification — which is why every write is revision-checked.

## Deletion gates

The draft's "completion gates" were prose. They belong in `spec/` as
`deletion_gates` entries under `phase-h` (or a new phase), each naming its
artifacts and its authorizing proof. Proposed entries:

| Gate | Removes | Authorized by |
| --- | --- | --- |
| `DELETE-STATIC-COMPOSITION` | `enabledModules.ts`, `LiveModuleSupervisor.staticModules` (option/field/uses/filter/merge), `adaptShipctlModule` re-exports, `COMPOSITION_FILES` exception | Step 01; already-dead, no proof needed beyond the checker |
| `DELETE-RAW-LAYOUT` | `state/workspace_layout.rs`, `load_/save_workspace_layout`, `WorkspaceLayoutStore`, `paths.workspace_layouts`, its tests | Step 01 + a written statement that no rollback consumes it |
| `DELETE-HOST-SERVICES` | `ModuleHostServices`, `MODULE_HOST_SERVICES`, the 5 `CORE_DEEP_IMPORT_EXCEPTIONS` entries that exist for it | Step 02; proof is the exception count reaching zero |
| `DELETE-STATIC-PLUGIN-DATA-AUTHORIZATION` | `DEFAULT_AUTHORIZE` in `platform/pluginData.ts` and the mirrored built-in `DEFAULT_POLICIES` test fixture | Steps 02, 04, 05; proof is `PROP-*-PLUGIN-DATA-ISOLATION-001` plus an admitted external fixture |
| `DELETE-NATIVE-PLUGIN-SEMANTICS` | `RuntimeContributionFamily` and all native product-semantic contribution/service compatibility validation | Step 09; proof is `PROP-*-POST-PACKAGE-PLUGIN-DEPLOY-001` plus malformed-artifact rejection by the TypeScript runtime before publication |
| `DELETE-SHIPCTL-MODULE` | `ShipctlModule`, `ModuleHost`, `inferShipctlPluginRole`, `adaptShipctlModule`, the contribution walker (`staticPluginRuntime.ts:79-109`) | Step 08; proof is nine converted entrypoints plus the declaration-equality test |
| `DELETE-NATIVE-UI-CONFIG` | `CanvasAdapter`, `UiSettings`, `editor`/`keybindings`/`terminal`/`sidebar` config structs, `get_canvas_adapter`, the `platform/tauri.ts` settings members | Step 05; proof is `PROP-*-CONFIG-MIGRATE-001` plus a clean `rg CanvasAdapter` |
| `DELETE-PLATFORM-FACADE` | `core/frontend/platform/tauri.ts` | Step 04; proof is that every member has a capability-named home |
| `DELETE-CLI-OFFLINE-POLICY` | `cli/src/offline_modules.rs` incl. `static_builtin_inspection` | Step 10; proof is `PROP-*-PARITY-001` |
| `DELETE-LEGACY-CANVAS` | `canvas/legacy/*`, `CURRENT_CANVAS_COMPATIBILITY_VIEW_TYPE_ID`, `CanvasModel`/`CanvasActions`/`CanvasPorts`, the two legacy canvas test files | Step 07 + **the product decision required by `phase-h.yaml:21`, which does not yet exist** |
| `DELETE-NATIVE-VENDOR-POLICY` | the `usage_sources` vendor arrays/enum/match arms and `providers.rs` implementations; `AssistantProvider` divergence | Step 09; proof is a fixture provider added from a plugin, end to end |

`DELETE-LEGACY-CANVAS` is the only gate blocked on a decision rather than on
work. It must not be silently absorbed into `DELETE-H-COMPATIBILITY`, which
already carves it out with the same condition.

## Exit criteria for the plan as a whole

- The TypeScript runtime is the one composition root for UI and headless
  operation; no second facade exists.
- All nine modules are direct artifacts on the public plugin contract.
- Workspace, frame/menu/navigation policy, and configuration are TypeScript-owned
  and agent-operable.
- Native code offers only documented resource/durability providers plus Tauri
  translation; no product proper noun remains in `core/backend` or `core/tauri`.
- A TypeScript Cordis plugin built and installed after the Shipctl host package
  exists activates after restart without recompiling, rebundling, re-signing, or
  re-releasing Shipctl, provided it uses existing published ports and grants.
- Plugin packages contain no raw Tauri use, Cordis internals, or private host
  imports.
- An admitted new plugin can own and migrate its configuration namespace without
  a Rust source change, while a peer, denied, or disposed plugin cannot touch it.
- Exactly one durable-record authority exists, or the second has a written
  bootstrap-ordering justification.
- No production writer persists renderer snapshots as workspace state.
- Invalid candidate graphs, configurations, and layout operations leave the
  prior accepted state intact.
- The lean CLI inspects and validates the same semantics as the app, online and
  offline.
- Every gate above is either executed or has a named blocking condition.
- Static, property, contract, integration, package, and smoke checks cover the
  invariants above, and `ops/architecture` replay campaigns pass.

At that point Layman is genuinely valuable: one replaceable renderer for a
user-configurable, plugin-composed workspace, rather than an embedded static
layout library.
