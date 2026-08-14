# Shipctl — Claude Code Guidelines

## Project Overview
Shipctl is a Tauri v2 desktop app (Rust backend + React/TypeScript frontend) for managing AI coding assistant sessions, terminals, git workflows, and usage tracking.

## Tech Stack
- **Frontend**: React 19, TypeScript, Zustand (state management), xterm.js (terminal)
- **Backend**: Rust / Tauri v2
- **Build**: Vite, pnpm

## Project layout

- `core/frontend/<capability>/` owns host React, TypeScript, stores, styles, and
  assets by capability. Cross-capability imports use exported
  `@shipctl/core/<capability>` entrypoints. Read `core/frontend/README.md` first.
- `core/backend/src/<capability>/` owns native host logic and Tauri command
  implementations. Read `core/backend/README.md` first.
- `modules/<name>/` owns removable features. `module-api/` is the top-level
  shared host/module contract, not a feature: its frontend and native sources
  separate host-provided ports, module-provided contributions, and shared
  protocol values while retaining root compatibility exports. `modules/commands/`
  is frontend-only by design. Read `modules/README.md` first.
- `src/` contains only the Vite entry files.
- `src-tauri/` is the Tauri app-bundle shell because the crate using
  `tauri::generate_context!()` must sit beside `tauri.conf.json`; capability
  behavior does not belong there.
- Cargo uses the workspace-root `target/` directory, never
  `src-tauri/target/`.
- `ops/` owns repository operations; application code must not import it.
- `ops/repository/` owns the canonical map of root-level repository items.
  Run `just repository map` to navigate it and `just repository validate` to
  catch an unclassified root entry.

## Documentation placement

Use versioned `docs/` for durable reference. `docs/plans/` and `docs/ops/` are
ignored local working areas unless a file has been intentionally promoted;
`research/` is ignored dated evidence and working notes. Promote settled
findings into `docs/`, and keep procedure prose only in
`ops/<capability>/skills/` once that capability exists rather than duplicating
it.

## Repository operations

Repo operations live in `ops/`. Run `just` for commands and `just ops skills`
for procedures; see `ops/README.md`.

## React Patterns

### No useEffect for derived state or state sync
Avoid `useEffect` for synchronizing state or computing derived values. This is a core principle of the codebase.

**Instead of useEffect, prefer:**
- **Derived values**: Compute inline or with `useMemo` — don't store derived data in state
- **State resets on prop/state change**: Handle in the event handler that triggers the change, not in a reactive effect
- **Data fetching on user action**: Call fetch functions in click/event handlers, not in effects that watch state
- **Focusing elements**: Use `autoFocus` prop or ref callbacks
- **Conditional initialization**: Consolidate multiple "load if not loaded" effects into one

**Legitimate useEffect uses (keep these):**
- Setting up/tearing down event listeners (window, document, Tauri events)
- Managing intervals and timers
- Integrating with imperative external libraries (xterm.js, ResizeObserver)
- Syncing React state to external systems (DOM style properties, native window effects)
- One-time app initialization on mount

### State Management
- Keep Zustand stores with their owning capability under `core/frontend/`
- Access store state outside React with `useStore.getState()` — valid in event handlers
- Use stable empty arrays/objects as defaults to avoid infinite re-render loops with Zustand v5

### Error Handling
- Use `pushNotice()` from `useNoticeStore` for user-facing errors
- Use `getErrorMessage()` helper to extract error messages
- Only log to console in dev mode: `if (import.meta.env.DEV) console.error(...)`


# POLICIES AND INSTRUCTIONS FOR AI AGENTS

Below is obligatory reading for AI agents:

- `./ops/MSW.md` Guidance for AI agents so they operate in minimal sufficient work (MWS) mode