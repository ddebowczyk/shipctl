# Pi self-modification and a changeable TypeScript Shep

Date: 2026-08-06

## Executive answer

Pi demonstrates a useful form of self-modification, but the phrase needs a
precise meaning. Pi does **not** replace its running TUI or agent-core source in
place. It keeps a stable process, TUI, session, and extension host alive while
it reloads trusted TypeScript extensions and declarative resources around that
host.

A future Shep can use the same pattern with an intentionally thin, unchanged
Tauri shell:

- panels, commands, shortcuts, tools, provider adapters, orchestration, and most
  product UI can be changeable TypeScript modules;
- an agent can edit those modules, build a staged bundle, ask Shep to activate
  it, and continue in the same application;
- the TypeScript agent harness can also be replaceable if it runs behind an
  immutable supervisor and persists its session state outside the harness;
- no TypeScript change can add a Tauri command, permission, native plugin,
  custom protocol, entitlement, PTY primitive, or macOS integration that the
  installed shell did not already expose.

That last point is the **native capability ceiling**. A thin shell can expose a
broad, stable set of capabilities in advance, but it cannot become infinitely
extensible without either becoming an unsafe arbitrary-execution bridge or
being rebuilt when a genuinely new native capability is required.

The recommended target is therefore:

> An immutable native shell and tiny module supervisor, a replaceable
> TypeScript product shell, replaceable feature modules, and a replaceable
> TypeScript agent worker.

This is compatible with the current recommendation to build compile-time
modules first. Runtime self-modification is a later, local-only activation mode
for the same module contracts, not a marketplace or a runtime native-plugin
system.

## What Pi actually supports

### 1. Directly loaded TypeScript extensions

Pi discovers `.ts` and `.js` extensions from user, project, package, and
explicit paths. Its extension loader uses Jiti, disables Jiti's module cache,
and imports a default extension factory directly from source. The compiled Bun
binary exposes bundled Pi packages as virtual modules, so an external
extension can import the TUI, agent core, AI package, and coding-agent API
without those host packages being copied into the extension.

Relevant implementation:

- `packages/coding-agent/src/core/extensions/loader.ts:1-78` defines the
  TypeScript loader and virtual host modules;
- `loader.ts:436-464` creates Jiti with `moduleCache: false` and imports the
  extension factory;
- `loader.ts:490-515` creates a fresh extension record and awaits its factory.

This is genuine runtime code loading. It is not a rebuild of Pi itself.

### 2. Explicit reload, plus narrowly scoped automatic reload

`/reload` reloads settings and the resource catalogue, clears Pi's extension
cache, and resolves extensions, skills, prompts, and themes again. The
interactive UI refuses reload while the agent is streaming or compacting.

Pi also watches the active custom theme file and applies a valid edit
immediately. Extensions themselves are not generally watched and replaced on
every save; the user invokes `/reload`.

The lifecycle is:

```text
wait until agent is idle
  -> reset extension-owned UI
  -> emit session_shutdown(reason = reload)
  -> invalidate the old extension runner and contexts
  -> clear caches and load resources/extensions from disk
  -> build a new extension runner
  -> emit session_start(reason = reload)
  -> rebuild chat UI and extension bindings
```

Relevant implementation:

- `resource-loader.ts:387-455` clears and reloads the resource set;
- `agent-session.ts:2610-2634` replaces the extension runner while preserving
  the `AgentSession`;
- `interactive-mode.ts:5645-5735` gates and coordinates `/reload`;
- `theme/theme.ts:900-979` watches and transactionally applies theme-file
  changes, retaining the previous valid theme on malformed intermediate
  writes.

### 3. A rich host API makes extensions feel like TUI modification

Pi extensions can replace or augment substantial parts of the visible TUI:

- editor, header, and footer;
- widgets above or below the editor;
- focused custom components and overlays;
- status and working indicators;
- custom message, Markdown, entry, tool-call, and tool-result rendering;
- terminal input handlers, commands, and shortcuts.

They can also modify agent behavior by registering tools and providers and by
intercepting lifecycle, context, model, provider-request, message, turn, and
tool events. `ExtensionUIContext` and `ExtensionAPI` are the stable seam; the
extension does not patch private `InteractiveMode` fields.

