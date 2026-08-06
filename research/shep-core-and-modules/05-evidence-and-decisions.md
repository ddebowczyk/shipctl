# Evidence, decisions, and unresolved experiments

## Study method

The study used the current Shep worktree as the authority:

- `ast-grep outline` mapped React, store, PTY, assistant-session, and Rust module
  structure before reading implementation details;
- the existing QMD `shep` collection was refreshed and queried for current UI,
  persistence, assistant restore, and Beads documentation;
- targeted source reads traced panel creation/rendering, global stores, native
  IPC, Tauri startup, and provider/session boundaries;
- the installed `bd` CLI was queried only with read-only commands against real
  repositories;
- the local Beads source checkout was inspected for CLI constraints not obvious
  from JSON output;
- current official Tauri v2 documentation was checked for native plugin and
  capability behavior.

No application code was changed as part of this study. The deliverables are
architecture and experiment-design documents only.

## Current Shep evidence

| Evidence | Observation supported |
| --- | --- |
| `src/components/layout/AppShell.tsx` | Central composition root imports many stores, lazily imports feature panels, owns startup/restore/event behavior, and conditionally renders each panel kind. |
| `src/lib/types.ts` | `PanelTabKind` and `TabKind` are closed unions; panel defaults are a central record. |
| `src/lib/tabKindMeta.tsx` | Labels/icons/shortcuts are a central `Record<TabKind, ...>`. |
| `src/stores/useTerminalStore.ts` | Project-local tabs and generic panel operations depend on the closed panel kinds. |
| `src/lib/tauri.ts` | Frontend native bindings for unrelated capabilities share one flat file. |
| `src-tauri/src/commands.rs` | Native command wrappers and helper logic for unrelated capabilities share one large facade. |
| `src-tauri/src/lib.rs` | All managed state, startup effects, lifecycle behavior, plugins, and application commands are composed centrally. |
| `src-tauri/src/{assistant_sessions,pty,usage,workspace}/` | Useful internal Rust subsystem boundaries already exist. |
| `src/components/{git,todos,usage,...}/` | Feature-shaped UI directories exist, but state/native composition remain global. |
| `package.json`, `tsconfig.json` | One frontend package/project; no module workspace or architecture/test script. |
| `src-tauri/Cargo.toml` | One Rust crate; no workspace of independently packaged module crates. |
| `research/dev/ui/shep-ui-build-guide.md` | Existing UI guide confirms AppShell composition, tab model, Zustand state, Tauri bridge, and lazy panel structure. |
| `docs/plans/20260803-1117-agent-session-restore/implementation-plan.md` | Assistant continuity demonstrates a focused provider adapter and durable domain identity separated from PTY identity. |

The current worktree contained unrelated ongoing changes while this study was
written. They were inspected where relevant and not reset or overwritten.

## Beads evidence

### Inspected implementations and corpora

- Local source: `/Users/ddebowczyk/projects/_ext/_factory/beads`
- Source remote: `https://github.com/gastownhall/beads.git`
- Installed CLI: `bd 1.1.2` (Homebrew), schema version 1
- Read-only corpora:
  - `/Users/ddebowczyk/projects/_tools/xqueue`
  - `/Users/ddebowczyk/projects/_tools/xqa`
  - `/Users/ddebowczyk/projects/_tools/xfind`

### Verified CLI capabilities

The installed CLI provides:

- global `-C/--directory`, `--json`, and `--readonly` flags;
- `where --json` and `context --json` for workspace/provider detection;
- `count --json`, including grouping by status/type;
- `list --json` with status, type, priority, assignee, label, title, date, sort,
  parent, and top-level filters;
- `children <parent> --json`, an alias for listing all-status children;
- `show <id> --json`, with optional comments and dependents;
- `search` and `query` for future provider-backed large-corpus modes.

`bd list --offset` is explicitly documented and implemented as available only
under `--proxied-server` (`cmd/bd/list.go`). This is why the first module pages a
bounded normalized catalogue in memory.

### Real-corpus checks

On xqueue at the time of inspection:

```text
total issues:       134
closed:             129
open:                 5
top-level issues:    30
xqueue-57w children:  3
```

The `xqueue-57w.3` record confirmed the useful normalized fields: ID, title,
status, priority, issue type, parent, labels, dependency/dependent counts,
comments, and rich details. Parent-child and blocking dependencies must remain
semantically distinct.

### Representative read-only commands

