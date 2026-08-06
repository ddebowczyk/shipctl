# Current state and capability inventory

## Executive assessment

Shep is already organized by feature names in several places, but it is not an
independently composable module system. The best description is:

> A feature-oriented React/Tauri monolith with a few useful Rust module
> boundaries and a central composition root that knows every capability.

The current folders are valuable stepping stones. They do not yet provide
replaceability because feature types, stores, panel rendering, native wrappers,
command registration, startup effects, and permissions are composed through
closed, application-wide files.

## Current physical structure

```text
src/
  components/
    commands/ git/ layout/ ports/ session/ settings/
    shared/ sidebar/ terminal/ todos/ usage/
  hooks/
  lib/
  stores/

src-tauri/src/
  assistant_sessions/   # multi-file Rust subsystem
  pty/                  # multi-file Rust subsystem
  usage/                # multi-file Rust subsystem
  workspace/            # multi-file Rust subsystem
  commands.rs           # application-wide command facade
  fonts.rs git.rs menu.rs pi_config.rs skills.rs todos.rs watcher.rs
  lib.rs                # application-wide state, startup, lifecycle, handlers
```

There is one frontend package, one TypeScript project, one Vite build, one Rust
crate, and no Cargo workspace or frontend workspace. The root `package.json`
has build/dev scripts but no frontend test or architecture-check script.

## Measured concentration points

The following measurements came from the current checkout and are included to
show where modularization will buy leverage, not to claim that file length is
itself a design failure.

| File or area | Approximate size | Why it matters |
| --- | ---: | --- |
| `src/components/layout/AppShell.tsx` | 997 lines | UI composition, startup, project selection, tabs, PTYs, restore, menus, overlays, and feature switches. |
| `src/hooks/usePty.ts` | 722 lines | Terminal, command, assistant launch, output, activity, restore capture, and shutdown-facing behavior. |
| `src/lib/tauri.ts` | 492 lines | Flat frontend API for almost every native capability. |
| `src/lib/types.ts` | 524 lines | Global DTO/type catalogue, including closed panel unions. |
| `src-tauri/src/commands.rs` | 1,720 lines | Flat native command facade and unrelated helper logic. |
| `src-tauri/src/lib.rs` | one large handler list | Registers every native command and owns cross-capability startup effects. |
| `src-tauri/src/usage/` | about 5,825 lines | Largest existing subsystem; has internal files but is still composed globally. |

## Where adding one panel currently spreads

The panel model is a closed union:

```ts
type PanelTabKind = "git" | "commands" | "launcher" | "todos";
```

A new panel typically requires edits to several central files:

1. `src/lib/types.ts` for the union and defaults.
2. `src/lib/tabKindMeta.tsx` for label/icon/shortcut metadata.
3. `src/stores/useTerminalStore.ts` for tab creation and persistence behavior.
4. `src/components/layout/AppShell.tsx` for lazy import and conditional render.
5. `src/lib/tauri.ts`, `src-tauri/src/commands.rs`, and
   `src-tauri/src/lib.rs` when native access is needed.
6. Tauri capabilities when a plugin API is involved.

This is the main architectural obstacle to a detachable Beads experiment. The
host must first render a generic `PanelContribution` rather than switch on
feature names.

## Capability inventory

The target column is a design recommendation, not a statement that extraction
has already happened.

