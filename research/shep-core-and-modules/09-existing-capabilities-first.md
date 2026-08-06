# Existing capabilities first

Date: 2026-08-06

## Decision

Move the optional Beads viewer out of the modular-monolith migration critical
path. Preserve its complete backlog under deferred standalone epic `shep-r2z`.
Continue master epic `shep-3w1` by extracting Shep's existing capabilities.

No Beads implementation existed when this decision was made. Task
`shep-3w1.4.1` had only been claimed and inspected, so deferral required no
source rollback.

## Why the sequence changed

The proposed Beads module originally had two jobs: prove the module rails and
test whether a new vertical capability could be removed cleanly. Phase 2's
disposable TypeScript/Tauri fixture now proves registration, explicit native
permission, disabled composition, persisted-panel recovery, and physical
source deletion.

Building a new viewer next would test provider and product design before the
architecture had encapsulated any production capability. The more direct path
to the target shape is to move current behavior behind the proven rails.

## Revised critical path

1. TODOs: first existing vertical capability and the smallest frontend/native
   extraction.
2. Ports: bounded global capability over process/network infrastructure.
3. Skills: project-scoped UI and native filesystem capability.
4. Git: status, tree, viewer, diff, watcher, and related contributions.
5. Commands: project workflows over a host-owned terminal-launch port.
6. Assistant providers: Claude, Codex, Pi, continuity metadata, and provider
   launch policy over host-owned project, terminal, and lifecycle ports.
7. Usage: provider ingestion, persistence, background work, sidebar summary,
   settings, and details.
8. Final host audit and compatibility-vocabulary removal.

Projects/workspaces, application lifecycle, panel placement, settings
primitives, and terminal/PTY infrastructure remain host responsibilities unless
later extraction evidence supports a narrower boundary.

## Definition of fully isolated

An extracted capability is complete only when:

- its frontend UI, state, clients, tests, styles, icons, and other owned assets
  live under `modules/<capability>/frontend/`;
- its native implementation, DTOs, fixtures, permissions, and plugin setup live
  under `modules/<capability>/backend/`;
- the host imports only the module's public contribution entrypoint and stable
  host contracts;
- the module reaches shared authority through explicit project, terminal,
  lifecycle, settings, notice, theme, or platform ports rather than global
  stores or private host files;
- sibling modules do not import one another's implementations;
- flat legacy Tauri commands, global feature stores, render branches, and
  duplicate implementations are removed after cutover;
- enabled, disabled, and source-absent builds pass;
- persisted panels recover through the generic unavailable-panel path; and
- current user-visible behavior remains protected by characterization and smoke
  tests.

Directory movement alone does not satisfy this definition.

## Backlog mapping

- `shep-3w1.7` is now Phase 3, TODO as the first existing extraction.
- `shep-3w1.8` is now Phase 4, ordered extraction of Ports, Skills, Git,
  Commands, Assistant providers, and Usage followed by the final host audit.
- `shep-r2z` owns the deferred Beads native adapter, browser, plug-out proof,
  and keep/revise/remove decision.

The dependency graph makes `shep-3w1.7.1` the next executable task and leaves
the Beads branch deferred without cycles or hidden master-path blockers.
