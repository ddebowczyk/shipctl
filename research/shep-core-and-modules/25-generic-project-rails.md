# Generic project rails

Date: 2026-08-06

Beads task: `shep-3w1.8.3.2.1`

## Outcome

The host now has the three capability-neutral extension points required to
extract Git without teaching the shell about Git implementation details:

1. one optional project-facts provider;
2. ordered project-scoped layout contributions;
3. project actions that either run or open a lazy interactive surface.

The existing Git store and native calls have not moved. Temporary adapters keep
the current UI working while the following slices move ownership behind the
same stable contribution IDs.

## Contracts

### Project facts

`ProjectFactsProviderContribution` exposes only generic revision and lineage
metadata. The host resolves at most one provider, contains read, refresh, and
subscription failures, and treats a missing provider as `null` facts.

The current adapter maps:

| Git source | Generic fact |
| --- | --- |
| branch | revision label |
| dirty | revision state `changed` or `clean` |
| worktree parent | lineage parent label |

Snapshots are cached by source identity so React external-store reads remain
stable until the provider announces a change.

### Project layout

`ProjectLayoutContribution` targets an explicit slot and has deterministic
ordering. The first slot is `workspace.trailing`, currently occupied by the
diff-summary adapter. `AppShell` renders the slot generically and no longer
imports `DiffSummaryPanel`.

### Interactive project actions

`ProjectAction` is a typed union:

- command actions expose `run`;
- surface actions expose a lazy component loader.

An action group with a null label contributes directly to the project context
menu. This preserves the top-level Create Worktree item, while labeled groups
such as Agent Skills remain submenus. The generic host gives a surface only:

- the selected `ProjectRef`;
- its menu position and close callback;
- project registration and group-placement callbacks;
- existing narrow module host services.

It does not give a module access to repository stores, a generic dispatcher,
raw Tauri invocation, the shell, or the filesystem.

## Temporary Git adapters

`src/core/modules/builtinProjectAdapters.ts` owns the transition wiring:

| Stable ID | Adapter target |
| --- | --- |
| `git.project-facts` | current `useGitStore` |
| `git.diff-summary` | current `DiffSummaryProjectSurface` |
| `git.project-actions` | current Create Worktree action |
| `git.create-worktree` | current Create Worktree surface |

The adapter order preserves the existing project menu: Agent Skills precedes
Create Worktree. Passing empty built-in and module contribution arrays proves
that all three rails support disabled composition.

## Failure behavior

- Missing project facts return `null`.
- Facts provider read, refresh, and subscription failures do not escape.
- Surface rendering and lazy-load failures are contained by the shared module
  error boundary.
- One failed action contribution does not suppress sibling contributions.
- No contribution means no layout or action placeholder is rendered.

## Verification

`pnpm test:project-surfaces` protects provider singularity, ownership,
ordering, disabled composition, interactive action identity, failure
containment, and the temporary Git mapping. Existing Git characterization and
the production build remain the behavior regression gates.

## Next cutover

`shep-3w1.8.3.2.2` can now extract native Git policy without changing these
frontend contracts. `shep-3w1.8.3.2.3` will move the store/provider into the
Git module and migrate host consumers to generic facts. The temporary adapters
must be deleted when their module-owned replacements are composed; duplicate
facts providers are rejected rather than silently selected.
