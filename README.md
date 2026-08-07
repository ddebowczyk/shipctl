# Shep

**A native macOS workspace for developers running projects, terminals, and AI coding agents side by side.**

Shep gives each repo one place for its terminals, coding assistants (Codex CLI,
Claude Code, Antigravity CLI), saved commands, git-aware views, and usage
tracking — instead of a pile of shell tabs and half-remembered commands.

<p align="center">
  <img src="assets/shep.png" alt="Shep" width="200" />
</p>

## This is a fork

This repository is a fork of [stumptowndoug/shep](https://github.com/stumptowndoug/shep).

We forked it because we needed a more modular codebase and a stronger ops
harness for fast-paced development: the host is split into capability-owned
frontend and backend directories, features live in removable modules, and
repository operations run through `ops/`.

**stumptowndoug continues to maintain the original, and it is likely the more
stable choice for users — see <https://shep.tools>.**

## Requirements

- macOS, and a local git repo to work from
- Any CLI agents you want to launch, already installed
- To build: Node.js 20+, `pnpm`, Rust 1.88+ via `rustup`, Xcode Command Line Tools

## Build and run

```bash
pnpm install
pnpm tauri dev      # dev
pnpm tauri build    # production bundle
```

Run `just` for repository commands and `just ops skills` for procedures; see
`docs/ops/overview.md`.

## Configuration

- Per project: `<repo>/.shep/workspace.yml`
- Machine-wide: `~/.shep/config.yml`

## Project structure

The host and its modules are organised by *capability* — each owns its logic,
state, and assets in one directory, never by file kind.

```text
core/frontend/   host capabilities (package @shep/core) — read its README first
core/backend/    host capabilities in Rust (crate shep-core)
modules/         pluggable features, each removable from a build
src-tauri/       the Tauri shell — no capability logic lives here
ops/             build, check, test, modularity, and upstream tooling
```

Two rules are enforced in CI: a module may never import the host, and the host
reaches modules only through `@shep/module-api` and
`core/frontend/host/enabledModules.ts`. Verify with
`just modularity plugout <name>`.

## License

MIT
