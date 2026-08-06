# Shep core and modules study

Date: 2026-08-06

## Outcome

Shep should evolve into a **compile-time modular monolith** with a shallow host,
vertical capability packages, explicit contribution contracts, and internal
Tauri plugins for native code. It should not begin with a runtime marketplace
or dynamically loaded third-party native code.

The first proving module should be a read-only, project-local Beads browser. All
Beads implementation code should live under `modules/beads/`; the only code
outside that directory should be generic module-host infrastructure and small,
declarative build-time enablement entries.

This direction gives Shep the properties needed for safe experimentation:

- a failed experiment can be disabled by removing one frontend contribution
  and one native feature/plugin enablement;
- capability state, UI, provider DTOs, tests, and native integration remain
  owned by one directory;
- the host knows about panels and project context, not about Beads, Git, TODOs,
  usage providers, or agent-specific data;
- native commands are namespaced and permissioned instead of extending one
  application-wide command list;
- current features can move gradually; no rewrite is required before the first
  experiment.

A later local-only mode may activate trusted TypeScript modules without
rebuilding the Tauri application. This does not change the initial
compile-time-module recommendation: the module contracts, lifecycle, teardown,
state ownership, and removal proof must exist before a runtime loader has a
safe unit to load. The immutable shell/supervisor retains native authority and
rollback; mutable TypeScript remains below the installed app's native
capability ceiling.

## Recommended decisions

| Question | Recommendation |
| --- | --- |
| Runtime plugins or compiled modules? | Compiled modules now; revisit runtime installation only after repeated demand. |
| First extension point | Project-scoped panel contributions. |
| First experimental module | Read-only Beads issue browser. |
| Native boundary | One internal Tauri plugin crate per native-capable module. |
| Frontend state | Module-owned state, normally keyed by project path. |
| Host access | Narrow ports: project context, panel host, notices, theme, lifecycle. |
| Beads integration | Invoke `bd` with fixed argv, `-C`, `--readonly`, and `--json`; never parse its database directly. |
| Beads row model | Use TanStack Table v9 inside the Beads frontend module, behind a module-local adapter. |
| Beads paging | Load a bounded catalogue, build its hierarchy, and page roots in module memory; load full details lazily. |
| First existing extraction | TODOs after the generic panel registry, then Ports or Skills. |
| Hardest capabilities to move | Terminal/PTY, assistant continuity, usage, and workspace configuration. |
| Future self-modification | Trusted local TypeScript module replacement behind an immutable shell/supervisor; no runtime native-code loading. |

## Study map

- [01-current-state-and-inventory.md](./01-current-state-and-inventory.md)
  maps current capability-like areas, physical boundaries, and coupling
  hotspots.
- [02-target-architecture.md](./02-target-architecture.md) defines the shallow
  core, module contracts, target directory layout, Tauri plugin boundary, and
  architecture rules.
- [03-beads-browser-module.md](./03-beads-browser-module.md) specifies the
  project-local Beads browser UX, DTOs, CLI adapter, paging strategy, security,
  and detachable package layout.
- [04-incremental-migration-plan.md](./04-incremental-migration-plan.md) gives a
  sequence of quick wins, extraction steps, verification gates, and explicit
  stop conditions.
- [05-evidence-and-decisions.md](./05-evidence-and-decisions.md) records the
  inspected files, commands, external documentation, assumptions, and rejected
  alternatives.
- [06-pi-self-modification-and-future-shep.md](./06-pi-self-modification-and-future-shep.md)
  distinguishes Pi's reloadable extensions from core replacement and maps a
  safe, local-only TypeScript self-modification path onto a thin Tauri shell.
- [07-phase-1-gate.md](./07-phase-1-gate.md) records the generic panel host's
  verified contract, deviations, rollback points, compatibility adapters, and
  interactive smoke evidence gap.

## Target dependency shape

```text
                    +----------------------+
                    |      Shep host       |
                    | lifecycle + layout   |
                    | project + panel host |
                    +----------+-----------+
                               |
                    stable contribution ports
                               |
       +-----------------------+-----------------------+
       |                       |                       |
+------+-------+       +-------+------+        +-------+------+
| beads module |       | git module   |        | todos module |
| React + Rust |       | React + Rust |        | React + Rust |
+------+-------+       +-------+------+        +-------+------+
       |                       |                       |
       +------------ no sibling-module imports -------+
```

The arrow points from a module to stable host contracts. The host imports only
each module's public contribution entrypoint. It must not import module stores,
provider DTOs, or internal components.

## What "plug-out" means

For the Beads experiment, removal is proven only when all of the following are
true:

1. Remove or disable the Beads entry in the module profile.
2. Disable its Cargo feature/internal Tauri plugin.
3. Remove `modules/beads/`.
4. Frontend type-check, Vite build, Rust tests, and Tauri build still pass.
5. No host file imports a Beads implementation symbol.
6. No persisted generic tab crashes because its provider panel is absent; it is
   ignored or replaced by a clear "module unavailable" recovery state.

Directory shape alone is not modularity. These dependency and removal checks
are the proof.
