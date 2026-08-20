<!-- markdownlint-disable MD013 -->

# Step 00 — Charter and boundary decisions

## Relationship to the approved architecture program

This plan is **not** a new architecture. `docs/4-layer-architecture/` is the
approved, executable program (`spec/program.yaml`, status `approved`, epic
`shep-vut`). Phases A–G are source-complete; phase H (`spec/phases/phase-h.yaml`,
status `implementing`) owns final closure and the `DELETE-H-COMPATIBILITY` gate.

This plan is the **continuation** of that program: it names the residual
coupling that phase H does not enumerate, and the workspace/configuration work
that no phase record currently owns. It introduces no second plan authority.

Binding consequence: every step below must either

- cite an existing record in `docs/4-layer-architecture/spec/` and extend it, or
- state explicitly that a new phase/capability/property record is required.

Do not restate a phase A–G obligation as new work. Where this plan and the
program disagree, the program's `spec/` records win until they are amended, and
the amendment is part of the step that needs it.

## Outcome

Shipctl becomes a Tauri-hosted TypeScript application runtime in which Cordis
plugins own both background and presentation responsibilities. Rust remains the
small privileged native kernel: operating-system resources, durable primitives,
process lifetime, artifact integrity, and the Tauri adapter. Rust does not own
workspace policy, plugin-contract semantics, view composition, or user-facing
configuration grammar.

## Non-recompiling feature-delivery invariant

An **ordinary Shipctl capability** is delivered as a TypeScript Cordis plugin
artifact. It is packaged, admitted through the public artifact path, enabled in
the durable registry, and becomes available when Shipctl next starts. Shipping
that artifact must not require recompiling, rebundling, re-signing, or
re-releasing the installed Rust/Tauri host.

"Ordinary" is deliberately bounded: the plugin uses the installed host's
published plugin contract and already-supported ports and grants. It may add
domain policy, background work, schedules, operations, messages, menus, views,
workspace contributions, configuration, and plugin-owned state. A Rust platform
release is justified only when the feature needs a new privileged native
resource, a new native port or grant, an artifact-protocol/ABI change, or a
measured native implementation. It is never justified by a product module id,
configuration key, provider name, view identity, command, or workflow.

Restart after installation is the required first activation boundary. Live
install/reconcile is useful later, but is not a prerequisite and must not be
used to weaken the post-restart deployment proof in Step 09.

## What is already true (do not re-do)

The repository is materially further along than a reading of the UI suggests.
The following are implemented and are migration assets, not open work. Any step
that appears to propose them is mis-scoped.

| Already true | Evidence |
| --- | --- |
| No static module membership. The compile-time frontend module profile is empty. | `core/frontend/host/enabledModules.ts:7` (`ENABLED_MODULES = []`) |
| All nine features ship as admitted runtime artifacts with schema-v2 manifests declaring role, required/provided services, background effects, grants, contributions, and message graphs. | `modules/*/artifact/module.template.json`; e.g. `modules/usage/artifact/module.template.json` |
| A public plugin definition with roles already exists and is Cordis-free. | `module-api/frontend/src/module/plugins.ts` (`ShipctlPluginDefinition`, `defineShipctlPlugin`, `PluginArtifactDeclarations`, `PluginRuntimeInspection`) |
| Manifest↔runtime consistency (declarations, messages, grants) is validated before activation. | `core/frontend/host/moduleArtifactLoader.ts:300-349` |
| Candidate→publish atomicity, last-good recovery, and ordered disposal exist. | `core/frontend/runtime/liveReconciler.ts` (`LivePluginReconciler`, `AtomicRuntimePublication`), `core/frontend/host/liveModuleSupervisor.ts` |
| The Tauri import wall is globally enforced; the legacy-import ledger is deleted. | rule `tauri-import-outside-platform`, `ops/modularity/lib/module-boundaries.mjs` |
| The semantic workspace document, authority, catalog reconciliation, and public `shipctl.workspace@1` service exist and are renderer-neutral. | `module-api/frontend/src/protocol/workspace.ts`, `core/frontend/workspace/{authority,document,catalog,service,canvasBridge}.ts` |
| The native workspace store is already payload-opaque; it does not interpret the document grammar. | `core/backend/src/state/workspace_document.rs:1-6` |
| A revisioned durable-record service with an atomic, idempotent multi-record migration commit already exists. Its current platform adapter still hard-codes two bundled module identities, keys, and schema version rather than consuming admission. | `module-api/frontend/src/protocol/pluginData.ts`; `core/frontend/platform/pluginData.ts:99-114` (`DEFAULT_AUTHORIZE`) |
| The installed CLI is Tauri-free and the separation is enforced. | `ops/check/bin/check-cli-boundary.mjs`, `just check cli-boundary` |
| An instance control plane exists: named instances, discovery, capability call, module/schedule/operation/state inspection. | `cli/src/args.rs:37-91`, `core/backend/src/instance/control.rs` |
| A property-evidence harness with fresh/replay campaigns exists. | `ops/architecture/justfile` (`validate`, `boundaries`, `evidence`, `test`) |

