<!-- markdownlint-disable MD013 -->

# Step 06 — Give the workspace an owner, and close its operation gaps

## Outcome

The semantic workspace already exists and is already renderer-neutral. Two
things are missing, and they are the whole of this step:

1. The workspace has **no owner** — `WorkspaceAuthority`, `WorkspaceCanvasBridge`,
   and `AcceptedWorkspaceCatalogController` are constructed by `AppShell.tsx`
   (Step 03 relocates that) and belong to nobody afterwards.
2. The document can **represent states no public operation can reach or leave**.

This step assigns ownership to a bundled workspace plugin and closes the
operation gap. It does not redesign the document.

## Delivered workspace contract

`module-api/frontend/src/protocol/workspace.ts` (352 lines) is a complete
renderer-neutral contract:

| Concern | Already contract |
| --- | --- |
| Document grammar | schema-2 `UiWorkspaceDocument`: `instances`, `root` (`WorkspaceStackNode` \| `WorkspaceSplitNode`), `floating`, `maximizedStackId` |
| View catalogue | `WorkspaceViewDefinition` with `scope`, `cardinality`, `closeBehavior`, `requiredCapabilityIds`, `placement`, and `migrationAliases` |
| Renderer indirection | `WorkspaceViewPresentationRef { loaderId, exportName }` — no React type in the contract |
| Unavailable views | `WorkspaceViewAvailability` `missing-definition` with `lastKnownViewTypeId` + `catalogRevision`; `WorkspaceResourceReference` `unavailable` variant |
| Revision safety | `WorkspaceCommandBase.expectedRevision` + `originId`; `workspace.conflict` |
| Agent inspection | `WorkspaceInspection` with opt-in `document`, plus `WorkspaceObservation` (`workspace-changed` / `catalog-reconciled`) |
| Public mutation | Workspace service v2 exposes `validate`, `plan`, atomic `apply`, compatibility `mutate`, and all semantic layout commands |
| Structured failure | 10-member `WorkspaceErrorCode` |
| Host-only catalogue | documented on `WorkspaceService`: a plugin "cannot discover, authorize, or activate other plugins" |

The bundled `shipctl.workspace` plugin owns this contract, its authority,
accepted-catalog controller, plugin-data persistence, and renderer-neutral
bridge lifecycle. The surrounding shell only activates that plugin and consumes
its snapshots and diagnostics.

## Gap 1 — resolved reachability

`WorkspaceCommand` now exposes `open`, `close`, `focus`, `select`, `move`,
`split`, `rename`, `resize-split`, `float`, `update-floating`, `dock`,
`maximize`, `restore`, `reset`, and ordered `apply`. Every retained mutable
workspace field now has a public reachability and leavability path:

| Representable in the document | Reachable / leavable by a public command? |
| --- | --- |
| `WorkspaceSplitNode.firstShare: number` | `resize-split` sets a ratio; a later resize leaves it. |
| `floating: WorkspaceFloatingStack[]` with `x`, `y`, `width`, `height` | `float` creates, `update-floating` changes bounds, and `dock` removes the floating placement. |
| `maximizedStackId: string \| null` | `maximize` sets it and `restore` clears it. |
| `WorkspaceViewInstance.label` | `rename` sets or clears it. |
| v1 `profileId` and `stateRef` | removed from schema 2; legacy parsing normalizes them away. |

This is proof obligation 7 from Step 00, and it is a correctness problem, not a
feature wish-list: a renderer that offers drag-resize, float, or maximize today
must either mutate outside the document or silently lose the change on reload.

The public-operation architecture test checks these paths through a headless
semantic service. Invalid operations, including a failed later batch step, leave
the canonical document and revision unchanged.

### Owner decision — 2026-08-19: view-local state

**Owner:** Dariusz Debowczyk. **Selected policy:** the shared workspace stores
only layout and open-view state. Each view-owning plugin stores its own
view-local data (for example filters and drafts) in its activation-derived
plugin-data namespace.

The workspace contract therefore removes `WorkspaceViewStatePolicy` and
`WorkspaceViewInstance.stateRef`. Existing document-schema-v1 values normalize
one-way by dropping the placeholder `stateRef`: it never had an owner-defined
record key, schema, update operation, or read path, so it cannot be migrated
safely into an arbitrary plugin namespace. A view that needs durable local
state must define and migrate a record in its own namespace.

The implementation maps every remaining mutable document field as follows:

| Field | Public semantic operation |
| --- | --- |
| split `firstShare` | `resize-split` |
| floating stack identity and bounds | `float`, `update-floating`, and `dock` |
| `maximizedStackId` | `maximize` and `restore` |
| instance `label` | `rename` |
| schema-1 `profileId` and `stateRef` | removed during one-way normalization |

Document/workspace identities, schema versions, owner metadata, lifecycle, and
availability remain authority-managed invariants. `open`, `close`, `focus`,
`move`, `split`, `reset`, and accepted-catalog reconciliation create, replace,
or remove those facts through the same validated reducer.

## Gap 2 — resolved plan/apply transaction

Workspace service v2 exposes validation, planning, and an ordered `apply`
command. The complete batch is parsed and reduced from one starting document
before its one compare-and-save; a failed step advances neither document nor
revision. `mutateWorkspace` remains an explicit compatibility alias to one
`apply` command.

## Gap 3 — ownership and commit scope

The workspace becomes a bundled trusted plugin with its own module identity.
That identity is what gives it a `plugin-data` namespace (Step 05, Option B) and
what makes it upgradeable and inspectable through the same runtime as every
other plugin.

**Resolved 2026-08-19 — owner Dariusz Debowczyk selected post-commit,
diagnostic-only reconciliation.** The authoritative Phase G record states that
activation succeeds when its native route and declared-schedule transaction
commits and its accepted family is published. Catalogue reconciliation follows
that commit; failure must surface a structured workspace diagnostic and must not
unpublish or roll back the accepted family, its routes, schedules, or services.
An observer can therefore see an active accepted family alongside the last
successfully reconciled workspace document (or bootstrap state) and its
diagnostic. Later accepted catalogues may retry reconciliation.

`workspace plan`/`apply` batch atomicity applies only to a single
workspace-document mutation. It cannot make activation and reconciliation one
distributed transaction. Step 11 must not add a property that assumes the
stronger guarantee.

## Catalogue reconciliation invariants

These already have an implementation (`AcceptedWorkspaceCatalogController`);
this step makes them contract-level invariants of the owning plugin:

- data for a temporarily unavailable view is retained, not discarded;
- an instance id is never repurposed to a different plugin — `ownerModuleId` and
  `ownerActivationId` on the instance already make this checkable;
- `missing-definition` carries `lastKnownViewTypeId` and the `catalogRevision`
  at which it went missing, so recovery is diagnosable;
- `migrationAliases` are the only mechanism by which a renamed view type
  reclaims its instances;
- focus and the layout tree remain valid after any reconciliation.

## Agent-operable surface

`WorkspaceInspection`, `validateWorkspace`, `planWorkspace`, `applyWorkspace`,
compatibility `mutateWorkspace`, and `observeWorkspace` are public. There are no
profile operations because schema-2 workspace documents do not model profiles.
The agent surface reaches the workspace through the capability-call and
operations plane; it does not add a bespoke workspace CLI path here.

Responses stay machine-readable first, with human rendering only at the CLI
edge. The first delivery may require reload after apply; semantic inspection,
validation, and revision-safe persistence may not be deferred.

## Delivered work

1. Recorded layout-and-open-views-only ownership; schema-1 `stateRef` and
   `profileId` normalize away.
2. Added the atomic batch form and rendererless validate/plan/apply service.
3. Activated authority, validation, catalog controller, plugin-data persistence,
   and bridge under bundled `shipctl.workspace` ownership.
4. Moved the canonical record into that plugin's namespace, proved one-way
   legacy import/replay/conflict behavior, and removed the native store/commands.
5. Added headless public-operation and catalog-reconciliation evidence before
   renderer controls can emit the new semantic commands.

## Validation and exit criteria

- The workspace service activates and mutates in a headless `node --test`
  runtime with no DOM and no renderer.
- Every field of `UiWorkspaceDocument` is reachable and leavable through a
  public command, or has been removed. This is a checked enumeration, not a
  claim.
- No React component and no Layman object mutates the canonical document; the
  `canvas-persistence-import` rule (Step 01) holds.
- A stale `expectedRevision` yields `workspace.conflict` with the document and
  revision unchanged.
- A rejected candidate graph leaves a valid tree and a diagnosable
  `missing-definition` instance rather than a broken canvas — consistent with
  the recorded post-commit reconciliation decision.
- A batch apply either lands entirely or advances no revision (if Option 1).
- A fixture creates, inspects, validates, and resets a workspace using only the
  public TypeScript API.
- Renderer selection no longer comes from Rust (Step 05 dependency).
