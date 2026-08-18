<!-- markdownlint-disable MD013 -->

# Step 00 — Charter and boundary decisions

## Outcome

Shipctl will become a Tauri-hosted, TypeScript application runtime in which
Cordis plugins can own both background and presentation responsibilities. Rust
will remain the small, privileged native kernel: it provides operating-system
resources, durable primitives, process lifetime, and the Tauri adapter, but it
will not own workspace policy, plugin policy, view composition, or user-facing
configuration grammar.

This is an evolutionary refactor. It does not require a rewrite of the
terminal, assistant, usage, or workspace features. It deliberately preserves
the useful seams already present in the repository:

- module-api is already a public TypeScript contract;
- core/frontend/runtime/cordis is already the sole private Cordis adapter;
- core/frontend/workspace already contains a renderer-neutral TypeScript
  document authority;
- core/frontend/platform is already the sole location of direct Tauri imports;
- the Rust workspace document store already offers revisioned, durable writes.

The remaining work is to turn those local seams into the application boundary,
rather than leaving application policy split between AppShell, static host
catalogues, platform wrappers, and Rust configuration.

## The intended topology

    native kernel (Rust + Tauri adapter)
        provides narrowly typed native ports
                    |
    trusted TypeScript application runtime
        owns one Cordis graph, admission, configuration, workspace policy,
        contribution composition, diagnostics, and lifecycle
                    |
    bundled and installed TypeScript plugins
        own domain policy, background work, commands, views, menus, and state
                    |
    optional React/Layman renderer
        projects the semantic workspace document and turns gestures into intents

The renderer is a consumer of the runtime, not the place where the application
is composed. A plugin may therefore be headless, presentation-only, or both.
The main webview is a trusted same-realm plugin environment during this
migration. That is not a claim of sandboxing; third-party execution must remain
admitted and trusted until a separately designed isolation model exists.

## Binding decisions

| Decision | Rationale | Consequence |
| --- | --- | --- |
| Rust is a native kernel, not the product composition layer. | Filesystems, PTYs, keychains, windows, notifications, IPC, and atomic storage need native ownership. View placement and feature policy do not. | Every native operation must name the resource or durable authority it protects. |
| The TypeScript application runtime owns one Cordis graph. | A single lifecycle and service graph avoids the current split between AppShell wiring, static module catalogues, and a Cordis wrapper. | React, the CLI bridge, and native bootstrap consume the same runtime contract. |
| Built-ins and installed extensions use the same plugin path. | A removable module cannot be truly removable while the host has a privileged static rendering path for it. | Bundled artifacts may have stronger admission provenance, but no special composition API. |
| Workspace management is a bundled TypeScript application plugin. | Workspace state is user-visible policy and must be inspectable and operable by agents without a Rust release. | Rust stores opaque revisioned documents; it does not interpret panes, tabs, or profiles. |
| Tauri is sequestered, not eliminated. | Native services are essential and should remain reliable and observable. | No plugin receives a generic invoke function or raw Tauri objects. |
| Configuration grammar belongs to TypeScript. | Plugin-owned config, layout profiles, menus, and visual behavior must evolve with plugins and be available in headless operation. | Native code exposes paths and generic durable documents, not UI settings enums. |
| The lean shipctl CLI delegates to the same TypeScript semantics. | Agents need the same inspect, validate, plan, and apply behavior whether the UI is running or not. | Online and headless routes share schema and operation implementations; the CLI does not embed Tauri. |

## What this plan does not do

- It does not expose Rust or raw Tauri APIs to plugins.
- It does not make persisted Layman snapshots the workspace source of truth.
- It does not promise untrusted third-party sandboxing.
- It does not move performance-sensitive terminal or process machinery out of
  Rust without evidence.
- It does not replace all existing components at once.
- It does not require live layout editing in the first workspace increment.
  Agent-readable, validated, persisted configuration is the first-class
  capability; live updates can follow.

## Sequenced plan

1. [Step 01](step-01-baseline-and-enforceable-dependency-wall.md) establishes
   the dependency baseline and makes the wall testable.
2. [Step 02](step-02-define-the-typescript-plugin-contract.md) replaces the
   monolithic module contract with a plugin-facing TypeScript contract.
3. [Step 03](step-03-extract-the-typescript-application-runtime.md) extracts
   application composition from React AppShell.
4. [Step 04](step-04-sequester-native-capabilities-behind-ports.md) narrows
   native capabilities and their grants.
5. [Step 05](step-05-move-configuration-and-persistence-policy-to-typescript.md)
   moves configuration and persistence policy to TypeScript.
6. [Step 06](step-06-make-workspace-management-a-cordis-service.md) makes
   workspace state and operations a Cordis-owned application service.
7. [Step 07](step-07-make-layout-frame-and-navigation-composable.md) makes the
   renderer, frame, menus, and navigation composable.
8. [Step 08](step-08-unify-built-ins-as-dynamic-typescript-artifacts.md)
   converts current feature modules to direct dynamic artifacts.
9. [Step 09](step-09-strangle-native-feature-policy-to-base-providers.md)
   removes feature policy left in native code.
10. [Step 10](step-10-add-headless-runtime-and-agent-cli-delegation.md) gives
    agents an online and offline path through the same runtime.
11. [Step 11](step-11-prove-cutover-and-retire-legacy-wiring.md) supplies the
    property-based proof, rollout, observability, and deletion gates.

## Cross-cutting proof obligations

Each step must preserve these properties:

1. A plugin never needs a raw Tauri import to perform a supported action.
2. Native privileged operations are unavailable unless an explicit typed port
   and grant admit them.
3. A rejected plugin candidate graph changes no published runtime state,
   schedule, route, or workspace catalogue.
4. The durable workspace document is semantic and renderer-independent.
5. An agent can inspect, validate, plan, and apply workspace/configuration
   changes with revision conflict protection.
6. The same admitted TypeScript plugins behave consistently in the UI runtime
   and the headless runtime, within the native capabilities explicitly supplied
   to each.
7. Compatibility adapters have a named owner, coverage, and deletion condition.

The remaining files turn these decisions into small, reviewable refactoring
increments rather than a speculative platform rewrite.
