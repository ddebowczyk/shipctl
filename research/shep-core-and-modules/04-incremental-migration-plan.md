# Incremental migration plan

## Strategy

Do not reorganize the entire repository before proving a useful seam. Add the
smallest extension seam, prove it with a disposable fixture, then extract
existing vertical capabilities one at a time. Every phase must leave Shep
buildable and preserve current behavior.

The roadmap separates three claims that are often conflated:

1. **Capability navigation:** code is easy to find by feature name.
2. **Encapsulation:** feature internals cannot be imported arbitrarily.
3. **Replaceability:** the feature can be disabled/removed and the application
   still builds and recovers persisted state.

The Phase 2 fixture proved level 3 for the package and composition rails. On
2026-08-06, the Beads viewer was moved to deferred standalone epic `shep-r2z`.
Its preserved stages below are no longer prerequisites for the migration. The
master critical path now starts with TODOs, the smallest existing vertical
capability that crosses frontend and native boundaries.

## Phase 0: freeze the evidence baseline

This study is the baseline. Before implementation, record current gates and a
small set of characterization scenarios:

- app starts and selects the last project;
- shell, assistant, Git, Commands, TODOs, Usage, Ports, Settings open;
- terminal tabs switch and move between projects;
- quit confirmation and assistant-session preservation work;
- frontend and native builds pass from the existing worktree.

Add automated tests only where they reduce migration risk. Do not attempt broad
coverage as a prerequisite.

**Exit evidence:** recorded commands/results and no unexplained baseline
failures.

## Phase 1: introduce a generic panel host

This is the highest-leverage quick win and should be behavior-preserving.

### Phase 1 changes

1. Add stable panel contribution and host-port types.
2. Add `ModuleRegistry` or initially `PanelRegistry` with duplicate-ID checks.
3. Replace `PanelTabKind` with generic panel tab data:

   ```ts
   { kind: "panel", panelId: "core.git", moduleId: "core", ... }
   ```

4. Replace `panelTabDefaults` and `tabKindMeta` panel records with registry
   lookups.
5. Replace panel-specific conditionals in `AppShell` with one `PanelHost`.
6. Register existing Git, Commands, Launcher, and TODO panels as built-in
   adapters without moving their implementation yet.
7. Add unavailable-panel recovery for persisted or disabled contributions.

### Current files likely touched

- `src/lib/types.ts`
- `src/lib/tabKindMeta.tsx`
- `src/stores/useTerminalStore.ts`
- `src/components/layout/AppShell.tsx`
- `src/components/layout/TabBar.tsx`
- new generic files under `src/core/modules/` and `src/core/panels/`

No Beads symbol should appear in these files.

### Phase 1 exit evidence

- all four existing panel kinds behave as before;
- adding a fixture panel requires only registration and its own files;
- duplicate IDs fail deterministically;
- unknown persisted panel IDs render recovery UI;
- an AST/text check finds no feature-name render switch in `AppShell`.

## Phase 2: establish package and native-plugin rails

### Frontend

1. Add `pnpm-workspace.yaml` for `modules/*/frontend`.
2. Create `modules/api/frontend` with contribution and host-port types.
3. Make React/React DOM peer dependencies for UI modules.
4. Add an explicit `enabledModules.ts` profile for the first build.
5. Add frontend boundary checks and one negative fixture.

### Native

1. Convert the repository to a Cargo workspace containing `src-tauri` and
   `modules/*/backend`.
2. Create a small `modules/api/backend` crate only for native host contracts
   that genuinely cross the boundary, initially registered-project
   authorization/resolution.
3. Add a fixture internal Tauri plugin with a namespaced test command and
   explicit permission.
4. Prove the default build and a build with the fixture feature disabled.

### Phase 2 exit evidence

- the app loads one fixture frontend module through its public entrypoint;
- one internal plugin command is invoked as `plugin:<name>|<command>`;
- denying its permission causes the expected rejection;
- modules cannot import application stores or private native modules;
- removing the fixture after disablement leaves both builds green.

## Deferred Beads stage 1: build the read-only native adapter

Keep this PR/backend slice useful without depending on finished UI.

### Deferred stage 1 work