## The intended topology

    native kernel (Rust + Tauri adapter)
        provides narrowly typed native ports
                    |
    trusted TypeScript application runtime
        owns one Cordis graph, admission semantics, configuration, workspace
        policy, contribution composition, diagnostics, and lifecycle
                    |
    bundled and installed TypeScript plugins
        own domain policy, background work, commands, views, menus, and state
                    |
    optional React/Layman renderer
        projects the semantic workspace document and turns gestures into intents

The renderer is a consumer of the runtime, not the place where the application
is composed. A plugin may be headless, presentation-only, or compound. The main
webview is a trusted same-realm plugin environment; that is a placement decision,
not a sandboxing claim.

## Binding decisions

| Decision | Rationale | Consequence |
| --- | --- | --- |
| Rust is a native kernel, not the product composition layer. | Filesystems, PTYs, keychains, windows, notifications, IPC, artifact integrity, and atomic storage need native ownership. View placement and feature policy do not. | Every native operation must name the resource or durable authority it protects. |
| The TypeScript runtime owns one Cordis graph, and that graph already exists. | `LiveModuleSupervisor` + `CordisStaticPluginRuntime` + `SemanticServiceRegistry` + `AcceptedWorkspaceCatalogController` already are the runtime; they are merely constructed inside `AppShell.tsx:429-582`. | **No new runtime facade type may be introduced alongside them.** Step 03 relocates construction; it does not add a composition root. |
| There is exactly one durable-record authority for plugin- and host-owned state. | `shipctl.plugin-data@1` already provides namespaced, revisioned CAS with atomic idempotent migrations. | **No `DurableDocumentPort` may be added.** Workspace and host configuration converge on `plugin-data`, unless a recorded bootstrap-ordering exception justifies a separate native record. |
| Admitted grants are runtime facts, never reconstructed from product module ids. | The loader validates admitted `requestedGrants`, but `DEFAULT_AUTHORIZE` currently re-creates policy from `shipctl.usage` / `shipctl.commands`, keys, and schema version. | The accepted artifact's effective grant set reaches host-side service bindings atomically. The public plugin context stays capability-based; ordinary plugin namespaces and keys must not require a Rust change. |
| Built-ins and installed extensions use the same artifact path. | Discovery and admission already share the path. | An artifact packaged after the host application is built can be installed, enabled, and activated after restart without changing the host package. Built-ins are fixtures, not a bundle-only exception. |
| Workspace management is a bundled TypeScript application plugin. | Workspace state is user-visible policy and must be inspectable and operable by agents without a Rust release. | Rust stores opaque revisioned records; it does not interpret panes, tabs, or profiles. |
| Tauri is sequestered, not eliminated. | Native services are essential and should remain reliable and observable. | No plugin receives `invoke`, a Tauri window object, or an unscoped native service bag. |
| Configuration grammar belongs to TypeScript. | Plugin-owned config, layout profiles, menus, and visual behavior must evolve with plugins and be available headless. | Native code exposes paths and generic durable records, not UI settings enums. |
| TypeScript owns plugin declaration semantics and the contribution taxonomy. | The contribution-family taxonomy is currently duplicated in TypeScript (`module-api/frontend/src/module/plugins.ts:29-44`) and Rust (`core/backend/src/module_control/artifact.rs:509-525`). | Step 09 removes Rust's product-semantic taxonomy. Rust retains artifact integrity, registry, protocol compatibility, and the stable native grant vocabulary; an ordinary new plugin never requires a native feature list or ACL entry. |
| The lean shipctl CLI delegates to TypeScript semantics. | Agents need the same inspect/validate/plan/apply behavior online and offline. | `cli/src/offline_modules.rs` is the existing counter-example and is in scope for Step 10. |

## What this plan does not do

- It does not expose Rust or raw Tauri APIs to plugins.
- It does not make persisted Layman snapshots the workspace source of truth.
- It does not promise untrusted third-party sandboxing.
- It does not promise live plugin installation or hot reload in the first
  increment; public installation followed by restart is sufficient.
- It does not move performance-sensitive terminal or process machinery out of
  Rust without measured evidence.
- It does not replace all existing components at once.
- It does not require live layout editing in the first workspace increment.
  Agent-readable, validated, persisted configuration is first-class; live
  updates can follow.