| Capability | Current frontend | Current native/backend | Boundary now | Recommended target |
| --- | --- | --- | --- | --- |
| App lifecycle and native window | `AppShell`, UI store | `lib.rs`, `menu.rs` | Cross-cutting host logic | **Core host**; expose lifecycle contributions, keep final authority in host. |
| Project registry and groups | repo/settings stores, Sidebar | `workspace/`, command wrappers | Reasonable Rust subsystem; UI spread | **Core project service** because every project-scoped module needs stable identity and path authorization. |
| Generic tabs and panel placement | terminal store, TabBar, Sidebar | none | Closed unions and feature switches | **Core panel/tab host** with open contribution registry. |
| Theme, design tokens, notices | theme/notice stores, shared components | notification plugin | Shared by all features | **Core UI services** exposed through narrow ports. |
| Terminal rendering and PTY | `TerminalView`, `usePty`, terminal settings | `pty/`, command wrappers | Strong runtime coupling, useful Rust boundary | **Core runtime service** initially; split orchestration from terminal contribution later. |
| Managed assistant sessions | SessionLauncher, `usePty`, assistant tab fields | `assistant_sessions/`, PTY integration | Good provider subsystem, coupled orchestration | **Assistant module family** over terminal/project ports; continuity provider adapters owned here. |
| Workspace commands | CommandsPanel, command store | workspace YAML plus PTY commands | UI module-like, execution coupled to PTY | **Project module** using terminal-launch port. |
| Git and file browser | GitPanel, tree/viewer/diff components, git stores | `git.rs`, `watcher.rs`, command wrappers | Strong feature identity, broad command API | **Vertical Git module**; watcher and diff sidebar contributions belong with it. |
| TODO Markdown browser | TodosPanel, todo store, Sidebar row | `todos.rs`, command wrappers | Small vertical feature | **Best first existing extraction** after panel registry. |
| Usage and quota reporting | UsagePanel, sidebar usage, usage stores | `usage/` plus startup ingest | Internally substantial, startup-coupled | **Usage module** with background-task lifecycle contribution; defer extraction. |
| Ports/process browser | PortsPanel, UI overlay | logic buried in `commands.rs` | Small feature, weak native boundary | **Global module**; useful second extraction candidate. |
| Skills management | skill store and settings UI | `skills.rs`, embedded skill docs | Feature-like but settings-coupled | **Project module** with settings contribution. |
| Pi provider configuration | SessionLauncher, Pi store/settings | `pi_config.rs` | Provider-specific concern leaks into generic launcher | **Pi assistant-provider module** or assistant submodule. |
| Fonts and terminal preferences | settings UI and terminal store | `fonts.rs`, workspace config | Cross-cutting service | **Core settings capability** with contribution slots for feature-specific settings. |
| Editor/Finder/URL actions | scattered UI actions | command helpers | Small host integrations | **Core platform ports**, not user-facing modules by themselves. |
| Updates/releases | update store/settings | updater/process plugins | App-level concern | **Core host service** with settings/status contribution. |
| Git diff summary side pane | layout shell and Git components | Git commands | Git feature rendered by core | Move into **Git module contribution** once side-pane slots exist. |
| Native menu/keybindings | AppShell listeners, keybinding store | `menu.rs`, Tauri events | Host-owned but feature names embedded | **Core command registry**; modules contribute actions/keybindings. |
| Activity/attention tracking | terminal store, Sidebar indicators | PTY output only | Terminal-derived approximation | **Terminal/assistant observation service** with typed events. |
| Development diagnostics | DevMemory | memory command | Small debug-only capability | **Dev-only module** or compile-time diagnostic contribution. |

## Existing useful module-like boundaries

### Strongest starting points

- `src-tauri/src/assistant_sessions/` owns durable provider-session identity and
  provider launch semantics separately from process-local PTY IDs.
- `src-tauri/src/pty/` owns PTY allocation, IO, process trees, and termination.
- `src-tauri/src/workspace/` separates configuration, loading, and mutation.
- `src-tauri/src/usage/` has internal data, ingest, provider, query, and type
  files.
- Feature component directories such as `components/git/` and
  `components/todos/` already provide useful UI cohesion.

### Why they are not yet detachable

- Rust subsystems are private modules of the same crate and their commands are
  re-exported through one `commands.rs` and one `generate_handler!` list.
- Feature React components import global Zustand stores and the flat Tauri API.
- `AppShell` owns feature startup, event listeners, panel selection, overlays,
  and rendering.
- Tab kinds and metadata are compile-time closed records in core files.
- There is no public module entrypoint or enforced import direction.
- Startup services cannot register themselves; `src-tauri/src/lib.rs` starts
  workspace migration, watchers, usage ingest, and menus directly.

## Coupling heat map

| Area | Coupling | Extraction risk | Reason |
| --- | --- | --- | --- |
| TODOs | Low to medium | Low | Narrow UI/native surface and project scope. |
| Ports | Low to medium | Low | Small, but native process logic must first leave `commands.rs`. |
| Skills | Medium | Low to medium | Project scoped, currently embedded in Settings. |
| Git | Medium to high | Medium | Multiple UI surfaces, watcher, side pane, project status. |
| Commands | High | Medium | Depends on workspace persistence and PTY orchestration. |
| Assistant providers | High | Medium to high | Depends on terminal lifecycle, restore, project placement, shutdown. |
| Usage | High | High | Large subsystem with startup ingestion and multiple surfaces. |
| Terminal/PTY | Very high | High | Foundational runtime used by commands and assistants. |
| Workspace/project config | Very high | High | Authority and persistence for almost every project-scoped capability. |

## Core problems to solve before broad extraction

1. Replace closed panel unions and render switches with a contribution registry.
2. Separate generic tab placement from feature-owned panel state.
3. Give modules stable project identity/path access without exposing the whole
   repo store.
4. Namespace frontend/native APIs by capability.
5. Move native feature commands into internal Tauri plugin crates with explicit
   permissions.
6. Add dependency checks that prove module isolation rather than merely showing
   feature-named folders.
7. Give lifecycle/background work an explicit registration contract so feature
   startup does not accumulate in `lib.rs` or `AppShell`.
