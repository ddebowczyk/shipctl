# Shep UI build guide

<!-- markdownlint-disable MD013 -->

Date: 2026-08-06  
Scope: how Shep's UI is composed, how it talks to the native backend, and how source becomes a runnable macOS app.

This guide is grounded in the current repository, especially [`package.json`](../../package.json), [`vite.config.ts`](../../vite.config.ts), [`src-tauri/tauri.conf.json`](../../src-tauri/tauri.conf.json), [`src/main.tsx`](../../src/main.tsx), [`src/components/layout/AppShell.tsx`](../../src/components/layout/AppShell.tsx), and [`src-tauri/src/lib.rs`](../../src-tauri/src/lib.rs).

## The mental model

Shep is a desktop application with a web UI:

```text
React + TypeScript + CSS
            │
            │ Vite compiles the frontend
            ▼
          dist/
            │
            │ Tauri loads dist/ into a macOS WebView
            ▼
       Shep window
            │
            │ Tauri IPC: invoke() and events/channels
            ▼
Rust/Tauri backend
  ├── PTYs and agent processes
  ├── Git and filesystem access
  ├── native menus and window lifecycle
  ├── usage ingestion
  └── persistence under ~/.shep and project/.shep
```

The frontend owns presentation and interactive state. The Rust side owns capabilities that a browser should not own: creating processes, attaching PTYs, reading local files, watching repositories, managing native menus, and controlling application shutdown.

## The technology stack

The main pieces are:

| Layer | Technology | Repository location |
| --- | --- | --- |
| UI | React 19 + TypeScript | `src/` |
| Bundler | Vite | `vite.config.ts`, `dist/` |
| Styling | Tailwind CSS v4 plus shared CSS variables | `src/styles/globals.css` |
| Client state | Zustand | `src/stores/` |
| Terminal emulator | xterm.js | `src/components/terminal/` |
| Desktop shell | Tauri 2 | `src-tauri/` |
| Native/backend code | Rust | `src-tauri/src/` |
| macOS runtime | Tauri's native WebView window | `src-tauri/tauri.conf.json` |

## How the React UI is composed

The root is deliberately small:

```text
src/main.tsx
  └── App.tsx
        └── AppShell.tsx
              ├── NoticeCenter
              ├── Sidebar
              ├── TabBar
              ├── terminal stage
              │     ├── TerminalView
              │     ├── GitPanel
              │     ├── CommandsPanel
              │     ├── TodosPanel
              │     └── global overlays
              └── DiffSummaryPanel
```

`AppShell` is the composition root. It connects stores, lifecycle hooks, native events, and child components, then decides which content is visible. It is the first place to read when trying to understand a cross-cutting UI behavior.

The main render path is:

1. [`src/main.tsx`](../../src/main.tsx) mounts React into the `#root` element from `index.html`.
2. [`src/App.tsx`](../../src/App.tsx) renders `AppShell`.
3. `AppShell` reads project, terminal, UI, Git, usage, and settings stores.
4. `Sidebar` and `TabBar` dispatch user actions.
5. `AppShell` selects the active project/tab and renders the corresponding terminal or panel.

Most panels are imported with `React.lazy()`. This keeps the initial UI smaller and makes Settings, Usage, Ports, Git, Commands, Launcher, and To-dos separate chunks that load when needed.

## Tabs, projects, and rendering

The terminal store keeps a tab collection for each project:

```text
projectState
  └── project path
        ├── tabs: UnifiedTab[]
        └── activeTabId
```

`UnifiedTab` covers terminal tabs, assistant tabs, and panel tabs such as Git, Commands, Launcher, and To-dos.

The selected tab is a combination of:

```text
activeProjectPath + activeTabId
```

For terminal tabs, Shep keeps the terminal component mounted and changes its visibility instead of destroying it. This preserves xterm scrollback, renderer state, and the connection to the PTY while the user switches tabs.

For panel tabs, `AppShell` renders the matching panel only when it is the active tab. Settings, Usage, and Ports are global overlays and temporarily cover the normal tab content.

This distinction matters when implementing navigation:

- changing `activeTabId` changes what the user sees;
- closing a tab must also stop or detach its PTY when applicable;
- moving a terminal/assistant tab between projects changes placement, but the underlying process and launch directory have separate semantics;
- changing a panel usually does not involve a PTY.

