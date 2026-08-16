# Cordis application runtime and plugin roles

<!-- markdownlint-disable MD013 -->

## Decision

Cordis plugins are Shipctl application plugins. They are not limited to React
views or other presentation features.

A plugin can:

- provide application or domain services to other plugins;
- consume services supplied by the native platform or another plugin;
- own controllers, workflows, projections, data processing, and commands;
- run reversible background effects such as subscriptions, timers, workers,
  and connections;
- publish optional views, menus, navigation, popups, or settings surfaces.

The Rust/Tauri kernel supplies privileged native capabilities and durable
native resources. It is not the only backend runtime. TypeScript plugin logic
that has no visual surface is plugin backend behavior and remains in userland.

## Why the earlier UI reading was wrong

The dynamic-workspace work starts from views, menus, and canvas contributions.
That is one collaboration plane. It does not define the plugin model.

If Cordis were only a UI registry, Shipctl would have two feature systems:

1. hard-wired backend behavior in core or host TypeScript;
2. dynamic React presentation in plugins.

That split would preserve the main coupling that this migration must remove.
Features such as assistant orchestration, usage ingestion, saved-command
autostart, Git projections, and skill discovery would still require core
changes even when they need no new native privilege.

The corrected model has one plugin activation for all TypeScript feature
responsibilities. Presentation is an optional effect of that activation.

## Runtime topology

```text
Tauri application
|
+-- Rust/Tauri native kernel
|   +-- OS authority and authorization
|   +-- PTYs, processes, filesystem, Git, native UI, secrets
|   +-- durable resources and plugin artifact admission
|   +-- private typed IPC
|
+-- trusted TypeScript application host
    +-- Cordis application root
    +-- native capability service adapters
    +-- plugin-provided application service graph
    +-- artifact loader and live reconciler
    +-- effect, readiness, and disposal supervision
    +-- agent-visible runtime projection
    +-- optional React shell and workspace renderer
        |
        +-- headless plugins
        +-- presentation plugins
        +-- compound plugins
```

The first TypeScript execution realm is the main Tauri webview because Shipctl
does not have a Node application host. This is a placement decision, not a
statement that plugin behavior is UI behavior.

One logical Cordis application graph is the authority. A later Worker or
extension-host process can execute selected plugin code through a checked
broker, but it must preserve the same plugin identity, service contracts,
activation state, and disposal ownership.

## Plugin roles

Roles are derived from registered responsibilities. They do not require a
manifest `kind` flag.

| Role | Responsibilities | React required | Example |
| --- | --- | --- | --- |
| Headless | Services, controllers, workflows, events, data processing, background effects, commands | No | Usage ingestion and aggregation service |
| Presentation | Views and other visual contributions over injected services | Only for React views | Terminal presentation over a host-owned session |
| Compound | Headless behavior and optional presentation under one activation | Only for its presentation | Saved-command runtime plus command panel |

One artifact can change role over time without changing the runtime model. For
example, a headless plugin can later add a dashboard contribution. The service,
effect, readiness, and disposal rules remain the same.

## Two meanings of backend

The architecture distinguishes these responsibilities:

- **Native backend:** Rust code that needs OS authority, durable native
  ownership, secret handling, or enforcement outside plugin JavaScript.
- **Plugin backend:** TypeScript application logic that does not require a
  visual surface. It can use injected native services but cannot call Tauri or
  add native commands.

Moving a headless feature controller into core only because it is called a
backend would break the target boundary. The placement test is privilege and
resource ownership, not whether a React component calls the code.

## Service definition, provider, and consumer

The plugin API owns stable service meaning. A provider owns an implementation.
A consumer declares a dependency. Cordis binds them.

```text
plugin API service definition
          ^             ^
          |             |
 provider plugin     consumer plugin
          \             /
           Cordis service graph
```

A permanent platform adapter can also implement a public service when the
operation crosses the native wall. This does not make all service providers
permanent core code.

The manifest records:

- required service IDs and compatible versions;
- provided service IDs and compatible versions;
- requested native grants and resource scopes;
- application entry point and readiness requirements;
- background responsibilities that need inspection;
- optional presentation and other contribution declarations.

Consumers import the service contract from the plugin API. They do not import
the provider package. Provider replacement can then change implementation
without rebuilding consumers.

## Activation and disposal

One plugin artifact version produces one activation identity. That activation
owns all services, effects, contributions, and leases created by the plugin.

```ts
export const inject = ["projects", "terminalSessions"];

export function apply(ctx: ShipctlPluginContext): void {
  const coordinator = new SessionCoordinator(
    ctx.projects,
    ctx.terminalSessions,
  );

  ctx.provide("assistantSessions", coordinator);
  ctx.effect(() => coordinator.start(), "assistant session coordinator");

  if (ctx.presentation) {
    ctx.effect(
      () => ctx.views.register(assistantSessionsView),
      "assistant sessions view",
    );
  }
}
```

The example has one application lifecycle. React mount and unmount are
presentation results. They do not start or define the domain lifecycle.

Candidate activation stays private until required services, grants, runtime
registrations, and readiness all pass. Publication switches the complete
accepted service graph and contribution catalogs together. Failed replacement
leaves the previous activation public.

