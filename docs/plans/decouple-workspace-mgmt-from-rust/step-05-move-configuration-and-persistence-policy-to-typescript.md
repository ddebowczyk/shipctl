<!-- markdownlint-disable MD013 -->

# Step 05 — Move configuration grammar out of Rust and collapse to one durable authority

## Outcome

Rust stops defining what a setting *means*. `GlobalConfig` keeps only what the
native kernel genuinely needs, and everything else becomes a TypeScript-owned,
versioned, migratable configuration namespace stored through the durable-record
authority that already exists.

## The durable authority already exists — do not add a second one

The earlier draft proposed defining a `DurableDocumentPort` with "namespaced
document identifiers, opaque payloads, compare-and-swap, atomic persistence,
backup/recovery, transaction primitives". That is a description of
`shipctl.plugin-data@1` (`module-api/frontend/src/protocol/pluginData.ts`),
which is implemented, admitted, granted, and in use:

| Draft requirement | Already provided by `shipctl.plugin-data@1` |
| --- | --- |
| namespaced document ids | `ownerModuleId` + `scope` (`global` \| `project`) + `key` |
| opaque payload | `value: ModuleJsonValue`, `schemaVersion` |
| compare-and-swap write | `writeRecord.expectedRevision` (`null` = create-only) |
| atomic multi-document commit | `migrateRecords` — "All record changes in one migration commit or none do" (`pluginData.ts:57-61`) |
| idempotent recovery | `PluginDataMigrationReceipt.replayed` — a replay returns the original committed records without new revisions |
| structured failure | 13-member `PluginDataErrorCode`, including `conflict`, `denied`, `invalid-revision`, `unavailable` |
| grant scoping | `plugin-data.read` / `.write` / `.migrate` |

**Binding: no `DurableDocumentPort` is introduced.** The draft's open question —
"the choice should be made and tested before configuration is used to activate
plugins" — is already answered by `migrateRecords`. Delete the question; test
the existing primitive instead.

### The current adapter is not yet dynamic

`createPluginDataServiceProvider` is still guarded by `DEFAULT_AUTHORIZE`
(`core/frontend/platform/pluginData.ts:99-114`), which recognizes only
`shipctl.usage` global `settings` and `shipctl.commands` project `commands` at
schema version 1. Its test fake mirrors the same two identities. This is a
temporary product table in the host, not a durable-storage guarantee.

Before any configuration namespace migrates, Step 02 must carry the already
admitted grants to the private provider-binding context and replace both tables.
The adapter then admits an active activation holding the requested
`plugin-data.*` grant and binds the native record to that activation's own
namespace. It retains validation of scope, key, revision, and JSON shape; it
does not decide which plugin key or schema version is legitimate. Those are
TypeScript-owned configuration declarations and migrations.

The public protocol already has `plugin-data.migrate`, but native artifact
admission presently supports only `plugin-data.read` and `.write`. Align that
stable capability vocabulary once (Step 04) before a configuration migration
requests it; otherwise the plan would promise an atomic operation no admitted
artifact can use.

### The one real gap in that authority

`PluginDataRecord.ownerModuleId` is *derived from the activation* — "callers
never select another namespace" (`pluginData.ts:28`). Host-owned state therefore
has no namespace today: the trusted runtime is not an activation.

This forces a decision that this step must make explicitly:

- **Option A** — host-owned configuration is stored under a reserved host
  identity admitted by the runtime (e.g. `shipctl.host`), with writes restricted
  to the trusted runtime, never reachable from a plugin activation context.
- **Option B** — configuration that needs a namespace becomes a bundled plugin's
  configuration; the workspace document then belongs to the workspace plugin
  (Step 06), and host bootstrap stays in the native config file because it must
  be readable before any plugin activates.

Option B is the smaller move and is consistent with Step 06's premise, but it
does not cover host bootstrap. Whichever is chosen, record it here — the
`shipctl.workspace@1` capability record already declares
`depends_on: [plugin-data]`, so the workspace half of this decision is
half-made and should not be left implicit.

## What Rust actually owns today

`core/backend/src/workspace/config.rs` — `GlobalConfig` fields:

| Field | Classification | Disposition |
| --- | --- | --- |
| `version` | native file-format version | keep |
| `repos`, `groups` | project registry — durable native resource identity | keep in Rust; expose via the projects service (Step 04) |
| `ui: UiSettings { canvas: CanvasAdapter }` | **renderer selection** | **delete** — see below |
| `editor`, `keybindings`, `terminal`, `sidebar`, `projects` | user-facing settings grammar | move to TypeScript namespaces |
| `capability_data` (`#[serde(flatten)]`) | namespaced escape hatch | keep as the human-facing surface; it is the migration target |

`capability_value` / `replace_capability_value` (`config.rs:86-103`) already give
capabilities a namespaced slot in `~/.shipctl/config.yml` without expanding the
host schema. This is the mechanism to migrate onto — not a new one.

**Hazard to handle explicitly:** `assert_capability_id` (`config.rs:105+`)
rejects a capability id that collides with a host-owned field by serialising
`GlobalConfig` and checking the key set. As host fields are removed, previously
rejected ids silently become admissible — `editor`, `terminal`, `sidebar`,
`keybindings`, `ui`. Removal order therefore changes validation behavior. Either
reserve the retired names permanently or state that reuse is intended.

## The renderer-selection bootstrap dependency

`src/main.tsx:13-19` awaits `getCanvasAdapter()` — a Tauri round-trip into
`GlobalConfig.ui.canvas` — *before the first render*, and passes the result into
`<App>` as both `canvasAdapter` and `canvasAdapterId`. A Rust enum with two
variants (`config.rs:9-14`) decides which renderer the application is.

