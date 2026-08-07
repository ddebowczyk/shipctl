# Git capability characterization and seam

Date: 2026-08-06

Task: `shep-3w1.8.3.1`

## Outcome

Git is not only the Files panel. It currently supplies repository facts to
project ordering, tab and session labels, move-to-project menus, sidebar
status, worktree creation, and a right-side diff summary. It also owns 19 flat
native commands and shares a filesystem watcher with other modules.

The current behavior is protected by `pnpm test:git-characterization` before
runtime implementation moves. Native fixtures create synthetic repositories
under the system temporary directory. They contain no user workspace data and
cover unavailable, clean, dirty, detached, worktree, submodule, large-tree,
preview, diff, and command-failure behavior.

## Observable behavior

<!-- markdownlint-disable MD013 -->

| Behavior | Current contract | Evidence |
| --- | --- | --- |
| Non-repository | `git status` failure becomes a default `is_git_repo: false` snapshot with empty branch and zero counts. Other repository operations reject. The frontend silently preserves any previous status when refresh rejects. | Native and frontend characterization |
| Clean repository | A successful porcelain-v2 status yields `is_git_repo: true`, the branch name, clean state, zero change counts, upstream counts, and optional worktree parent. | Native characterization; `git.rs` |
| Dirty counts | Staged and unstaged states are counted independently. A file changed on both sides of the index appears twice in `changed_files`, once per area. Unmerged entries count as staged and unstaged. | Native characterization; porcelain-v2 parser |
| Large untracked tree | Status uses Git's default untracked collapsing, so 256 files under one new directory produce an untracked badge count of one. `changed_files --untracked-files=all` and the Files tree expose all 256. | Native characterization |
| Detached HEAD | Status reports the literal branch label `(detached)` while `current_branch` returns an empty string. Detached worktree entries have no branch. | Native characterization; `GitStatusRow.tsx` |
| Branches and push | Branch listing uses local refs. Switching and creation use `git switch`; push always targets `origin` with upstream tracking. Errors are returned from Git stderr. | `git.rs`; flat command/client inventory |
| Worktrees | Worktrees are listed in Git's porcelain order; the first entry is treated as main. Creating `feature/x` creates a new branch and sibling worktree at `.shep-worktrees/<repo>/feature-x`, then the UI registers it as a project and inherits the source project group. | Native characterization; `ProjectItem.tsx` |
| Worktree identity | A `.git` file marks a linked worktree. Status derives `worktree_parent` from `git-common-dir`; host project grouping and labels consume that Git-specific field directly. | Native characterization; `projectGrouping.ts`; `ProjectList.tsx` |
| Submodules | A tracked submodule is one gitlink path in the file list. Nested dirtiness appears as one modified parent entry. Selecting the gitlink in file mode fails because the working-tree path is a directory. | Native characterization |
| File listing | The Files tree contains tracked and untracked-not-ignored paths, sorted and deduplicated. Root `.env`, `.env.*`, and `.envrc` files are added even when ignored. | Native characterization; `list_files` |
| File preview | Working content comes from disk; staged and head content come from `git show`. Preview accepts UTF-8 only and rejects content over 200 KiB, binary content, missing files, and unknown source names. | Native characterization |
| Diff selection | The panel remembers a preferred staged, unstaged, or untracked area per file. Normal diffs compare index to working tree, staged diffs compare HEAD to index, and untracked files use `--no-index /dev/null`. | Native/frontend characterization; `GitPanel.tsx` |
| Diff summary | The right-side strip deduplicates paths in favor of unstaged or untracked changes, sorts by changed-line count, and opens the project Files singleton in diff mode. It renders only for a Git repository. | `DiffSummaryPanel.tsx`; production build |
| Status refresh | Project registration starts recursive watching and an initial batch refresh. Filesystem events debounce for 500 ms; a 60-second poll is the fallback. Store refreshes isolate failures and avoid replacing equal snapshots. | Frontend characterization; `useGitWatcher.ts`; `watcher.rs` |
| Panel state | Selection, expansion, search, viewer mode, preferred diff area, sidebar collapse, and per-file scroll are process-local and keyed by project path. They survive panel unmounts and project switches, but not an app restart. | Frontend characterization; `useGitPanelStore.ts` |
| Persisted tab | The Files tab itself persists through generic panel references. The current stable identity is `core.git`, with legacy `git` tab migration and generic unavailable-panel recovery. Module cutover must migrate this identity without losing saved tabs. | `panelPersistence.ts`; panel persistence tests |
| Project removal | Removal explicitly evicts only that project's Git status. Panel-state entries currently have no removal method and remain in process memory until app exit. | Frontend characterization; `AppShell.tsx`; `useGitPanelStore.ts` |