Disposal withdraws:

- provided application services;
- service subscriptions and event listeners;
- controllers, timers, workers, and connections;
- commands and optional UI contributions;
- native-resource observation or attachment leases;
- plugin-owned transient caches and styles.

Disposal does not destroy a host-owned PTY, durable record, or other native
resource unless a separate capability contract assigns that behavior to the
activation.

## What transfers from DeepSeek Harness

The local DeepSeek Harness source at commit
`47f943859bef60e4160492346772ded9b24f765a` provides direct evidence for this
model:

- its root guidance states that everything is a plugin;
- its package map separates service definition, provider, and consumer roles;
- plugins compose agent loops, tools, jobs, workflows, persistence, policies,
  model adapters, and other headless responsibilities;
- `inject` expresses dependencies and readiness instead of manual boot order;
- `ctx.effect()` and event registrations provide reversible ownership;
- `cordis.yml` selects an application composition, including compositions that
  do not define a browser UI;
- a separate client Cordis runtime composes browser plugins and UI slots.

Shipctl should transfer the application-composition principles. It should not
copy DeepSeek Harness's execution topology without a Shipctl requirement.
DeepSeek Harness has a Node host and a separate browser client. Shipctl has a
Rust/Tauri host and can first run trusted TypeScript application plugins in the
main webview.

The following DeepSeek details are not Shipctl contracts:

- a Node process as the application host;
- its exact loader, configuration syntax, or package graph;
- its restart behavior for browser membership changes;
- any implication that Cordis replaces native authorization or resource
  ownership.

## Current Shipctl evidence

The current repository already contains feature behavior that does not fit a
UI-only plugin model.

`modules/commands/frontend/src/runtime.ts` owns:

- project command loading and persistence;
- terminal-session lifecycle subscription and adoption;
- start, stop, start-all, and stop-all workflows;
- autostart behavior;
- runtime state transitions and error notices.

`CommandsPanel.tsx` is a presentation consumer of that behavior. The commands
module is therefore the correct first compound pilot. The migration should put
its runtime and optional panel under one Cordis activation instead of treating
the panel as the plugin and leaving `runtime.ts` in permanent host code.

Other planned modules have the same pattern:

- assistants can provide session and orchestration services plus optional
  session views;
- usage can run ingestion, normalization, aggregation, and scheduled refresh
  plus optional dashboards;
- Git can provide repository projections and workflows plus optional views;
- skills can perform discovery and indexing plus optional management UI;
- ports can own polling and projections plus optional visual presentation.

Their native operations remain behind permanent semantic platform services.

## Artifact and execution placement

Every artifact has a required TypeScript application entry point. React chunks,
CSS, assets, and view declarations are optional. Cordis and the plugin API are
always host-supplied shared identities. React and React DOM are supplied only
when the artifact uses presentation contracts.

The first runtime supports trusted same-realm plugins. This gives architectural
isolation through import rules, service injection, grants, and native request
authorization. It does not provide hostile-code containment.

A separate realm is required when one of these product requirements exists:

- headless TypeScript work must continue after the main webview is destroyed;
- work can block the UI event loop and cannot be bounded in the same realm;
- a plugin has a different trust level;
- process-level fault or memory isolation is required.

Those requirements can select a Worker, unprivileged webview, or extension-host
process later. No such requirement is assumed for the first migration.

## Agent inspection and operation

The running-instance control plane must expose the complete application graph,
not only visible contributions. An agent must be able to inspect:

- plugin artifact, activation, desired revision, and applied revision;
- required and provided service IDs and their active bindings;
- readiness, health, background effects, and disposal state;
- native grants and resource scopes;
- commands, views, menus, and other optional contributions;
- service request, diagnostic, and resource-lease correlation IDs.

An agent must be able to identify a headless failure even when the plugin has no
view and emitted no user notification. UI scraping is never an authority for
plugin state.

## Migration effect

This correction does not add a new migration phase or require a rewrite. It
changes the proof inside existing phases:

- Phase B supplies semantic native services to any plugin responsibility, not
  only React clients.
- Phase C proves a headless provider/consumer fixture and the compound commands
  module under the same Cordis application lifecycle.
- Phase E proves that a valid artifact can have no React dependency or
  presentation declaration.
- Phase F reconciles application-service routing atomically with optional
  contribution catalogs.
- Phase G handles only the presentation plane: workspace, menus, navigation,
  and other visible contributions.

The first no-regret move remains the semantic service wall. It lets existing
TypeScript feature behavior run and test without Tauri before the artifact
loader or execution placement is final.

## Acceptance conditions

This design is proved when:

- a no-React plugin provides a service, consumes platform services, runs an
  owned background effect, and disposes cleanly;
- a compound plugin owns headless behavior and optional React contributions
  under one activation identity;
- one plugin consumes another plugin's versioned service without an
  implementation import;
- live provider replacement never exposes a provisional or disposed service;
- the agent control plane reports headless and presentation responsibilities
  with the same artifact and activation identity;
- neither plugin can access Tauri except through admitted semantic services;
- native resources keep the ownership and continuity stated by their platform
  capability contracts.