This explains why Pi can plausibly tell an agent to “build the missing UI.” The
agent writes a normal extension against a large public surface, then `/reload`
activates it.

### 4. The agent harness is designed for composition

`@earendil-works/pi-agent-core` is a stateful TypeScript agent loop, separate
from the TUI. Its constructor accepts replaceable functions for streaming,
context transformation, tool-call hooks, next-turn preparation, and stopping
policy. The coding-agent SDK composes that core with a session manager,
resource loader, model runtime, tools, and extension runner.

This provides two modification levels:

1. Most behavior changes are extensions around the stable `Agent` instance.
2. A custom application can compose or replace more of the harness through the
   SDK and session/runtime factories.

The normal Pi `/reload` path uses level 1. It does not import a newly edited
`packages/agent/src/agent.ts` and swap the `Agent` class while a turn is
running.

### 5. Session state outlives extension instances

The session manager owns the transcript and supports custom append-only entries
specifically so extension state can be reconstructed after reload or restart.
On reload, Pi preserves the `AgentSession`, active tools, extension flag values,
and message history while replacing extension registrations. It explicitly
invalidates old contexts, including event-bus subscriptions, so asynchronous
work captured by old code cannot keep mutating the new runtime.

This is more important than hot loading itself. A reloader without stale-code
invalidation, cleanup, and durable state is only a memory-leak generator.

### 6. Pi core source changes still require restart or rebuild

Pi's repository development launcher runs the TypeScript CLI through `tsx`.
Editing core TUI or agent-harness source affects the next process invocation;
there is no source watcher that replaces the running `InteractiveMode`, TUI
renderer, or `Agent` class. Distributed Node builds compile to `dist`, and the
standalone binary is compiled with Bun.

Therefore Pi has three distinct development loops:

| Change | Activation |
| --- | --- |
| Active custom theme | Automatic file watch. |
| Extension, skill, prompt, settings, context | `/reload` in the same process and session. |
| TUI core, coding-agent core, agent core | Restart source launcher; rebuild packaged/binary distribution. |

Calling all three “self-modification” would overstate what the code supports.

## What Shep does today

Shep currently compiles one React/TypeScript application with Vite and embeds
the resulting `dist` directory in the Tauri application. Development points the
webview at Vite on port 5173, but production points at bundled frontend assets.
The production CSP allows scripts from the application itself; it does not
provide a local TypeScript source loader.

The Rust shell is also not yet thin:

- it owns application startup, quit policy, managed state, menu setup, Git
  watching, and usage ingestion;
- one `generate_handler!` list registers the application's native command
  surface;
- the frontend bridge exposes those commands through one application-wide
  TypeScript module;
- the main webview has the app's effective Tauri authority.

Consequences:

1. Editing installed `src/*.ts(x)` would have no effect; those source files are
   not what the production webview executes.
2. Vite hot-module replacement is a development feature, not a production
   module architecture.
3. Loading arbitrary JavaScript into the current main webview would also grant
   it access to the webview's native command surface. Tauri permissions are
   attached to windows/webviews, not to individual JavaScript modules.
4. Current Shep needs the compile-time modularization already proposed in this
   study before a runtime loader has clean contracts to load.

Tauri's current documentation confirms that `frontendDist` is the production
frontend input, CSP constrains script sources, and capabilities grant native
permissions to windows or webviews. Tauri's runtime authority checks the
calling origin and webview; it does not identify which imported ESM module made
the call.

## Feasibility by layer

| Layer | Future runtime changeability | Conditions |
| --- | --- | --- |
| Theme, layout data, prompts, skills | High | Validate data and reload it independently. |
| Commands, shortcuts, panels, renderers | High | Stable contribution API and activate/deactivate lifecycle. |
| Feature state and workflows | High | Module-owned versioned state and migrations. |
| Provider adapters and agent tools | High | Stable host services and secret/network policy. |
| Agent orchestration and harness policy | High | Run behind a supervisor; reload only at a safe point. |
| Product shell React UI | Medium to high | Make the visible shell a loadable module above a tiny bootstrap. |
| Module compiler/loader/supervisor | Low | This is the trusted recovery kernel; update with the app. |
| PTY implementation, native process APIs | None beyond pre-exposed API | Requires a shell update for a new primitive. |
| Tauri commands/plugins/permissions/CSP/protocols | None | Compiled/configured into the app. |
| macOS entitlements, signing, menu/window internals | None | Requires rebuilding and usually re-signing the app. |

