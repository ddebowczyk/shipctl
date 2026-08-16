# Target boundaries and collaboration

## Authority model

The target separates code by privilege and lifecycle. It does not use one
language per architectural layer.

```text
TypeScript-only application plugin
        |
        | imports contracts, receives services, registers effects
        v
TypeScript plugin API
        ^
        | implemented by trusted adapters
        |
Trusted TypeScript application host
        |
        | private typed IPC
        v
Rust/Tauri native kernel
```

The permanent platform is layers 1 and 2 together. A Rust-only `core` would
leave application composition, Cordis, artifact loading, optional React, and
Tauri mediation without a valid owner. The Chinese wall is between trusted
host code and plugins, not between Rust and TypeScript. The main webview is the
first execution realm for this host; it is not a UI-only responsibility
boundary.

## Layer 1: native kernel

### Native kernel ownership

- PTYs, processes, ordered terminal streams, and terminal identity;
- filesystem and repository authorization;
- Git execution and filesystem watching;
- native windows, menus, notifications, clipboard, and OS handoffs;
- durable settings, namespaced plugin data, credentials, and secrets;
- artifact staging, validation, integrity, storage, and admission;
- effective native grants and request authorization;
- the running-instance protocol and agent control plane;
- native resources that must survive plugin replacement.

### Internal split

- `core/backend` owns Tauri-free logic and can serve the CLI.
- `core/tauri` owns private Tauri commands, channels, and events.
- `src-tauri` constructs the app, registers adapters, and remains beside
  `tauri.conf.json` for `tauri::generate_context!()`.

### Must not know

The kernel does not know React components, Cordis plugin code, Layman nodes,
feature panel placement, or Zustand stores.

## Layer 2: trusted TypeScript application host

### Application host ownership

- all frontend imports of `@tauri-apps/*`;
- private IPC clients and conversion to public semantic services;
- one logical application Cordis root;
- plugin artifact import and graph reconciliation;
- one activation identity and child context per plugin instance;
- application-service dependency binding and replacement;
- lifecycle ownership for headless timers, subscriptions, workers,
  connections, and controllers;
- contribution collection, validation, and immutable catalog publication;
- React, React DOM, Cordis, and plugin API singleton identities;
- workspace state and renderer-independent projection;
- legacy and Layman canvas adapters;
- host-owned notices, diagnostics, error boundaries, and inspection snapshots.

### Internal capabilities

The target host gains these named areas:

```text
core/frontend/
  platform/       private Tauri clients and semantic service adapters
  runtime/        Cordis app root, services, activation, reconciliation
  contributions/ reversible registries and immutable accepted catalogs
  workspace/      semantic document and reconciliation
  canvas/         legacy and Layman renderers
  shell/          startup and top-level React composition
```

Existing capability directories remain where they own real host behavior.
Names can be refined during implementation. The dependency rules matter more
than the exact directory spelling.

### Must not do

The host does not statically import the permanent module set after artifact
cutover. It does not expose raw `invoke`, command strings, Tauri channels, or
concrete stores to plugins. It does not put feature placement policy into the
canvas.

## Layer 3: TypeScript plugin API

### Owns meaning, not behavior

The API defines:

- semantic services and JSON-safe values;
- Cordis context augmentation for those services;
- plugin manifests and compatibility rules;
- activation, readiness, cancellation, and disposal;
- commands, views, menus, navigation, settings, and other contributions;
- snapshots, subscriptions, streams, diagnostics, and stable IDs;
- requested capabilities, effective grants, and resource scopes.

Framework-neutral service interfaces should remain separate from their Cordis
binding. A service can then be tested with a plain fake and exposed through a
small Cordis augmentation module.

### Forbidden public types

No public plugin API type contains:

- a Tauri command name;
- `Channel`, `AppHandle`, or `WebviewWindow`;
- a Layman node;
- a concrete Zustand store;
- a Rust type or crate concept;
- a private host path.

React component types are valid only in contribution contracts that require a
React view. React remains a host-supplied peer identity, not a bundled plugin
copy.

## Layer 4: TypeScript-only Cordis plugins

A plugin owns application and domain services, workflows, controllers, data
processing, commands, background effects, subscriptions, and optional
presentation. It can use only:

- Cordis;
- the Shipctl plugin API;
- host-supplied React and React DOM when it publishes React contributions;
- approved shared UI libraries;
- dependencies bundled inside its own artifact.

It cannot import Tauri, `@shipctl/core`, a private IPC client, Layman, another
plugin implementation, or native bindings.

Built-ins and installed plugins use the same manifest, build, artifact,
admission, activation, contribution, disposal, and inspection paths. A built-in
is only an artifact that ships with Shipctl and is enabled by default.