<!-- markdownlint-enable MD013 -->

## Current ownership map

### Git implementation that moves

- `src-tauri/src/git.rs`: Git command construction, DTOs, porcelain and
  numstat parsing, file visibility, preview limits, branch/worktree policy,
  mutations, and error mapping.
- Git wrappers in `src-tauri/src/commands.rs` and registrations in
  `src-tauri/src/lib.rs`.
- `src/lib/tauri.ts` Git invoke clients and Git DTOs in `src/lib/types.ts`.
- `src/stores/useGitStore.ts`: project-keyed repository status and failure
  containment.
- `src/stores/useGitPanelStore.ts`: process-local project panel state.
- `src/components/git/`: Files panel, file tree, preview/diff renderers, and
  diff-summary surface.
- `src/components/sidebar/GitStatusRow.tsx`: project navigation contribution.
- Git and diff-summary rules in `src/styles/globals.css`.
- Worktree creation policy and UI currently embedded in
  `src/components/sidebar/ProjectItem.tsx`.
- Git characterization tests, which move with the resulting frontend and
  backend packages.

### Host branches that become generic composition

- `src/core/modules/builtinPanelAdapters.ts` and
  `builtinPanelRuntime.tsx`: hard-coded `core.git` definition and loader.
- `src/components/layout/AppShell.tsx`: hard-coded diff-summary placement,
  direct status refresh, and direct cache eviction.
- `src/components/sidebar/ProjectList.tsx`: hard-coded Git navigation row and
  direct worktree-parent lookup.
- `src/components/layout/TabBar.tsx`, `Sidebar.tsx`, `AgentSessionList.tsx`,
  `TerminalItem.tsx`, and `AssistantButton.tsx`: direct Git-store reads for
  branch labels and project destination ordering.
- `src/lib/projectGrouping.ts` and `projectMoveMenu.tsx`: Git DTOs used as
  generic project metadata.
- `src/hooks/useGitWatcher.ts`: direct Git-store refresh mixed with generic
  module lifecycle dispatch.

These consumers need capability-neutral project facts and layout/action
contribution rails. They must not import the future Git store or DTOs.

### Host and infrastructure responsibilities that remain

- registered-project identity, canonical project-root authorization, project
  add/remove, grouping persistence, and active-project selection;
- panel placement, focus, tab persistence, unavailable-panel recovery,
  shortcuts, and icon rendering primitives;
- generic project navigation, project-action, project-overlay, and layout-slot
  placement;
- recursive project filesystem observation, debounce, fallback polling, and
  module lifecycle delivery;
- authorized native process execution and project-local path containment;
- notice rendering, theme primitives, terminal/PTY infrastructure, and app
  lifecycle.

The current `GitWatcher` and `git-fs-changed` names describe historical first
consumers, not correct ownership. The infrastructure must become
capability-neutral while preserving its event timing and filtering behavior.

## Required frontend contracts

<!-- markdownlint-disable MD013 -->

