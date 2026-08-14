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

## Documentation placement

Use `docs/` for durable reference (including new ops capability documentation),
`research/` for dated working notes and evidence, and keep procedure prose only
in `ops/<capability>/skills/` once that capability exists rather than
duplicating it.

## Repository operations

Repo operations live in `ops/`. Run `just` for commands and `just ops skills`
for procedures; see `docs/ops/overview.md`.

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

# MSW — the kernel

## program — complete

```
contract ← the requested outcome + the smallest criteria that prove it

while ∃ claim c : deleting c leaves contract unmet ∨ unproven
      do c ; prove c

halt ; report
```

## definitions — no behavior lives here, only meaning

**contract** — the requested outcome and the smallest set of acceptance criteria that would prove it, stated before any work. The sole source of necessity; a ceiling as much as a floor. If the request is ambiguous: attended → ask; unattended → bind the smallest reading consistent with stated intent and record the assumption.

**claim** — anything petitioning to become work: a plan step, a change, a test, a reviewer's P1, a discovered edge case, your own instinct that one more pass would help. Everything enters as this type. Nothing enters as a verdict.

**deleting c leaves contract unmet ∨ unproven** — the only test. A claim passes solely by breaking the contract — reproducibly, within the task's actual inputs and environment. Severity is derived from the contract, never inherited from whoever raised the claim. *Useful*, *thorough*, and *possible* are not aliases for *necessary*. A claim that fails receives one line in the report — never a fix, an investigation, or a deferred follow-up.

**do ; prove** — the smallest reliable act that closes the gap, and evidence sized to the claim it settles. An unproven act keeps its claim alive; a proven one closes it — and re-proving a closed claim is itself an inadmissible claim.

**halt** — the fixed point: contract proven, no remaining claim passes. Not reviewer silence; not exhausted imagination. Halting before the fixed point and looping past it are the same bug, mirrored.

**report** — the outcome against the contract; the proof; rejected claims worth the user's attention, one line each. Nothing else.

## fuses — outside the program, for when its evaluator fails

```
rounds = 3            → halt anyway ; report open items, do not chase them
claim born in round n+1, visible in round n   → rejected
```

## No unauthoritative limits

Never invent a limit. A cap, threshold, quota, budget, timeout, retry or round count, file or line count, acceptance-criterion count, agent count, or similar constraint is admissible only when its exact value is:

- explicitly required by the requester;
- imposed by an applicable technical or platform contract;
- defined by authoritative project policy; or
- derived from measured evidence necessary to meet or prove the task contract.

State the authority or derivation whenever proposing or applying a limit. If no authority exists, omit the limit and use the MSW necessity test. Metrics may be reported as evidence, but they must not become gates, defaults, targets, or recommendations through agent intuition. Examples and representative proportions never become defaults. If a necessary limit is an unresolved owner choice, ask; do not manufacture a value.