## State versus persistence

Not every visible UI value is stored in the same place.

### Runtime state

Zustand stores hold live state while Shep is running:

- active project and tab
- terminal/assistant tab objects
- PTY IDs
- overlay visibility
- notices
- Git status snapshots
- usage data currently loaded into the UI

This is application state, not automatically a durable layout file.

### Durable configuration

The Rust workspace loader stores global settings in:

```text
~/.shep/config.yml
```

This includes machine-wide settings such as themes, terminal preferences, sidebar settings, keybindings, project registry, and project groups.

Per-project workspace data lives at:

```text
<project>/.shep/workspace.yml
```

This is where project-specific workspace configuration such as commands is kept.

When editing these files manually, quit Shep first so the running app does not overwrite the manual change.

Assistant-session restore is a separate backend concern under `src-tauri/src/assistant_sessions/`. It stores provider-session metadata independently from the transient PTY IDs used by the frontend.

## The frontend-to-Rust boundary

Frontend code should not call Rust internals directly. The intended path is:

```text
React component/store
        │
        ▼
src/lib/tauri.ts
        │ invoke("command_name")
        ▼
src-tauri/src/commands.rs
        │
        ▼
focused Rust module
  ├── pty/
  ├── git.rs
  ├── workspace/
  ├── watcher.rs
  └── assistant_sessions/
```

The command must also be registered in `src-tauri/src/lib.rs` through `tauri::generate_handler!`.

### Example: terminal input and output

```text
Keyboard input
  → TerminalView
  → writePty() in src/lib/tauri.ts
  → write_pty in src-tauri/src/commands.rs
  → PtyManager/PtySession
  → child process

Child process output
  → PtySession reader
  → Tauri Channel<PtyOutput>
  → usePty hook
  → xterm.js Terminal
```

This is why a terminal feature often needs more care than a normal React feature. The visual terminal is in the WebView, but the actual shell or coding agent is a native child process outside the WebView.

### Example: native menu shortcut

For a shortcut that should work through the macOS application menu:

```text
menu.rs registers accelerator
        │
        ▼
Rust emits menu-event
        │
        ▼
AppShell listens for menu-event
        │
        ▼
Zustand action changes UI state
```

The Cmd+Tab implementation follows this pattern and also has a renderer-level keyboard fallback. Native macOS shortcuts can still be intercepted by the operating system; registration in Shep does not guarantee that macOS will deliver a system-reserved shortcut to the application.

## The build pipeline

### Install dependencies

```bash
pnpm install
```

Dependencies are declared in `package.json` and resolved by `pnpm-lock.yaml`.

### Build only the frontend

```bash
pnpm build
```

This runs:

```text
tsc
  → TypeScript validation
vite build
  → production JavaScript/CSS/assets in dist/
```

This checks and bundles the UI, but it does not create a `.app`.

### Run the desktop app during development

```bash
pnpm tauri dev
```

The Tauri configuration starts Vite at `http://localhost:5173`, compiles the Rust shell, and opens a native window pointed at the development server.

Use this for UI work because React changes are hot-reloaded. Rust changes, native menus, PTY code, and command registration require a Tauri/Rust restart or rebuild.

Running `pnpm dev` alone starts only Vite. It is useful for inspecting browser-renderable UI, but native Tauri commands and PTY behavior will not be representative.

### Build a packaged application

```bash
pnpm tauri build
```

`src-tauri/tauri.conf.json` points Tauri at `../dist` and declares `pnpm build` as `beforeBuildCommand`. Therefore the packaged build is:

```text
pnpm build
  → compile Rust
  → embed dist/ into Tauri
  → produce shep.app and bundle artifacts
```

Typical output locations are:

```text
target/release/bundle/macos/shep.app
target/release/bundle/dmg/
```

### Build an unsigned Apple Silicon app for the Mac Studio

```bash
pnpm tauri build \
  --target aarch64-apple-darwin \
  --bundles app,dmg \
  --no-sign
```

The DMG is installable by opening it and dragging `shep.app` to Applications. Because it is unsigned, macOS may show an additional security confirmation on first launch.

### Build and archive a local version

```bash
pnpm build:local
```

This builds the unsigned Apple Silicon app and DMG, then archives them under:

```text
builds/<timestamp>-aarch64-apple-darwin-g<commit>-<clean|dirty>/
```