“Core UI is TypeScript” therefore does not mean every byte of core can safely
replace itself. The smallest possible bootstrap must remain available to load,
validate, activate, and roll back the changeable product shell.

## Recommended future Shep shape

```text
unchanged installed application

  Rust/Tauri native shell
    window + lifecycle + PTY + storage + constrained process/native ports
    custom module-asset protocol or equivalent trusted bundle reader
                         |
                         v
  tiny TypeScript supervisor/bootstrap
    module catalogue + API negotiation + activation + rollback
    session/state ownership + capability facade + recovery UI
             |                           |
             v                           v
  replaceable product-shell module    replaceable agent worker
    layout, sidebar, tabs, commands     harness policy, tools, adapters
             |
             v
  replaceable feature modules
    git, todos, beads, usage, assistants, experiments
```

The immutable boundary consists of the Rust shell **and** the minimum
TypeScript supervisor needed to recover from a broken product-shell module.
The normal visible Shep shell can still be changeable TypeScript.

### Why the agent harness should be a worker

Replacing the harness in the same JavaScript realm that owns React makes
cleanup and failure recovery unnecessarily fragile. A worker or supervised
TypeScript sidecar provides:

- a clear message protocol;
- termination of stale timers, streams, and subscriptions;
- CPU isolation from rendering;
- a safe owner for provider/event-loop logic;
- replacement without unmounting the whole UI.

A browser worker is sufficient for a web-compatible harness. A TypeScript
Node/Bun sidecar is more appropriate if the harness needs Node libraries,
direct filesystem/process access, or providers that are awkward under browser
CORS. The sidecar executable and its launch protocol must be bundled/exposed by
the native shell in advance, even if the harness modules it loads remain
editable TypeScript.

### Production module format

Do not ask the production WebView to execute raw `.ts` or `.tsx`. Use source as
the editable artifact and a staged ESM bundle as the executable artifact:

```text
modules-src/shep.beads/**
  -> type-check and bundle
  -> modules-cache/shep.beads/<content-hash>/module.js
  -> validate manifest and API version
  -> activate content-hash
```

The native shell must provide, from its first compatible release, a way to
serve or read those local bundles under an allowed origin and CSP. One robust
choice is an app-owned custom protocol restricted to the module cache. ESM URLs
must include a content hash because imported modules are cached by URL.

React must remain a host singleton. Runtime bundles should externalize React,
React DOM, and `@shep/module-api` to stable host-provided URLs rather than
shipping a second React copy.

## Safe self-edit and activation transaction

An agent-driven change should be a transaction, not “save and eval”:

1. The agent edits a module's source workspace, never the active bundle.
2. A builder type-checks, lints, and emits a content-addressed staged bundle.
3. The supervisor validates the manifest, module API version, contribution IDs,
   requested host capabilities, and duplicate registrations.
4. If the target is an agent harness, Shep waits for idle or explicitly aborts
   with user approval. UI-only modules may often reload immediately.
5. The old module receives `deactivate`; the supervisor disposes its
   subscriptions, timers, panels, workers, and event registrations.
6. Host-owned state is snapshotted. Module-owned persistent state has an
   explicit schema version.
7. The supervisor imports the content-hashed bundle and calls `activate` with a
   fresh context.
8. A bounded health check confirms registration and first render/worker reply.
9. Only then does Shep atomically update the active-version pointer.
10. On failure it disposes the candidate and reactivates the last known-good
    bundle, leaving the source change available for diagnosis.

As in Pi, every module context should carry a generation. Calling host actions
through a context from an inactive generation must fail clearly. Unsubscribing
from known events is insufficient because delayed promises may still resolve.

## Session continuity for a replaceable agent harness

The transcript and session identity must belong to the supervisor/session
service, not to the replaceable harness instance. A reloadable harness receives
a serializable snapshot such as:

```ts
interface AgentRuntimeSnapshot {
  schemaVersion: number;
  sessionId: string;
  projectId: string;
  messages: readonly PersistedMessage[];
  model: ModelRef | null;
  thinkingLevel: string | null;
  queuedInputs: readonly PersistedInput[];
  moduleState: Record<string, unknown>;
}
```

Streaming provider handles, abort controllers, promises, open file descriptors,
and JavaScript closures are not restorable state. Reload should normally occur
only after the turn settles. If a force reload is necessary, abort and persist
an explicit interrupted-turn marker so the new harness can decide whether to
continue or ask the user.

This gives Shep stronger continuity than merely keeping a React component
mounted. The old worker can die completely while the conversation survives.

## The native capability ceiling

The unchanged Tauri shell can support any future TypeScript behavior composed
from capabilities it already exposes. Examples:

- render arbitrary module panels and manage tabs;
- read and persist module state through a namespaced store;
- operate existing PTYs and managed assistant sessions;
- run approved task-oriented project operations;
- observe pre-exposed process/activity information;
- use existing notifications, dialogs, window actions, and updates.

It cannot support, without a new app build:

- a newly invented Tauri command or native plugin;
- a new filesystem/process scope not represented by the installed policy;
- a new URL protocol or CSP source;
- new macOS entitlements, Accessibility access, global shortcuts, menu/native
  window behavior, or bundled sidecar;
- changes to PTY allocation, process-tree ownership, shutdown semantics, or
  secure storage internals.

Avoid solving this with `invoke("run_any_command", ...)` or unrestricted file
access. That would make the native shell technically universal by discarding
the authority boundary. A local trusted extension system can be permissive, but
it should remain auditable and task-oriented.

## Trust and failure isolation

Pi's project trust is an input-loading guard, not a sandbox; extensions run with
the user's full process permissions. Shep should copy the explicit trust
decision but improve the authority story where practical:

- runtime code is local-only and disabled by default;
- user modules and project modules have separate trust decisions;
- the active bundle hash and source provenance are visible;
- activation shows new or changed requested capabilities;
- project modules cannot activate before project trust is resolved;
- host APIs use namespaced state and project authorization;
- failures are contained by error boundaries and workers where possible;
- a safe-mode launch skips all mutable modules and restores the built-in
  recovery shell.

Code loaded into the same main webview ultimately shares that webview's Tauri
authority. Host API conventions are useful engineering boundaries but are not
a security sandbox against malicious same-realm code. Stronger isolation needs
another webview/process and a mediated protocol.

## Recommended sequence

### Phase A: preserve the current modular-monolith plan

Build the compile-time `ShepModule`, contribution registry, narrow host ports,
module-owned state, activation/deactivation lifecycle, and removal tests. The
Beads browser remains a good first customer.

### Phase B: prove local reload without source compilation in the app

Load one already-built local ESM module by content hash in a development-only
profile. Add generation invalidation, duplicate-registration checks, teardown,
health checks, rollback, and safe mode.

### Phase C: add an editable-source pipeline

Add a local builder that emits staged bundles and manifests. Keep building
outside the main webview. Record diagnostics and activate only successful
artifacts.

### Phase D: make the visible product shell replaceable

Move the sidebar/layout/tab composition above the stable bootstrap into a
`shep.shell` module. Keep a minimal built-in recovery UI for selecting a last
known-good version or disabling mutable code.

### Phase E: move a TypeScript harness behind a supervisor

Define the serializable session/event/tool protocol, run the harness in a
worker or sidecar, and prove reload at idle with the same transcript. Do not
start by hot-swapping an active streaming turn.

## Decision

Future Shep should support **trusted local TypeScript module replacement**, not
general native self-modification.

The architectural invariant is:

> Mutable code may replace product behavior, but immutable code owns authority,
> state continuity, activation, invalidation, recovery, and rollback.

Pi validates the value of this boundary and supplies several implementation
patterns: direct TypeScript loading, a rich extension API, explicit idle-gated
reload, shutdown/start lifecycle events, persistent extension state, stale
context invalidation, and a stable host that remains alive. Shep must adapt
those patterns to the WebView's bundle/CSP model rather than assuming Pi's
Node/Bun loader can be copied into a browser.
