# Final host-boundary architecture audit

Date: 2026-08-07

**Mode:** Architecture Audit

**Scope:** frontend and native host composition, module packages, manifests,
permissions, disabled profiles, and plug-out gates

**Health Score:** 99/100

**Trend:** First run — no trend data

The migration reached the intended compile-time modular-monolith shape. The
host owns application infrastructure and explicit composition; capability
behavior is owned by vertical modules with no sibling imports.

## Module Dependency Graph

```mermaid
graph TD
  subgraph FrontendHost[Frontend host]
    AppShell[AppShell and generic surfaces]
    FrontendComposition[enabledModules composition root]
    FrontendPorts[moduleHostServices]
  end

  subgraph SharedContracts[Stable contracts]
    FrontendAPI[@shep/module-api]
    BackendAPI[shep-module-api]
  end

  subgraph CapabilityModules[Vertical capability modules]
    FrontendModules[Todos, Ports, Skills, Git, Commands, Assistants, Usage frontends]
    NativeModules[Todos, Ports, Skills, Git, Assistants, Usage Tauri plugins]
  end

  subgraph NativeHost[Native host]
    NativeComposition[enabled_modules composition root]
    CoreAuthorities[Projects, workspace, lifecycle, PTY, settings authorities]
  end

  AppShell --> FrontendPorts
  AppShell --> FrontendAPI
  FrontendComposition --> FrontendModules
  FrontendModules --> FrontendAPI
  NativeComposition --> NativeModules
  NativeModules --> BackendAPI
  NativeComposition --> CoreAuthorities
  NativeModules --> CoreAuthorities

  classDef clean fill:#51cf66,stroke:#2b8a3e,color:#fff
  class AppShell,FrontendComposition,FrontendPorts clean
  class FrontendAPI,BackendAPI,FrontendModules,NativeModules clean
  class NativeComposition,CoreAuthorities clean
```

There are no sibling-module edges and no dependency cycles in the module
graph. The only host-to-module edges originate in the two composition roots.

## Findings

### 🟢 Suggestion

<!-- markdownlint-disable MD036 -->

**Cognitive Overload — the generic project watcher retains Git-era names**

Symptom: the host-owned filesystem watcher is still named `GitWatcher` and
emits `git-fs-changed`, although the event is now generic project lifecycle
infrastructure consumed by enabled modules.

Source: Domain-Driven Design — Ubiquitous Language.

Consequence: a future maintainer may incorrectly move the watcher into the Git
module or treat its event as Git-specific, weakening the generic lifecycle
boundary.

Remedy: rename the Rust type and event after an explicit compatibility window;
keep behavior and subscriptions unchanged during that mechanical migration.

<!-- markdownlint-enable MD036 -->

## Summary

No critical or warning-level architecture decay remains in the migration
boundary. The final audit corrected profile drift and removed Pi configuration
from the flat native command surface; the remaining watcher name is a small,
documented vocabulary mismatch rather than hidden capability logic.

## Final ownership inventory

<!-- markdownlint-disable MD013 -->

| Area | Owner | Boundary evidence |
| --- | --- | --- |
| Window/app lifecycle, menus, updates, quit policy | Core | `src-tauri/src/lib.rs`, `menu.rs` |
| Projects, groups, workspace state, path authorization | Core | `workspace/`, flat core commands |
| Panel placement and unavailable-module recovery | Core | generic registry, tabs, persistence fixtures |
| PTY and terminal presentation | Core infrastructure | narrow terminal authority/session ports |
| Settings persistence and secure OS authority | Core primitives | narrow module host-service adapters |
| Frontend module selection | Composition root | `src/core/modules/enabledModules.ts` only |
| Native module selection | Composition root | `src-tauri/src/enabled_modules.rs` plus Cargo features |
| Capability UI, DTOs, state, commands, permissions | Vertical module | `modules/<capability>/frontend` and `backend` |

<!-- markdownlint-enable MD013 -->

Commands remains frontend-only because it uses the generic project-data and
terminal-session ports and has no capability-specific native command surface.
The other native-capable modules are internal Tauri plugins with namespaced
commands and module-owned generated permissions.

## Closeout corrections

Two audit findings were fixed before scoring:

1. Older disabled profiles omitted modules introduced later in the migration.
   All six profiles now enable every non-target native module. A catalogue
   check compares Cargo defaults, permissions, package scripts, and profiles so
   this decision cannot silently drift again.
2. Pi configuration still used four root `invoke` commands. Those commands and
   DTOs now belong to the Assistant plugin namespace. The host exposes only a
   narrow `PiConfigAuthority`, retaining filesystem and macOS Keychain authority
   without granting the module a shell or arbitrary path access.

The live panel implementation contains no `legacyKind` or `source: legacy`
compatibility vocabulary. Historical migration records retain those terms as
evidence, as intended.

## Intentional host exceptions

- PTY remains core because Commands, Assistants, and ordinary terminals share
  process lifecycle, rendering, shutdown, and resource accounting.
- Project/workspace state remains core because registered-project identity and
  path authorization are application-wide security boundaries.
- `pi_config.rs` remains a feature-gated host authority implementation. Pi DTOs
  and Tauri commands are module-owned; the host file performs privileged local
  filesystem and Keychain operations only.
- The project watcher remains core because it broadcasts capability-neutral
  project filesystem lifecycle changes. Its Git-era name is the sole audit
  suggestion above.
- No typed inter-module registry exists because the inventory found no concrete
  cross-module Usage consumer. The reopening criteria are recorded in the
  information-flow decision.

## Testability and organizational fit

Native modules receive explicit authority traits rather than global state or a
generic shell. Frontend modules receive `ModuleHostServices`, and disposable
copies remove each package to prove the seam is real. This provides direct test
seams at process, project, settings, and lifecycle boundaries.

Team ownership information is not present in the repository, so no Conway's
Law mismatch is asserted. The physical vertical-module layout nevertheless
supports independent capability ownership without requiring cross-module
implementation edits.

## Gate record

The repeatable master gate is `pnpm verify:modular-monolith`; every subprocess
has a 15-minute timeout and each module matrix has a 60-minute timeout. It
covers the default build, host Rust tests, boundary and recovery fixtures, and
the enabled/disabled/source-absent matrix for the fixture and every extracted
capability. Final run evidence is added when the closeout gate completes.

The Phase 0 interactive checklist remains an operator gate because it changes
real project, terminal, provider, Keychain, and persisted workspace state. It
must be executed against an authorized isolated app before claiming that the
manual smoke contract passed.
