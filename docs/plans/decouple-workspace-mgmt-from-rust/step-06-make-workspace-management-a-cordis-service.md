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

## What already exists — do not restate it as work

`module-api/frontend/src/protocol/workspace.ts` (352 lines) is a complete
renderer-neutral contract:

| Concern | Already contract |
| --- | --- |
| Document grammar | `UiWorkspaceDocument`: `instances`, `root` (`WorkspaceStackNode` \| `WorkspaceSplitNode`), `floating`, `maximizedStackId`, `profileId` |
| View catalogue | `WorkspaceViewDefinition` with `scope`, `cardinality`, `closeBehavior`, `requiredCapabilityIds`, `placement`, `state`, `migrationAliases` |
| Renderer indirection | `WorkspaceViewPresentationRef { loaderId, exportName }` — no React type in the contract |
| Unavailable views | `WorkspaceViewAvailability` `missing-definition` with `lastKnownViewTypeId` + `catalogRevision`; `WorkspaceResourceReference` `unavailable` variant |
| Revision safety | `WorkspaceCommandBase.expectedRevision` + `originId`; `workspace.conflict` |
| Agent inspection | `WorkspaceInspection` with opt-in `document`, plus `WorkspaceObservation` (`workspace-changed` / `catalog-reconciled`) |
| Structured failure | 10-member `WorkspaceErrorCode` |
| Host-only catalogue | documented on `WorkspaceService`: a plugin "cannot discover, authorize, or activate other plugins" |

The earlier draft's "reuse the existing semantic core" section listed these as
if they were a starting point to be evolved. They are shipped contract. What
follows is only what is genuinely absent.

## Gap 1 — representable but unreachable states

`WorkspaceCommand` has exactly seven members: `open`, `close`, `focus`,
`select`, `move`, `split`, `reset`. Compare against what the document can hold:

| Representable in the document | Reachable / leavable by a public command? |
| --- | --- |
| `WorkspaceSplitNode.firstShare: number` | **No.** Set implicitly at `split`; no resize command exists. Every non-default ratio is unreachable. |
| `floating: WorkspaceFloatingStack[]` with `x`, `y`, `width`, `height` | **No.** No float, move-float, resize-float, or dock command exists. A floating stack cannot be created or dismissed. |
| `maximizedStackId: string \| null` | **No.** No maximize or restore command exists. |
| `profileId` | **Partially.** `reset` names a `profileId`, but no command creates, switches, or deletes a profile. |
| `WorkspaceViewInstance.label` | **No.** Set at `open`; no rename. |
| `WorkspaceViewInstance.stateRef` + `WorkspaceViewStatePolicy {kind:"json"}` | **No.** Set at `open`; no update command, so declared view state is write-once. This is the most consequential of the five — decide whether view state belongs in the workspace document at all, or in the view's own plugin-data namespace. |

This is proof obligation 7 from Step 00, and it is a correctness problem, not a
feature wish-list: a renderer that offers drag-resize, float, or maximize today
must either mutate outside the document or silently lose the change on reload.

Required work: for each row, either add the semantic operation or remove the
field from the document. Do not add operations for fields the product does not
want. A field with no operation is a lie in the schema.

Each new operation needs: precondition, deterministic outcome, revision
behavior, failure code from the existing `WorkspaceErrorCode` union, and a
property test. An operation that would orphan an instance, produce an invalid
tree, or target an unavailable definition must fail with the document unchanged.

## Gap 2 — no plan/apply transaction

`mutateWorkspace` accepts **one command** per call, each advancing the revision.
An agent-facing `plan`/`apply` over N commands is therefore not atomic today:
a failure at command 3 of 5 leaves a half-applied document at revision +2.

Two admissible resolutions:

1. Add a batch command carrying an ordered command list, one `expectedRevision`,
   and all-or-nothing semantics — validated against the reducer before any
   revision advances.
2. Restrict agent apply to single commands and state that multi-step layout
   changes are not transactional.

Option 1 is required if `workspace plan`/`apply` is to mean anything. It is a
contract change to `shipctl.workspace@1`; version it accordingly.

## Gap 3 — ownership and commit scope

The workspace becomes a bundled trusted plugin with its own module identity.
That identity is what gives it a `plugin-data` namespace (Step 05, Option B) and
what makes it upgradeable and inspectable through the same runtime as every
other plugin.

**Unresolved and blocking (Step 00, owner decision 2):**
`docs/4-layer-architecture/12-phase-g-workspace-contributions-and-closure.md:44-51`
deliberately places workspace catalogue reconciliation *after* the activation
transaction, accepting a workspace diagnostic rather than a distributed commit.
This step and Step 11 have been written assuming atomicity across activation and
workspace reconciliation. Those cannot both stand.

Until the owner decides, implement the recorded behavior: catalogue
reconciliation is a post-commit reaction observable as `catalog-reconciled`, and
a reconciliation failure is a diagnostic, not an activation rollback. Do not
write property tests that assume the stronger guarantee.

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

`WorkspaceInspection` already answers inspect. Missing: validate, plan, apply,
and profile operations. Note that `cli/src/args.rs:37-91` has **no `workspace`
subcommand**; the agent surface reaches the workspace through the existing
capability-call and operations plane, which is Step 10's delivery. Do not add a
bespoke workspace CLI path here.

Responses stay machine-readable first, with human rendering only at the CLI
edge. The first delivery may require reload after apply; semantic inspection,
validation, and revision-safe persistence may not be deferred.

## Refactoring actions

1. Decide, per row of the Gap 1 table, add-operation or remove-field. Write the
   decision down before implementing.
2. Resolve the `stateRef` question first — it determines whether the workspace
   document is a layout document or a layout-plus-state document.
3. Add the batch/atomic mutation form, or record that apply is single-command.
4. Package the workspace authority, document validation, catalogue controller,
   and canvas bridge behind a bundled plugin activation entrypoint with its own
   module id.
5. Resolve the workspace record onto that plugin's `plugin-data` namespace, or
   record the bootstrap-ordering exception (Step 05).
6. Add property tests for each new operation before any UI control emits it.
7. Replace the legacy contribution-catalogue conversion with direct view
   contributions as each artifact migrates (Step 08).
8. Delete `load_workspace_document` / `save_workspace_document` once the record
   moves, per the Step 05 decision.

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
