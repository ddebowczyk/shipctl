# Assistants frontend module

Date: 2026-08-07

## Outcome

The Assistant provider frontend is now owned by
`modules/assistants/frontend`. The host composes its public `assistantsModule`
entrypoint and otherwise sees only generic panel, terminal-session, notice, and
project-lifecycle contracts.

The module owns:

- the Claude, Codex, Antigravity, OpenCode, and Pi catalogue and launch flags;
- the launcher UI, model selection, availability checks, and Pi configuration;
- provider logos and assistant-specific terminal presentation;
- ordinary provider launch and managed Claude/Codex launch;
- Codex identity polling and bounded no-guess failure behavior;
- rename, project-placement, explicit-stop, natural-exit, and quick-exit policy;
- startup restore, retry/discard recovery actions, and startup warnings.

The deleted host files are the old launcher, sidebar provider constants, and Pi
configuration store. `AppShell` no longer lists or restores provider records,
and `usePty` no longer imports provider commands or knows capture/probation
timers.

## Managed terminal seam

Claude and Codex need a native prepare-and-spawn transaction before the host
can adopt the resulting PTY. The generic `launchManaged` port supports that
without exposing provider DTOs to core:

1. the module requests project placement, cwd, label, dimensions, opaque owner
   metadata, and presentation;
2. the host provides environment, terminal colors, and an output callback;
3. the module invokes its native compatibility command and returns only the
   native terminal ID plus updated opaque metadata and presentation;
4. the host attaches xterm, creates the generic module session and tab, then
   emits the normal started lifecycle event.

Ordinary providers use the existing generic launch path. PTY maps, output
buffering, xterm instances, terminal focus, and process termination remain host
infrastructure.

## Lifecycle ownership

Module activation subscribes to generic terminal lifecycle events. The module
recognizes its sessions through the `assistants:` owner prefix and validates its
own opaque metadata. It persists rename and placement before the host mutates
the tab, discards records before explicit stop, re-arms a resume that exits
during the five-second probation period, and discards an established naturally
exited session.

Startup restoration is attached to the module's `onProjectsChanged` callback.
It runs once after registered project paths are available. Missing projects and
resume failures remain recoverable through module-owned Retry and Discard
notice actions.

## Host compatibility still present

This slice intentionally continues to invoke the existing flat native Assistant
commands. The native registry, manifests, provider adapters, command
registration, and compatibility DTOs move in the next slice. Legacy tab fields
and bounded builtin panel adapters remain until the native cutover is complete;
the production panel registry already uses only module contributions.

Usage and terminal settings may independently contain provider names or logos.
They are separate capabilities, not imports from the Assistant module.

## Verification

The enabled profile is protected by module-level behavior tests and source
characterization covering provider flags, ordinary versus managed launch,
runtime subscription ownership, capture polling, resume, recovery, shutdown,
and manifest safety.

The disabled profile runs:

```sh
pnpm verify:assistants-frontend-disabled
```

It builds with `VITE_SHEP_ASSISTANTS_MODULE=disabled` and proves that the
launcher chunk, module IDs, and unique restore-policy messages are absent from
`dist`. Generic Claude/Codex help text and Usage branding are deliberately not
treated as Assistant-module leakage.

The safe stage gate is:

```sh
pnpm build
pnpm test:assistant-providers-characterization
pnpm test:module-composition
pnpm test:terminal-sessions
pnpm test:panels
pnpm test:global-surfaces
pnpm test:project-surfaces
pnpm build:module-fixture
pnpm verify:assistants-frontend-disabled
cargo test --manifest-path src-tauri/Cargo.toml
```

## Rollback

The frontend module slice changes no native persistence format. Reverting its
single commit restores the host launcher/orchestration while leaving existing
Assistant restore records unchanged.