A plugin's registered responsibilities define its role; a manifest `kind` flag
is not required:

- a **headless plugin** provides or consumes services and owns non-visual
  effects without importing React;
- a **presentation plugin** registers UI contributions and can remain thin;
- a **compound plugin** owns headless behavior and optional presentation under
  one activation identity and disposal tree.

“Backend” does not mean “Rust” in all contexts. Native backend work needs OS
authority or durable native ownership and belongs to layer 1. Plugin backend
work is TypeScript application logic without a visual surface and belongs to
layer 4.

## Platform capability providers

A native platform capability is a vertical slice, not a plugin:

```text
public TypeScript service contract
              ^
trusted TypeScript adapter
              ^
private typed IPC
              ^
Tauri adapter
              ^
Tauri-free Rust implementation
```

The provider exists because the operation needs native authority or durable
host ownership. It does not absorb a feature's workflow merely because that
workflow currently runs in Rust.

Plugins can also provide application services to other plugins. Those services
use contracts and stable IDs from the plugin API and Cordis dependency
injection. Consumers never import provider implementations. A service does not
become a native platform capability merely because it is headless.

Examples:

- terminal sessions are a platform capability; terminal presentation is a
  plugin;
- Git execution and repository watching are a platform capability; diff and
  branch workflows are a plugin;
- process inspection and authorized termination are a platform capability;
  the ports dashboard is a plugin;
- namespaced durable data is a platform capability; assistant and usage domain
  state is plugin policy.

## Collaboration planes

### Capability plane

A plugin declares required service IDs and native grants. Admission computes
the effective set. Cordis receives only the admitted service bindings. Each
native request also carries an activation identity so Rust can enforce the
same effective grant.

Plugins can declare provided application services. Candidate activation must
resolve provider and consumer compatibility before publication. Replacement
must switch new consumers atomically and dispose the old provider only after
the accepted graph no longer routes work to it.

### Contribution plane

A plugin registers typed contributions as activation-owned effects. The host
collects a candidate set, validates IDs and references, and publishes one
immutable catalog snapshot. Workspace and menus consume the accepted catalog;
they never discover plugins.

### Data plane

Normal service calls use semantic request and result types. Low-volume events
use typed subscriptions. High-volume ordered terminal output uses a dedicated
stream contract with attachment identity, ordering, replay, credit, and
disconnect behavior. It does not share the general event bus.

### Control plane

The native registry owns desired state and artifact admission. The TypeScript
application runtime owns applied Cordis state. Both publish revisioned
snapshots through the running-instance protocol. Agents can inspect desired
versus applied state and request install, enable, replace, disable, or remove
operations.

### Presentation plane

The workspace service reconciles accepted view contributions into a semantic
document. A selected canvas adapter renders that document. Plugins request
semantic operations such as `workspace.open` or `workspace.reveal`; they do
not mutate a Layman tree.

## Activation sequence

```text
admitted artifact revision
        |
        v
load digest-qualified code in a candidate activation
        |
        v
create activation-scoped Cordis context and service grants
        |
        v
collect provisional services, effects, and contributions
        |
        v
validate graph, references, readiness, and ownership
        |
        v
atomically publish service and contribution snapshots
        |
        v
route new work to the candidate
        |
        v
dispose replaced activation and its leases
```

If any candidate step fails, the public snapshot and old activation remain
unchanged. A plugin deactivation removes access and presentation but does not
silently destroy host-owned PTYs or other durable resources.

## Cordis boundary

Shipctl will depend on Cordis through one adapter under
`core/frontend/runtime/cordis/`. Feature plugins use supported public Cordis
concepts, but host reconciliation does not spread direct Cordis internals
through `AppShell`, workspace, or platform clients.

The inspected local source is Cordis `4.0.0-rc.8` at commit
`8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4`. Its README states that the API is
not stable. Implementation must pin an exact source revision and keep
Shipctl-specific activation state outside Cordis private fields. DeepSeek
Harness demonstrates explicit `new Context()`, `ctx.plugin(...)`, injected
services, effect-owned cleanup, and test harness composition. It is an
inspiration, not a package dependency or authority for Shipctl semantics.

## Trust boundary

The initial supported plugin tier is reviewed same-realm code running in the
main webview. Import gates,
service injection, effective grants, and native authorization form a strong
architectural boundary. They are not hostile-code containment because the
plugin shares the webview DOM and JavaScript realm.

Untrusted plugins require a separate Worker, sandboxed frame, unprivileged
webview, or extension-host process. A separate TypeScript realm is also needed
if headless work must survive main-webview loss or must not share its event
loop. The public semantic API is designed so a later broker can preserve
contracts across those placement changes.