1. Create the full `modules/beads/backend` package and fixtures.
2. Implement project authorization against registered Shep projects.
3. Implement detection/version/schema negotiation.
4. Implement bounded catalogue and issue-details commands.
5. Normalize provider JSON to module DTOs.
6. Enforce direct process invocation, `--readonly`, `--json`, timeouts, output
   limits, and structured errors.
7. Add Tauri command permissions and a build feature.

### Deferred stage 1 exit evidence

- fixture tests cover argv, normalization, stderr warnings, timeout, output
  limit, and schema mismatch;
- read-only integration against xqueue returns 134 issues and 30 roots;
- `xqueue-57w` has three children after normalization;
- no Beads command appears in root `commands.rs`, root `generate_handler!`, or
  global `src/lib/tauri.ts`;
- no mutation operation exists in the plugin command or permission surface.

## Deferred Beads stage 2: build the React module

### Deferred stage 2 work

1. Register `beads.browser` from `modules/beads/frontend/src/index.ts`.
2. Implement provider states and project-keyed module store.
3. Run the bounded TanStack Table v9 row-model spike described in
   `03-beads-browser-module.md`; keep it module-local only if its acceptance
   checks pass.
4. Build bounded catalogue normalization, hierarchy, root paging, filters, and
   selection behind the chosen module-local row-model adapter.
5. Build the resizable split-pane tree/details UI.
6. Add lazy details/comments and explicit refresh.
7. Add keyboard navigation and accessible labels/focus behavior.
8. Add pure hierarchy/filter/store tests.

### Deferred stage 2 exit evidence

- manual acceptance in `03-beads-browser-module.md` passes;
- the panel changes project context correctly without leaking state;
- filtering retains ancestors of matching descendants;
- root paging is stable while branches expand;
- no TanStack import escapes `modules/beads/frontend`;
- provider errors do not crash the host;
- AppShell and global stores contain no Beads state or conditionals.

## Deferred Beads stage 3: prove plug-out and make a product decision

Run the removal proof in a temporary branch or worktree:

1. Remove the Beads frontend profile entry.
2. Disable its native Cargo feature and permission grant.
3. Remove `modules/beads/`.
4. Run frontend type-check/build, module boundary tests, Rust tests, and Tauri
   build.
5. Start with a previously persisted `beads.browser` tab and verify the generic
   unavailable-module recovery.

Then make an explicit product decision:

- **Keep:** users find it useful, provider upgrades are manageable, and the
  module remains isolated.
- **Revise:** UX is useful but contract/performance needs another bounded
  iteration.
- **Remove:** delete the directory and enablement entries; do not leave dormant
  stores, commands, DTOs, or feature switches in core.

## Phase 3: extract the first existing capability

The architecture is not proven for existing code until one feature moves.

### Recommended first extraction: TODOs

TODOs is a good proof because it crosses UI, state, project context, native
commands, and settings but does not own PTY or application lifecycle.

Move:

```text
src/components/todos/
src/stores/useTodoStore.ts
src-tauri/src/todos.rs
TODO-specific command wrappers
TODO-specific Settings/sidebar contributions
```

into `modules/todos/` behind the same contracts used by Beads. Preserve current
behavior and data format.

### Second candidate: Ports or Skills

- Ports proves a global panel and extraction from `commands.rs`.
- Skills proves project scope plus a Settings contribution.

Do not extract Git first. Its panel, tree, watcher, sidebar status, diff pane,
and many commands make it a poor boundary-learning exercise.

### Phase 3 exit evidence

- no TODO implementation remains in global component/store/native directories;
- TODOs can be disabled and removed;
- the module API did not gain TODO-specific fields;
- TODO owns its UI, state, native implementation, client, permissions,
  fixtures, and capability-specific resources.

## Phase 4: move larger capabilities only when ports are stable

Suggested order:

1. Ports
2. Skills
3. Git and its watcher/diff contributions
4. Commands using a terminal-launch port
5. Assistant providers/continuity using terminal and lifecycle ports
6. Usage using background-task and sidebar/settings contribution ports

Workspace/project configuration and terminal/PTY should remain host services
until at least Commands and Assistant modules consume stable ports. Extracting
the foundation before its consumers are understood risks inventing the wrong
abstractions.

