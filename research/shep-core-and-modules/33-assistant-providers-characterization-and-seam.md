# Assistant providers characterization and seam

## Outcome

Assistant provider behavior is now characterized before extraction. The safe
target is not to move PTY or xterm ownership into a feature module. The module
should own provider catalogue, launcher workflow, provider-specific launch and
resume policy, continuity records, capture polling, recovery notices, and its
own visual resources. Core should retain terminal processes, terminal tabs,
output delivery, dimensions, focus, and application exit authority.

The current code already has a useful native split: `assistant_sessions`
contains provider and durable-identity policy separately from `PtyManager`.
The remaining coupling is primarily orchestration in `usePty`, `AppShell`, the
built-in launcher adapter, flat Tauri commands, and host-owned provider assets.

## Protected behavior

<!-- markdownlint-disable MD013 -->

| Behavior | Current contract |
| --- | --- |
| Provider catalogue | Claude, Codex, Antigravity, OpenCode, and Pi are launched as local CLI processes; no provider SDK is involved. |
| Availability | Every configured executable is checked concurrently; an unavailable provider opens installation guidance and cannot be selected. |
| Models and modes | Claude, Codex, and Antigravity request runtime model lists; Pi and OpenCode skip that picker. Pi and OpenCode skip Standard/YOLO selection. |
| Ordinary launch | Antigravity, OpenCode, and Pi start through the normal PTY path and receive no restore record. |
| Durable launch | Claude and Codex persist a record before process creation. Spawn failure discards it. |
| Claude identity | Shep generates a UUID before launch, passes `--session-id`, then confirms that exact value. |
| Codex identity | Shep snapshots transcript paths before launch and accepts exactly one new `session_meta` record whose canonical cwd matches the launch directory. |
| Capture failure | Codex polling is bounded to 20 attempts at 500 ms. Ambiguity fails restore enablement rather than guessing. The live terminal remains usable. |
| Resume | Claude uses `--resume <id>`. Codex keeps root options before `resume <id>`. There is no fallback from failed resume to a fresh session. |
| Placement | Moving a tab changes its sidebar project while preserving the original launch directory. Rename and placement changes persist before UI mutation. |
| Quick exit | A restored provider that exits within five seconds is re-armed for a later retry. |
| Established exit | A naturally exited established provider loses its restore record because no live provider session remains to preserve. |
| Explicit close | Closing an assistant tab discards restore data, stops only its PTY, and removes the tab. |
| Normal quit | One final Codex capture runs, ready records are armed and frozen, and only then are PTYs signalled. Pending and failed identities are removed. |
| Startup recovery | Only armed, ready records restore. Missing placement projects and resume failures keep records and offer Retry or Discard. |
| Manifest | `~/.shep/assistant-sessions.json` contains explicit identity metadata, uses atomic replacement, and is restricted to user access. |

<!-- markdownlint-enable MD013 -->

Run the executable contract with:

```sh
pnpm test:assistant-providers-characterization
```

The TypeScript suite protects cross-layer orchestration and ownership. Existing
Rust tests protect provider argv, transcript identity parsing, ambiguity,
manifest safety, record state transitions, and shutdown ordering.

## Current ownership

Module candidates:

- `src/components/session/SessionLauncher.tsx`;
- provider catalogue and installation links in
  `src/components/sidebar/constants.ts`;
- provider-specific launch, resume, capture, and recovery orchestration now in
  `src/hooks/usePty.ts` and `src/components/layout/AppShell.tsx`;
- `src-tauri/src/assistant_sessions/`;
- assistant continuity command wrappers in `src-tauri/src/commands.rs`;
- provider logos needed by the launcher and provider-specific navigation.

Core responsibilities that stay in place:

- `PtyManager`, xterm instances, output batching, terminal dimensions, and
  platform process termination;
- generic terminal tab placement, focus, move, rename, and close mechanics;
- project registration and application quit confirmation;
- module composition, panel hosting, notices, and generic lifecycle ordering.

Usage currently reuses assistant logos. That is a resource dependency, not a
reason to couple Usage to the Assistant module. Usage must own the provider
branding it needs when it is extracted. Host tab chrome should consume generic
session presentation contributed at composition time and fall back to the
generic assistant glyph when the provider module is absent.

## Required host-contract evolution

The existing terminal-session rail is sufficient for Commands but not yet for
assistant continuity. Extend it only from observed needs:

1. request generic session presentation so a module-owned session can render as
   an assistant without exposing provider restore DTOs to core;
2. emit host-originated rename, placement, and stop events to the owning module;
3. preserve opaque owner metadata across those events;
4. add an ordered pre-shutdown module hook that completes before core signals
   PTYs;
5. keep the process command, PTY ID, xterm object, and provider record private
   to their respective owners.

The Assistant module can then call a namespaced native provider plugin to
prepare or resume an allowlisted provider session, and pass the resulting
command/argv to the generic terminal rail. It cleans up a prepared record if
terminal launch fails. Core does not learn Claude/Codex record schemas or
provider session IDs.

## Safe migration slices

1. Extend and characterize generic terminal presentation/events and ordered
   pre-shutdown lifecycle without changing current assistant callers.
2. Create `modules/assistants/frontend` and move catalogue, launcher, assets,
   provider runtime, startup restore, and recovery notices behind its public
   module entrypoint, initially using compatibility native calls.
3. Create `modules/assistants/backend` as an internal namespaced Tauri plugin;
   move registry, manifest, capture, and provider adapters there and remove the
   flat host command surface.
4. Remove host provider branches, DTOs, assets, launcher adapters, and restore
   orchestration after enabled and disabled builds pass.
5. Prove physical source absence while terminal, project, settings, Usage, and
   generic unavailable-panel behavior remain healthy.

Each slice must keep the app buildable. The native extraction must stage only
assistant-related hunks because `src-tauri/src/commands.rs` also contains
unrelated user work.

## Known limitations preserved, not expanded

- Only Claude and Codex are resumable today.
- Codex capture can safely associate only one new same-directory session.
- Provider activity remains PTY-output based; this extraction does not invent
  deeper provider SDK telemetry.
- Abnormal termination does not arm records because doing so could duplicate a
  provider process that survived the app.
- Native click-through and a real provider launch remain operator smoke items
  where macOS automation permission is unavailable.