The archive contains:

```text
shep.app
shep_<version>_aarch64.dmg
build.json
```

`build.json` records the version, target, source commit, dirty-worktree state, and SHA-256 checksums. To archive an already-created Tauri output without rebuilding:

```bash
pnpm build:local -- --archive-only
```

## How to implement a UI feature

Start by classifying the feature.

| Question | Likely location |
| --- | --- |
| Is it only visual? | Component TSX and `globals.css` |
| Does it change active tab/project state? | `useTerminalStore` or `useUIStore` |
| Does it need a native menu shortcut? | `src-tauri/src/menu.rs` plus `AppShell` event handling |
| Does it read/write files or Git? | `src/lib/tauri.ts` → `commands.rs` → Rust module |
| Does it create or stop processes? | `pty/`, assistant session code, and Tauri commands |
| Must it survive restart? | workspace/config loader and a persisted model |
| Does it need a live stream? | Tauri event or `Channel`, then a hook/store |

A safe implementation sequence is:

1. Find the state owner and existing action closest to the desired behavior.
2. Add or reuse a store action with a clear domain name.
3. Add the smallest component-level event handler.
4. Cross the Tauri boundary only if the feature truly needs native capabilities.
5. Register any new Rust command in `lib.rs`.
6. Run the frontend build and Rust checks.
7. Test with `pnpm tauri dev`.
8. Build `pnpm build:local` when testing the packaged application.

### Example: Cmd+Tab navigation

The implementation illustrates the intended layering:

```text
TabCycleDirection type
  → useTerminalStore.cycleTab()
  → AppShell cycleTabs()
  → menu-event from native menu
  → renderer keyboard fallback
```

The store owns the behavior: wraparound, current-project scoping, overlay deactivation, and attention-bell clearing. The shell owns input sources. The menu owns macOS accelerator registration.

## Verification checklist

For a normal UI change:

```bash
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

For Rust behavior with existing tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

For actual desktop behavior:

```bash
pnpm tauri dev
```

For the packaged Mac behavior:

```bash
pnpm build:local
open builds/<new-build-directory>/shep.app
```

Always test the newly built app. An already-running Shep process continues executing the older binary and cannot pick up source changes by itself.

## Common misunderstandings

### `pnpm build` is not a Mac build

It creates browser assets in `dist/`. The native `.app` appears only after Tauri compiles and bundles those assets.

### `dist/` is not the whole application

The UI bundle cannot create PTYs, inspect Git, or manage macOS windows by itself. Those operations cross into Rust through Tauri IPC.

### React state is not the same as workspace persistence

Changing a Zustand value changes the live window. It persists across restarts only if the feature explicitly saves it through the workspace/config layer.

### A packaged build is not automatically the running app

Building a new `.app` does not replace or restart an existing Shep process. Quit the old process and launch the new artifact explicitly.

### Native keyboard shortcuts have an OS boundary

Tauri can register an accelerator and the WebView can listen for `keydown`, but macOS may reserve some shortcuts before Shep sees them. This is especially relevant to Cmd+Tab, which normally switches applications.

## File map for UI work

```text
src/
├── main.tsx                    React entry point
├── App.tsx                     root component
├── components/layout/
│   ├── AppShell.tsx            composition root and global event wiring
│   ├── TabBar.tsx              tab presentation and tab gestures
│   └── ...
├── components/sidebar/         projects, groups, statuses, assistant rows
├── components/terminal/        xterm.js rendering and terminal themes
├── stores/                     Zustand runtime state
├── hooks/                      PTY, Git watcher, theme, and lifecycle hooks
├── lib/tauri.ts                typed frontend wrappers around Tauri IPC
├── lib/types.ts                shared frontend data types
└── styles/globals.css          global styles and design tokens

src-tauri/
├── tauri.conf.json             dev URL, frontend output, window, bundle config
└── src/
    ├── lib.rs                  Tauri setup, plugins, command registration
    ├── commands.rs             IPC command boundary
    ├── menu.rs                 native menus and accelerators
    ├── pty/                    shell/agent PTY lifecycle
    ├── git.rs                  Git operations
    ├── workspace/              config, project registry, persistence
    ├── assistant_sessions/     provider session capture and restore
    └── watcher.rs              filesystem/Git change events
```