```sh
bd version --json
bd --readonly -C /path/to/project context --json
bd --readonly -C /path/to/project count --by-status --json
bd --readonly -C /path/to/project list --all --no-parent --limit 0 --json
bd --readonly -C /path/to/project children <id> --json
bd --readonly -C /path/to/project show <id> --json
```

The production module intentionally adds a count/output cap even though
unlimited listing was useful during investigation.

## Tauri v2 evidence

The official [Tauri Plugin Development](https://v2.tauri.app/develop/plugins/)
guide states that a plugin can be a Cargo crate with optional JavaScript
bindings, own lifecycle hooks and managed state, register commands through its
own `invoke_handler`, and be installed through `Builder::plugin`.

Plugin frontend calls are namespaced as
`plugin:<plugin-name>|<command>`. Plugin commands are denied to the frontend by
default until corresponding permission files allow them. Permissions can also
define command/global scopes.

The official [Tauri Capabilities](https://v2.tauri.app/security/capabilities/)
guide defines capabilities as the grants/denials applied to selected windows or
webviews and recommends individual capability files. This makes internal Tauri
plugins a better native module seam than continuing to grow the application
handler list.

Important nuance: application commands registered directly on the app have
different default exposure behavior from plugin commands. Moving a command into
a plugin is therefore both packaging and a security-surface change that needs
an explicit permission test.

## TanStack Table v9 evidence

The [v9 announcement](https://tanstack.com/blog/tanstack-table-v9-taking-form)
describes an opt-in, tree-shakable feature model, granular state subscriptions,
custom features, and reusable table composition. Those properties fit a
detachable frontend module, but they do not replace Shep's module contracts.

The official [React expanding
guide](https://tanstack.com/table/beta/docs/framework/react/guide/expanding)
confirms the three mechanics central to the proposed Beads tree:

- hierarchical input through `getSubRows`;
- descendant-first filtering through `filterFromLeafRows`;
- keeping expanded children on their parent's page through
  `paginateExpandedRows: false`.

The [React pagination
guide](https://tanstack.com/table/beta/docs/framework/react/guide/pagination)
supports client-side pagination for thousands of records, consistent with the
bounded 5,000-summary MVP. Virtualization remains a separate concern.

Registry checks on 2026-08-06 found:

```text
npm view @tanstack/react-table dist-tags version --json
latest: 9.0.0
published: 2026-08-04T06:29:16.564Z
React peer dependency: >=18
```

Shep currently uses React 19.2 and has no TanStack Table dependency. The
official site still exposes some v9 documentation under `/beta/`, so source and
installed-package type checks remain part of the implementation spike.

## Decision record

### D1. Compiled modules before runtime plugins

**Decision:** build-time packages and features.

**Reason:** meets local experimentation/removal needs while preserving one
signed app and avoiding an unneeded installation/trust/version platform.

### D2. Generic panels are the first extension seam

**Decision:** replace closed panel kinds and AppShell feature switches first.

**Reason:** the Beads browser is naturally a project panel, and this is the
smallest seam that immediately removes feature-name knowledge from the host.

### D3. Modules are vertical and top-level

**Decision:** `modules/<capability>/{frontend,backend,fixtures}`.

**Reason:** co-locates all experimental implementation and makes ownership and
removal visible. Another folder under `src/components` would not isolate state,
IPC, permissions, or native logic.

### D4. Internal Tauri plugins own native module APIs

**Decision:** one namespaced internal plugin crate per native-capable module.

**Reason:** command namespacing, permissions, lifecycle/state hooks, crate
boundaries, and omission by Cargo feature all align with the desired module.

### D5. Beads is integrated through `bd`, not storage

**Decision:** fixed read-only JSON CLI adapter.

**Reason:** preserves provider authority across Dolt/storage/schema changes and
avoids corrupting or bypassing Beads behavior.

### D6. First paging is in-memory over a bounded catalogue

**Decision:** count, bounded list, normalize, page roots, render nested matches.

**Reason:** offset is not universally available; real corpora are currently
small; full hierarchy enables correct ancestor-preserving filters.

### D7. The experiment is read-only

**Decision:** browsing, filtering, details, refresh only.

**Reason:** validates product value and module architecture without introducing
authorization, conflict, confirmation, and audit semantics for mutations.

### D8. TODOs is the first existing extraction

**Decision:** extract TODOs after Beads/removal proof.

**Reason:** it is a real vertical slice with manageable coupling. Extracting
Git, Usage, Terminal, or Assistant continuity first would mix architecture
learning with high-risk lifecycle behavior.

### D9. Explicit enablement before generated profiles

**Decision:** one frontend entry, native feature/plugin entry, and permission
grant during the experiment.

**Reason:** transparent and easy to review. Generate profiles only after a
second real distribution requires them.

### D10. Terminal and project authority remain core initially

**Decision:** expose narrow ports rather than immediately packaging foundations.

**Reason:** their current consumers reveal the contracts. Premature extraction
would either leak stores/commands or create speculative abstractions.

### D11. TanStack Table v9 is module-local, not core

**Decision:** use v9 for the Beads row model if a short spike passes the exact
hierarchy, filtering, paging, keyboard, and removal tests.

**Reason:** its built-in mechanics closely match the UI contract and avoid
reimplementing a mature headless table model. Keeping the dependency and its
types inside `modules/beads/frontend` contains release/API risk and preserves a
clean plug-out path.

**Constraint:** do not use TanStack Store as the provider/domain store, expose
TanStack types through `modules/api`, or create custom table features before a
second table demonstrates reuse.

### D12. Future self-modification stops at the native capability ceiling

**Decision:** permit a future local-only lane for trusted TypeScript product
shell, feature-module, and agent-harness replacement behind an immutable
Tauri/bootstrap supervisor. Do not dynamically load native code.

**Reason:** Pi demonstrates that direct TypeScript loading, explicit
shutdown/start lifecycle, durable state, and stale-context invalidation can
make agent-authored behavior reloadable without replacing the host process.
Shep can reproduce that outcome with staged browser-compatible bundles, but
Tauri commands, permissions, protocols, entitlements, and native primitives
remain properties of the installed application.

**Constraint:** compile-time modularization still comes first. A runtime loader
must not be built until modules have explicit activation/deactivation,
generation invalidation, state schemas, health checks, rollback, and safe mode.
The detailed evidence and proposed design are in
`06-pi-self-modification-and-future-shep.md`.

## Alternatives rejected for now

| Alternative | Why not now |
| --- | --- |
| Add `kind: "beads"` to current tab union | Fast UI result but deepens the central switch and leaves implementation spread globally. |
| Put all Beads React files in `src/components/beads` | Physical grouping without state/native/package isolation. |
| Generic `runCommand(command, args)` native API | Turns the module bridge into arbitrary process execution and leaks provider details. |
| Parse `.beads` database/files directly | Storage-mode and schema coupling; bypasses CLI behavior. |
| Runtime JavaScript-only plugins | Cannot safely encapsulate native Beads process access and still needs API/security/version policy. |
| Runtime native plugin loading | Signing, trust, compatibility, lifecycle, and crash-isolation cost far beyond current need. |
| Rewrite Shep into modules before Beads | High churn with no concrete contract customer. |
| Extract Terminal first | Foundational coupling forces Commands and Assistant migration together. |
| Use `bd list --offset` for paging | Fails outside proxied-server mode. |
| Fetch only roots forever | Simple paging but incomplete hierarchy-aware search/filter behavior. |
| Implement Beads writes immediately | Expands risk before usefulness and module isolation are proven. |

## Experiments still needed during implementation

These are not blockers for the architecture decision, but they should be
measured rather than guessed:

1. Catalogue latency and JSON size at 1,000 and 5,000 issues on direct and
   proxied Dolt modes.
2. Reasonable timeout/output caps on a cold Dolt startup.
3. Behavior when the CLI schema version is newer than the adapter supports.
4. Whether comments should be loaded through `show --include-comments` or a
   dedicated comments command in the installed Beads version.
5. Stable project identity: canonical path is sufficient for the first local
   experiment, but a durable opaque ID may be valuable if projects move.
6. Exact frontend test runner choice; Vitest is the natural Vite-aligned
   candidate, but the repository currently has no frontend test harness.
7. Whether split-pane and Markdown rendering recur enough to promote them into
   core UI primitives rather than remain module-local.
8. Whether a second build profile actually appears; only then invest in profile
   generation/consistency tooling.

## Study completion criteria

The requested study is complete when the document set contains:

- a current capability/module-like inventory;
- current coupling and packaging evidence;
- shallow-core and vertical-module architecture;
- frontend/native contracts and target file layout;
- a detachable project-local Beads browser UX and provider design;
- nested hierarchy, paging, filtering, and split-pane behavior;
- security, state, testing, and removal invariants;
- pragmatic quick wins and a staged migration path;
- explicit deferred/rejected complexity and remaining implementation
  experiments.