- It does not create a parallel plan, spec, validation harness, or property
  format alongside `docs/4-layer-architecture/`.

## Sequenced plan

1. [Step 01](step-01-baseline-and-enforceable-dependency-wall.md) closes the
   residual boundary rules and deletes the code that is already dead.
2. [Step 02](step-02-define-the-typescript-plugin-contract.md) dissolves
   `ShipctlModule` and `ModuleHostServices` into typed registries.
3. [Step 03](step-03-extract-the-typescript-application-runtime.md) moves the
   existing runtime construction out of React AppShell.
4. [Step 04](step-04-sequester-native-capabilities-behind-ports.md) breaks up
   the residual `platform/tauri.ts` facade.
5. [Step 05](step-05-move-configuration-and-persistence-policy-to-typescript.md)
   moves configuration grammar out of Rust and collapses the durable-record
   authorities to one.
6. [Step 06](step-06-make-workspace-management-a-cordis-service.md) gives the
   workspace an owner and closes its unreachable-state gaps.
7. [Step 07](step-07-make-layout-frame-and-navigation-composable.md) dissolves
   the compatibility canvas into contributed views.
8. [Step 08](step-08-unify-built-ins-as-dynamic-typescript-artifacts.md)
   replaces `module: ShipctlModule` in the nine artifact entrypoints.
9. [Step 09](step-09-strangle-native-feature-policy-to-base-providers.md)
   removes the named vendors and the duplicated taxonomy from Rust.
10. [Step 10](step-10-add-headless-runtime-and-agent-cli-delegation.md) deletes
    the CLI's Rust policy twin and adds the offline runtime.
11. [Step 11](step-11-prove-cutover-and-retire-legacy-wiring.md) adds the
    missing property records and writes the deletion gates.

## Cross-cutting proof obligations

Each step must preserve these properties. Where an existing property record
already covers one, the step cites it rather than inventing a second oracle.

1. A plugin never needs a raw Tauri import to perform a supported action.
   *(covered: `tauri-import-outside-platform`, `module-direct-tauri-event`)*
2. Native privileged operations are unavailable unless an explicit typed port
   and grant admit them. An admitted plugin can reach only its own durable
   namespace; a denied or disposed plugin can neither read nor write it.
3. A rejected plugin candidate graph changes no published runtime state,
   schedule, route, or workspace catalogue. *(covered: `PROP-F-ATOMIC-001`)*
4. The durable workspace document is semantic and renderer-independent.
   *(covered: `PROP-G-WORKSPACE-001`, `PROP-G-RENDERER-001`)*
5. An agent can inspect, validate, plan, and apply workspace/configuration
   changes with revision conflict protection. **(no current record — new)**
6. Admitted plugins behave consistently in the UI runtime and the headless
   runtime, within the capabilities supplied to each. **(no current record —
   new)**
7. Every representable state in the durable workspace document is reachable and
   leavable through a public semantic operation. **(no current record — new;
   see Step 06)**
8. Compatibility adapters have a named owner, coverage, and deletion condition
   expressed as a `deletion_gates` entry in a phase record.
9. A plugin artifact produced after a host package is built can be installed and
   activated after restart while the host's native and host-frontend artifacts
   remain unchanged. **(no current record — new; see Steps 09 and 11)**

## Open decisions requiring the owner

These are genuine forks. They are not agent choices, and no step may silently
resolve them.

1. **Workspace commit scope.** `docs/4-layer-architecture/12-phase-g-...md:44-51`
   deliberately places workspace catalogue reconciliation *after* the activation
   transaction, accepting a workspace diagnostic instead of a distributed
   commit. Steps 06 and 11 assume atomicity across both. Either the plan adopts
   the recorded decision, or the decision is re-opened with an owner.
2. **Legacy canvas retirement — resolved 2026-08-19.** Dariusz Debowczyk
   authorized retirement through `DELETE-H-LEGACY-CANVAS` after its stated
   parity and recovery evidence passes. This is not authorization to remove
   the fallback before the deletion gate proves the replacement.
3. **Headless execution realm — resolved 2026-08-20.** Dariusz Debowczyk
   selected a bundled Node runtime sidecar plus a bundled TypeScript program.
   The installed CLI locates the signed runtime beside itself and passes the
   program from the application Resources directory over a versioned local
   runner protocol. Shipctl must not depend on a user-installed Node.js or
   link Tauri into the CLI. A future compiled runner is permitted only when it
   preserves the same executable location, request/response ABI, diagnostics,
   and one-package update relationship. Step 10 records the measured package
   evidence and signing result for this choice.