### Current Phase 4 status

Ports, Skills, Git, and Commands have completed characterization, extraction,
and enabled/disabled/source-absent gates. Commands validated the generic
project-data and terminal-session ports and removed its direct host UI/store
integration. Assistant providers/continuity and Usage are next; terminal/PTY
itself remains a host infrastructure service until those consumers establish
whether any further contract is needed.

## Suggested PR sequence

Keep changes reviewable and reversible:

| PR | Scope | Product behavior |
| --- | --- | --- |
| 1 | Generic panel registry and existing-panel adapters | No intended change. |
| 2 | pnpm/Cargo module rails, API contracts, fixture module, boundary gates | Dev-only fixture. |
| 3 | TODO characterization, extraction, and plug-out proof | No intended change. |
| 4 | Ports, then Skills | No intended change. |
| 5 | Git, then Commands | No intended change. |
| 6 | Assistant providers, then Usage | No intended change. |

The Beads native adapter, browser, and product gate form a separate deferred
PR sequence under `shep-r2z`.

Do not mix mechanical host-directory moves into these PRs.

## Build profiles and customization

For the first experiment, explicit enablement is enough:

```text
frontend: one entry in enabledModules.ts
native:   one optional Cargo feature/dependency and one plugin installation
security: one capability permission grant
```

After a second real distribution exists, add build profiles such as:

```text
default          terminal, assistants, git, commands, todos, usage
local-ddebowczyk default + beads
minimal          terminal + projects
```

Profiles should be source-controlled build inputs, not a runtime promise that
arbitrary native modules can be installed into an already signed app.

## Verification matrix

| Invariant | Fast check | Strong proof |
| --- | --- | --- |
| Host is feature-agnostic | Search/AST check for module feature names | Add/remove fixture module without editing host render logic. |
| Frontend imports obey boundaries | Import-rule test | Negative fixture fails and all real modules pass. |
| Native commands are isolated | Search root handler/bridge | Plugin command works only through namespaced invoke and permission. |
| Module has no hidden state leak | Search global stores/types | Disable/re-enable and state recovery tests. |
| Module is removable | Disabled-profile build | Delete module in temporary worktree and build/run. |
| Provider adapter is read-only | Assert argv/permissions | Integration against disposable fixture detects no mutation. |
| Beads hierarchy is correct | Fixture unit tests | Compare xqueue tree and details with `bd` CLI. |
| Paging/filtering is complete | Store tests | Manual root counts and ancestor-preserving filters. |

## Risks and controls

| Risk | Control |
| --- | --- |
| `modules/api` becomes a dumping ground | API review: only stable host concepts, no feature DTOs. |
| Modules bypass boundaries through global stores | Package import restrictions and no raw stores in `ModuleHost`. |
| Generic event bus hides dependencies | Prefer typed ports and contributions; add events only for observed cross-cutting facts. |
| Native plugin still executes arbitrary commands | Task-oriented command API and fixed argv builder. |
| Provider version drift | Version/schema negotiation, fixtures, unknown-value fallbacks. |
| Build flags drift between frontend and Rust | One checked build-profile definition once multiple profiles exist; until then, a verification script checks both explicit lists. |
| Disabled persisted tabs crash | Generic unavailable-module panel and versioned tab migration. |
| Extraction stalls in a half-moved state | One capability per PR, delete old path in same extraction PR, enforce no duplicate implementation. |
| Over-generalization delays value | Add extension points only when the current existing-capability extraction demonstrates a concrete need. |

## Things not to build yet

- runtime module download/install/update;
- a module marketplace;
- dynamic native-library loading;
- a general inter-module event bus;
- a service locator exposing all app stores;
- generated module profiles before a second profile exists;
- remote Beads access or direct Dolt/database access;
- Beads mutation commands;
- a broad `shared` or `common` package containing feature logic;
- a repository-wide directory move presented as modularization.

## Recommended immediate next action

Characterize and extract assistant providers/continuity through the proven
terminal-session and lifecycle contracts. Preserve provider-session restore
behavior, managed-assistant startup, model selection, tab movement, and quit
handling before deleting direct host branches. Then extract Usage behind its
own global-surface, background-refresh, and settings boundaries.
