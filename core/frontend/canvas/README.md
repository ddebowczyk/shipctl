# Canvas adapters

`canvas/` is the renderer boundary for the main workspace stage. It is
host-owned composition code, not a feature module or a module API.

## Contract

`@shipctl/core/canvas/views` exports `CanvasHost`. Bootstrap selects one
adapter for the application lifetime, and the host supplies only an optional
semantic `WorkspaceCanvas`. The canvas contract contains no shell model,
callbacks, service bag, activation map, terminal inventory, or native port.

The trusted shell owns the standard frame: neutral navigation, tab, content,
and trailing regions; notices; global shortcuts; native-window attachment; and
runtime diagnostics. `shell/AppShell.tsx` composes that frame with the selected
adapter. `StandardWorkspaceNavigation`, `StandardWorkspaceTabs`, and the
standard frame receive semantic selection/actions rather than becoming a
canvas-state authority.

Adapters project the workspace document and translate only declared semantic
gestures. `WorkspaceViewHost` resolves admitted global surfaces and panels
through the accepted contribution runtime. `TerminalStage` reads its narrow
trusted presentation runtime directly. Neither path receives feature policy
through an adapter prop.

`runtime.canvasAdapter: standard` is the default standard renderer.
`runtime.canvasAdapter: layman` selects the experimental
`layman/LaymanCanvas.tsx`; selection remains immutable until restart so a live
terminal renderer is never hot-swapped. Persisted `legacy` selections migrate
one-way to `standard` during configuration resolution.

### Layman source

The proof adapter uses the approved GitHub source revision
`github:ddebowczyk/react-layman#8d0c41a0a52830f3072771af674d63d80215384e`.
That revision includes the generated `lib/` export required by Git installs,
an SSR-safe drag preview, and CAS conflict recovery with stale-result guards.
The canvas test guards this pin.

## Ownership

An adapter owns DOM placement and renderer-local interaction state. It may
select, close, move, split, or rename declared semantic workspace instances;
it must not start terminal registries, activate modules, load runtime modules,
call Tauri, read workspace persistence, or select the accepted plugin family.

Feature modules contribute definitions through `@shipctl/module-api`. They do
not import this directory. `CanvasSurfaceCatalog` remains host code in `host/`:
it validates accepted contribution ownership and target references, exposes
recoverable load failures, and is fixed for the accepted runtime snapshot.
The modularity checker rejects feature-module, Tauri, persistence, and
`shipctl.plugin-data` reaches from canvas code.

## Terminal rule

Every known terminal produces one mounted `TerminalStage` slot. Visibility is
only CSS presentation: it never attaches, detaches, or closes a terminal.
Slots are sorted by terminal ID and tab ID, while focus selects exactly one
visible slot. This retains live terminal renderers across semantic views,
and terminal tabs.

## Compatibility retirement

The legacy renderer and its chrome have been removed after the authorized
Phase H parity proof. `DELETE-H-LEGACY-CANVAS` retains the deletion inventory,
authorization, and replacement evidence: the standard adapter projects the
semantic workspace directly, while persisted legacy selection migrates to the
standard adapter.