This is the clearest single instance of native code owning product composition,
and it is small: two variants, one command, one bootstrap await.

Target: the runtime starts, reads renderer selection from TypeScript-owned
configuration, and resolves an adapter from the registered renderer set. Adding
a renderer must not require a Rust enum variant. The failure path in
`main.tsx:25-39` (a rendered error page) stays — but it should report a
configuration diagnostic, not a transport error.

Sequencing note: this depends on Step 03 having moved runtime construction out of
`AppShell`, and it is a prerequisite for Step 07's renderer composition. Do not
attempt it before Step 03 lands.

## The workspace-document question this step must answer

Two native durable stores exist for workspace state:

- `core/backend/src/state/workspace_document.rs` — payload-opaque, but the
  envelope carries a workspace-specific `catalog_revision` field, and the
  commands are named `load_workspace_document` / `save_workspace_document`;
- `core/backend/src/state/workspace_layout.rs` — raw Layman snapshots,
  **already dead**, deleted in Step 01.

`core/frontend/workspace/persistence.ts:10-20` defines
`WorkspacePersistencePort { load, compareAndSave }` — already generic in shape.
Only the two command names and the `catalog_revision` envelope field are
workspace-specific.

Decide and record one of:

1. **Converge.** Workspace records become plugin-data records under the
   workspace plugin's namespace; `workspace-documents.json` becomes a one-way
   import; the two commands are deleted. `catalog_revision` moves inside the
   opaque payload.
2. **Keep separate, justify.** The workspace store stays because it must be
   readable before plugin activation (a bootstrap ordering argument, not a
   convenience one), and `catalog_revision` stays in the envelope because the
   native side needs it for a stated reason.

Option 1 is the plan's stated direction (Step 00: "exactly one durable-record
authority"). Option 2 is admissible only with the bootstrap-ordering argument
written down. Silence is not admissible — two durable authorities with
overlapping semantics is exactly the permanent half-transition this plan exists
to prevent.

## Configuration model

Configuration namespaces, each with an owner, a `schemaVersion`, defaults, and a
migration function:

| Namespace family | Owner | Contents |
| --- | --- | --- |
| host bootstrap | native config file | config version, project registry, artifact source roots, trust policy — anything needed *before* a plugin activates |
| runtime configuration | trusted TypeScript runtime | renderer selection, admission policy, active profile |
| plugin configuration | individual plugin | assistant providers, usage filters, terminal presentation, editor/keybinding/sidebar preferences after migration |
| project-scoped settings | owning plugin | via `PluginDataScope { kind: "project" }`, which already exists |

A plugin cannot write another plugin's namespace; `ownerModuleId` derivation
already enforces this. Cross-plugin configuration goes through a published
schema or a runtime-owned policy record, never an undocumented key.

`~/.shipctl/config.yml` remains the human-facing entry point. Its non-host
sections are parsed and validated by TypeScript and projected into records.
Resolution must be deterministic without a webview — that is the headless
requirement (Step 10), and it is why parsing cannot live in a React hook.

## Migration protocol

Per migrated namespace, once, idempotently:

1. read the legacy native value and the current record revision;
2. validate the legacy value against the new schema; on failure, write nothing
   and emit a diagnostic naming the namespace and the failing path;
3. commit via `migrateRecords` with a stable `migrationId`;
4. on replay, `receipt.replayed === true` and no revision advances;
5. stop writing the native field; keep reading it until the deletion gate;
6. delete the native field, its accessor commands, and its TypeScript adapter
   members in one commit.

Step 5→6 is the removal condition. A migration that leaves the native field
readable indefinitely is the half-transition; each namespace needs a named gate.

## Refactoring actions

1. Record the host-namespace decision (Option A or B above) before writing code.
2. Record the workspace-store decision (Converge or Keep-separate) with its
   argument.
3. Replace the hard-coded plugin-data authorization and matching fake policies
   with effective-grant binding from Step 02. Prove that an arbitrary admitted
   plugin can use its own configuration namespace, while a denied or disposed
   plugin cannot leave a write behind.
4. Move renderer selection out of `CanvasAdapter`/`UiSettings`; remove the
   `getCanvasAdapter` await from `src/main.tsx`; delete the command.
5. Migrate `editor`, `keybindings`, `terminal`, `sidebar`, `projects` to
   TypeScript namespaces one at a time, each with its own `migrationId` and gate.
6. Delete the matching getters/setters from `platform/tauri.ts` as each
   namespace lands (Step 04 depends on this).
7. Decide and document the fate of the retired `GlobalConfig` field names in
   `assert_capability_id`.
8. Add configuration-schema contributions to the plugin contract, registered
   from the accepted graph.
9. Build inspect and validate operations before apply operations; apply is
   revision-aware and refuses to overwrite a newer edit.

## Validation and exit criteria

- Adding a renderer, a setting, or a default requires no Rust change and no
  rebuild of the native binary.
- `rg "CanvasAdapter"` returns no Rust match; `src/main.tsx` performs no
  configuration `invoke` before first render.
- Invalid configuration never replaces the last accepted record; the prior
  record and its revision are unchanged after a failed apply.
- Re-running a completed migration returns `replayed: true` with no revision
  advance — a `node --test` case, not a manual check.
- A fixture plugin with admitted `plugin-data.*` grants can create, inspect, and
  migrate its own new configuration key with no Rust change; an unadmitted peer
  cannot read, write, or migrate that record.
- A conflict error names the namespace, key, expected revision, and current
  revision.
- The UI runtime and the headless runtime resolve the same fixture
  configuration to the same semantic result (proof obligation 6, Step 00).
- Exactly one durable-record authority remains, or the second one has a written
  bootstrap-ordering justification in this file.
- No native command name in the codebase contains a UI-settings noun.
