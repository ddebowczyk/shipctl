# Shep

**A native terminal workspace for developers running projects, agents, and background tasks side by side.**

Shep gives each repo a dedicated workspace for terminals, AI coding agents, commands, and git-aware workflows. Instead of managing a pile of Terminal tabs, iTerm windows, and half-remembered shell commands, you open one app and work from a single place.

<p align="center">
  <img src="assets/shep.png" alt="Shep" width="200" />
</p>

## Why Shep

- Keep project terminals grouped by repo instead of spread across shell windows.
- Launch AI coding agents from the app with standard and auto-accept modes.
- Start common tasks quickly with saved commands and autostart behavior.
- See which sessions are running, stopped, or need attention without hunting for them.
- Automatically import existing git worktrees when you add a repo, and work in them from the same UI.

## What It Does

- **Project workspaces** for repos, tasks, agents, and terminal tabs
- **Assistant launcher** for Codex CLI, Claude Code, and Antigravity CLI
- **Git-aware project views** including discovered worktrees
- **Autostart tasks** for dev servers, watchers, and recurring commands
- **Status indicators** so crashed or noisy sessions are easy to spot
- **Usage tracking** for AI coding assistant costs across providers
- **In-app notices** for common failures instead of silent errors or browser alerts
- **Native macOS packaging** via Tauri

## Download