| Contract | Minimum authority exposed to Git |
| --- | --- |
| Project context | Active/registered project references plus add, group inheritance, switch, and removal lifecycle facts required by worktrees. |
| Panel host | Register and open the project-scoped Files singleton, preserve legacy-tab migration metadata, and recover saved references when disabled. |
| Project navigation | Contribute the branch/Files row, change/upstream badges, dirty indicator, and activation. |
| Project facts | Publish capability-neutral revision label, dirty state, and project-lineage label for host grouping, destination menus, and session titles. Absence must be valid. |
| Project action surface | Contribute Create Worktree and its module-owned input/preview surface while the host owns context-menu and overlay placement. |
| Layout slot | Contribute the project-scoped diff-summary strip without an `AppShell` Git branch. |
| Filesystem changes | Receive project-root change facts and project-list/removal lifecycle through existing generic dispatch. |
| Notices | Publish typed errors for file listing, preview, diff, and worktree failures. |

<!-- markdownlint-enable MD013 -->

Git owns the repository snapshot and every interpretation of branch,
worktree, dirty, change-area, or diff data. The host may consume only the
narrow generic project facts it needs for cross-capability layout.

## Required native boundary

Create `modules/git/backend` as an optional internal Tauri plugin. The plugin
owns repository DTOs, Git arguments, output parsing, preview/diff policy, and
all repository mutations. Commands are namespaced under `plugin:shep-git|...`
and receive explicit permissions.

The renderer must not continue supplying arbitrary trusted paths:

- the host resolves and authorizes an exact registered project root before the
  plugin executes Git;
- file operations accept only normalized relative paths, reject absolute and
  parent traversal, and prove containment under the authorized root;
- worktree creation validates the derived sibling destination and returns it
  to the host, which alone registers and groups the new project; and
- command execution uses argument vectors, never a shell string.

Current `file_contents` joins a renderer-provided file path without validating
that it is relative or contained, and every flat command accepts an arbitrary
renderer-provided repository path. Those are excess-authority defects to close
at the new boundary, not contracts to preserve.

## Current coupling and fidelity risks

- Git state is imported by eleven host/frontend files outside the Git
  component tree.
- Project ordering and move menus accept `Record<string, GitStatus>`, making a
  removable Git module a compile-time requirement.
- Worktree creation UI, notices, project registration, and group inheritance
  are fused in `ProjectItem`.
- The diff-summary layout slot is a hard-coded `AppShell` branch.
- The watcher is shared infrastructure but has Git-specific type/event names
  and `.git` path policy.
- Status and changed-file untracked counts deliberately differ for directory
  trees; extraction must preserve this unless a separate product change is
  approved.
- Submodule gitlinks appear selectable but cannot be previewed in working-file
  mode. Preserve the bounded error during extraction.
- `file_diff` returns stdout regardless of most exit statuses because
  `--no-index` uses exit code one for a normal difference. Error normalization
  must not erase valid untracked diffs.
- Panel selection state is not durable and is not evicted on project removal.
  Do not silently add persistence or cleanup while relocating it.
- `push_branch` assumes a remote named `origin`; provider discovery is outside
  this migration.

## Safe migration slices

The original migration task is now epic `shep-3w1.8.3.2` with four ordered,
build-green children:

1. `shep-3w1.8.3.2.1`: add generic project-facts, project-action-surface, and
   project layout-slot rails while current Git code remains the adapter.
2. `shep-3w1.8.3.2.2`: move native Git policy and tests into the optional
   internal plugin, authorize roots/files, and remove flat native wrappers.
3. `shep-3w1.8.3.2.3`: move DTOs, namespaced client, status/panel stores,
   lifecycle, and project-facts provider under the frontend module.
4. `shep-3w1.8.3.2.4`: move panels, navigation, diff-summary, worktree action,
   styles, and tests; migrate panel identity and delete every Git-specific host
   branch and compatibility adapter.

At no point may both old and new native paths own repository mutation.

## Verification contract

```sh
pnpm test:git-characterization
pnpm test:module-composition
pnpm test:project-actions
pnpm test:panels
pnpm check:module-boundaries
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

The final close gate must additionally prove enabled, runtime-disabled, and
physically source-absent builds through the reusable plug-out harness.