Download the latest `.dmg` from [GitHub Releases](https://github.com/stumptowndoug/shep/releases).

After downloading:

1. Open the `.dmg`
2. Drag `Shep.app` into `Applications`
3. Launch Shep

Note: the current release flow is aimed at small-group testing. If the app is unsigned or not notarized, macOS may show an extra security prompt on first launch.

## Requirements

For using Shep:

- macOS
- A local git repo to work from
- Any CLI agents you want to launch already installed on your machine

For building from source:

- Node.js 20+
- `pnpm`
- Rust via `rustup`
- Xcode Command Line Tools

## Getting Started

### 1. Add a repo

Open Shep and add a local repository from the sidebar.

### 2. Configure tasks

Shep stores project configuration under `<repo>/.shep/workspace.yml`.

Example:

```yaml
name: my-app
commands:
  - name: dev server
    command: npm run dev
    autostart: true
    env: {}
    cwd: null
  - name: tests
    command: npm test -- --watch
    autostart: false
    env: {}
    cwd: null
assistants: []
```

### 3. Open workspaces and sessions

Use the sidebar and tab bar to:

- open project terminals
- launch assistants
- create blank shells
- jump into git or commands views
- switch projects without manually rebuilding your terminal layout

### Global sidebar settings

Machine-wide preferences live in `~/.shep/config.yml`. Restart Shep after
editing the file manually. The sidebar accepts independent typography and width
settings without changing the main workspace or terminal font:

```yaml
sidebar:
  fontSize: 13
  fontFamily: "SF Pro Display, IBM Plex Sans, Segoe UI, sans-serif"
  width: 288
```

`fontSize` is constrained to 10–24px and `width` to 224–560px so an accidental
value cannot make the navigation unusable.

## Assistant Modes

Shep supports two session modes for supported coding agents:

| Mode | Purpose |
| --- | --- |
| `Standard` | Runs the agent in the current repo directory |
| `YOLO` | Runs the agent in the current repo directory with auto-accept when supported |

Worktrees are managed outside Shep. If you create one with git, adding the main repo or a worktree in Shep will automatically import the related entries Git already knows about, and you can use the same terminals, assistants, commands, and git UI there.

Supported today:

- Codex CLI
- Claude Code
- Antigravity CLI (`agy`)

### Assistant session restore

On a normal Shep quit, Claude Code and Codex tabs launched by Shep are stopped
and restored on the next launch with the provider's own resume command. Shep
keeps the original working directory, tab label, mode, and any project you moved
the tab to. A record saved while an app is running is not auto-resumed after a
crash, because Shep cannot safely assume the original provider process stopped.

- Closing an assistant tab or letting its CLI exit normally means it will not be
  restored.
- Claude sessions are assigned an ID before launch. Codex sessions are restored
  only when Shep can identify one new matching session without ambiguity; a live
  but ambiguous Codex tab stays unprotected rather than risking the wrong chat.
- If a saved session cannot be resumed or its placement project is unavailable,
  Shep leaves the record in place and shows a notice. It never substitutes a new
  conversation.
- Canceling the quit confirmation leaves terminals running and their restore
  records unchanged.
- The restore manifest stores session IDs and tab metadata only, never terminal
  output, prompts, credentials, command text, or PTY IDs.
- This does not modify your Claude or Codex global configuration or hooks.
- The restore adapters are verified with Claude Code 2.1.221 and Codex CLI
  0.146.0. If either CLI cannot start, Shep reports its detected version and
  suggests updating it or making it available on Shep's PATH.

Gemini CLI was removed from the launcher after Google deprecated it in favor of Antigravity CLI (consumer requests stop June 18, 2026). If you still use it (e.g. on an enterprise license), run `gemini` from any Shep terminal — historical Gemini usage stays visible in the usage panel.

## Build From Source

### Install dependencies

```bash
pnpm install
```

### Run in development

```bash
pnpm tauri dev
```

This starts the Vite frontend and the Tauri shell together.

### Create a production build

```bash
pnpm tauri build
```

### Build an unsigned Apple Silicon app (Mac Studio)

```bash
pnpm tauri build --target aarch64-apple-darwin --bundles app,dmg --no-sign
```

This writes an installable DMG to:

```text
target/aarch64-apple-darwin/release/bundle/dmg/*.dmg
```

Open the DMG and drag `shep.app` to Applications when you are ready to replace
an existing installation. It is intentionally unsigned, so macOS may require
an explicit confirmation the first time it opens.

### Archive local Mac Studio builds

```bash
pnpm build:local
```

This creates the unsigned Apple Silicon app and DMG, then copies both into an
ignored `builds/<timestamp>-.../` directory together with `build.json`. The
manifest records the source commit, whether the worktree was dirty, and
SHA-256 checksums. To archive the current Tauri output without rebuilding:

```bash
pnpm build:local -- --archive-only
```

### Create a debug-packaged build

```bash
pnpm tauri build --debug
```

Useful validation commands:

```bash
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
```

Build artifacts land here:

- App bundle: `target/release/bundle/macos/shep.app`
- DMG: `target/release/bundle/dmg/`

Debug artifacts land here:

- App bundle: `target/debug/bundle/macos/shep.app`
- DMG: `target/debug/bundle/dmg/`

## Project Structure

Shep is split into a host and a set of pluggable modules. Both halves are
organised by *capability* — a capability owns its logic, its state and its
assets in one directory — never by file kind.

```text
src/                    the Vite entry point, and nothing else (main.tsx)
index.html

core/frontend/          the host's own capabilities (package @shep/core)
  platform/               Tauri IPC bindings and the types they exchange
  shared/                 building blocks 2+ capabilities already use
  appearance/             themes, fonts, globals.css
  terminal/               PTY lifecycle, xterm views, terminal stores
  settings/               preferences no other capability owns
  projects/               repositories, groups, per-project settings
  host/                   module activation and composition
  shell/                  the app shell — the only place that composes
                          several capabilities into one screen
  README.md               where a new frontend file goes; read this first

core/backend/           the host's own capabilities in Rust (crate shep-core)
  src/workspace/          on-disk config schema and its manager
  src/{platform,appearance,terminal,projects,settings}/
                          one directory per capability, each with commands.rs
  README.md               where a new backend file goes

modules/                pluggable features, each removable from a build
  api/                    the host↔module contract (not itself a module)
  <name>/frontend/        workspace package @shep/module-<name>
  <name>/backend/         Tauri plugin crate

src-tauri/              the Tauri shell — no capability logic lives here
  src/lib.rs              builds the app and registers every handler
  src/lifecycle.rs        shutdown, which spans several capabilities
  src/menu.rs             the native menu
  src/modules/            one adapter per module, behind its feature flag
  tauri.conf.json, capabilities/, icons/

profiles/               tauri configs that build with a module removed
scripts/                gates, plug-out verifiers, release tooling
```

Two rules hold this together, and both are checked in CI: a module may never
import the host, and the host reaches modules only through `@shep/module-api`
and `core/frontend/host/enabledModules.ts`. Every module can be built out
entirely — see `pnpm verify:<name>-plugout`.

## Tech Stack

- React 19
- TypeScript
- Zustand
- Vite
- xterm.js
- Rust
- Tauri 2

## Reporting Issues

For tester reports, include:

- Shep version
- macOS version
- whether the issue happened in dev mode or the packaged app
- the repo/workflow you were using
- anything visible in the terminal or notice UI

## Releases

Releases are built locally on macOS and published as a `.dmg` via GitHub Releases:

1. `./scripts/bump-version.sh X.Y.Z` — updates `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`, then commits the bump
2. `./scripts/release-build.sh` — builds, signs, notarizes, and generates `latest.json`
3. Smoke test the DMG, then `git tag vX.Y.Z && git push origin main vX.Y.Z`
4. `gh release create` with the artifacts and release notes

## License

MIT
