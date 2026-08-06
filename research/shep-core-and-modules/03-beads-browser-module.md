# Project-local Beads browser module

## Goal and scope

Build a project-scoped panel that lets a user inspect a repository's Beads
issues without leaving Shep:

- nested epics/tasks with recursive unfolding;
- root-level paging;
- filtering and search that preserve hierarchy;
- a resizable split view with the issue tree on the left and details on the
  right;
- explicit refresh and clear provider/error states;
- no writes in the first experiment;
- all Beads implementation code under `modules/beads/`.

The first version is a browser, not a second Beads client. Claiming, updating,
closing, dependency mutation, comments, daemon management, and database repair
are deliberately outside the experiment.

## Why the CLI is the provider contract

Shep should execute the installed `bd` CLI rather than read `.beads` storage:

- Beads currently supports multiple storage/runtime modes, including Dolt;
- `bd` owns workspace discovery, migrations, role behavior, hierarchy, and
  schema compatibility;
- the CLI exposes structured JSON and read-only mode;
- parsing internal tables would couple Shep to implementation details and could
  bypass Beads invariants.

The inspected local installation is `bd 1.1.2`, schema version 1, backed by
Dolt in the test repositories. The module must negotiate versions at runtime
rather than hard-code that exact release.

## User experience

### Entry point

Register one project-scoped panel contribution:

```text
panel ID:     beads.browser
module ID:    shep.beads
label:        Beads
singleton:    per-project
```

The panel should be available from the generic `+` menu and, later, optionally
from a project sidebar contribution. It is associated with the placement
project; switching to another project opens or reveals that project's own
instance and state.

### Layout

```text
+--------------------------------------------------------------------+
| Beads  xqueue        [Search...] [Status] [Type] [P] [Labels] [↻] |
+-----------------------------+--------------------------------------+
| 30 roots · 5 open           | xqueue-57w.3                 Open P1 |
|                             | Make architecture gates prove ...    |
| v ◉ P1 Epic  Modularization |                                      |
|   ├─ ● P1 Task Ownership    | Description                          |
|   ├─ ● P1 Task Composition  | ...                                  |
|   └─ ● P1 Task Gates        |                                      |
| > ○ P2 Epic  Release        | Design                               |
|   ...                       | ...                                  |
|                             |                                      |
| [<] Page 1 of 2 [>]  25/page| Dependencies · Dependents · Comments |
+-----------------------------+--------------------------------------+
```

- Default split: approximately 42% tree, 58% details.
- The divider is draggable and its width is stored per project by the module.
- The left pane has a minimum width sufficient for IDs and titles; the right
  pane can collapse on narrow windows into a details drawer.
- Root paging is independent of expansion. Expanding an epic does not move its
  descendants onto another page.
- Selecting a row updates details without changing expansion or scroll.
- Keyboard baseline: up/down selection, left collapse/parent, right
  expand/first child, Enter focus details, `/` focus search, `r` refresh when
  focus is not in an input.

### Row information

Each row displays only scan-worthy metadata:

- expansion chevron where a child relationship is known;
- status icon/color with a textual tooltip;
- `P0` through `P4` priority;
- issue type;
- ID and title;
- compact labels;
- assignee when present;
- blocking/dependency and comment counts when non-zero.

Do not use `dependent_count` as a child count. Parent-child is one dependency
type, while ordinary blockers/dependents have different semantics.

### Details pane

The details pane is loaded on demand and contains:

1. ID, title, status, priority, type, assignee/owner, labels, timestamps.
2. Description rendered as Markdown.
3. Design, acceptance criteria, and notes as separate sections when present.
4. Parent breadcrumb and children summary.
5. Blocking dependencies and dependents, displaying dependency type.
6. Comments loaded only when the user expands that section.
7. A copy-ID action and, optionally, "Open in terminal" that only copies or
   inserts a safe `bd show <id>` command into a user-controlled terminal. It
   must not create an arbitrary shell bridge.

For the first experiment, keep a small Markdown renderer in the Beads module or
promote a genuinely generic Markdown primitive into core. Do not import the Git
module's `MarkdownViewer` internal component.

## States that must be designed, not treated as exceptions

| State | UI behavior |
| --- | --- |
| `bd` unavailable | Explain that the CLI is not on Shep's PATH; show detected PATH diagnostics, no install mutation. |
| Project has no Beads workspace | Empty state: "No Beads workspace in this project" and a copyable `bd init` suggestion. Do not run it. |
| Unsupported schema/version | Show detected CLI/schema and supported range; disable issue operations. |
| Dolt/server unavailable | Preserve stderr summary and offer Retry; do not attempt database repair. |
| Empty filtered result | Keep filters visible with "Clear filters". |
| Issue disappeared after refresh | Clear stale details and explain that the issue no longer matches/exists. |
| Output too large | Ask the user to narrow filters; do not silently truncate and claim completeness. |
| Module disabled with persisted tab | Host shows generic unavailable-module recovery state. |

## Data loading and paging

### Constraint discovered in Beads

`bd list --offset` is only supported under `--proxied-server`. Direct/embedded
usage returns an error. Shep cannot base universal paging on CLI offset.

### Recommended first strategy: bounded catalogue snapshot

1. Run `bd count --json` to determine project scale.
2. Fetch a bounded structured catalogue with
   `bd list --all --limit <cap> --json`.
3. Normalize provider records into module DTOs.
4. Build `parentId -> children[]` and root arrays in module memory.
5. Apply filters and text search in module state.
6. Page **filtered roots** in memory; render descendants of roots on the current
   page according to expansion state.
7. Fetch full issue details with `bd show <id> --json` only after selection.

Use an explicit safety cap, initially 5,000 summary records and a native output
limit such as 16 MiB. If `bd count` exceeds the cap, ask the user to narrow a
provider-side filter or enter a later large-project mode. Never use `--limit 0`
without a guard in production merely because it worked for the inspected
repositories.

This strategy is simpler and more correct than root-only fetching for the first
version:

- hierarchy-aware filtering can retain ancestors of matching descendants;
- expansion does not create an N+1 command pattern;
- root paging remains deterministic;
- the inspected xqueue corpus is only 134 issues and 30 roots;
- it works in direct and proxied modes.

### Future large-project mode

If real projects exceed the cap, add an explicit provider-backed mode:

- `bd list --no-parent` for roots;
- `bd children <id> --json` on expansion;
- `bd search` or filtered `bd list` for matches;
- hydrate ancestors for matching descendants;
- grow `--limit` or require proxied mode before using `--offset`.

Do not implement this until a real corpus demonstrates the need. The DTOs and
module store should hide whether a catalogue came from one snapshot or lazy
provider calls.

### Filter semantics

The MVP toolbar supports:

- status, defaulting to active statuses with an "Include closed" toggle;
- issue type;
- priority;
- assignee;
- labels, with AND/OR choice only if users need both;
- title/ID/description text search over the normalized snapshot;
- sort by priority, updated time, created time, ID, title, type, or status.

Hierarchy-aware filtering uses these rules:

1. An issue is a direct match when it satisfies active filters.
2. A root/ancestor is retained when any descendant is a direct match.
3. Non-matching sibling branches remain hidden.
4. Ancestors needed to reveal a match are auto-expanded for the filtered view,
   without overwriting the user's normal expansion set.
5. Result counts distinguish direct matches from visible rows.

## Frontend row model: TanStack Table v9

Use TanStack Table v9 as the Beads module's headless row-model engine, subject
to a small implementation spike. It maps closely to the required behavior:

| Beads requirement | TanStack Table v9 mechanism |
| --- | --- |
| Nested epics/tasks | `getSubRows` plus the opt-in row-expanding feature. |
| Keep matching ancestors | `filterFromLeafRows: true`. |
| Keep descendants with their root page | `paginateExpandedRows: false`. |
| Search and field filters | Global and column filtering features. |
| Root paging | Row pagination over roots with expanded rows excluded from the page-size count. |
| Sorting | Opt-in row sorting with module-owned comparators for Beads enums. |
| Custom markup and keyboard behavior | Headless rendering; the module retains DOM and styling control. |

The package should live only in `modules/beads/frontend/package.json`, pinned to
an exact initially verified version. Keep all TanStack types and calls behind a
module-local `tableModel.ts` or `useBeadsTable.ts`; neither `modules/api` nor the
Shep host should import it. Removing Beads must remove the dependency from the
application graph.

Do not move provider, cache, or project state into TanStack Table. The
module-owned store remains responsible for `bd` loading, normalized records,
details, errors, refresh, and per-project state. TanStack Table owns or receives
only view state such as expansion, filters, sorting, pagination, and row
selection. Persist only the view fields that improve continuity.

Use only the required built-in features for the MVP. V9 supports custom table
features, but Beads-specific status semantics, keyboard commands, analytics,
and provider behavior should remain ordinary module composition until reuse
proves that a custom feature is justified.

Virtualization is not part of the first implementation. Root paging and the
5,000-record catalogue cap already bound rendered rows. TanStack Virtual can be
evaluated independently if a real expanded tree produces measurable DOM or
scrolling problems.

As verified on 2026-08-06, npm's `latest` tag resolves
`@tanstack/react-table` to `9.0.0`, published on 2026-08-04. Some official pages
still use `/beta/` URLs, so implementation must validate the installed package
API rather than copying stale snippets. Relevant primary sources:

- [TanStack Table v9 announcement](https://tanstack.com/blog/tanstack-table-v9-taking-form)
- [React expanding guide](https://tanstack.com/table/beta/docs/framework/react/guide/expanding)
- [React pagination guide](https://tanstack.com/table/beta/docs/framework/react/guide/pagination)

The spike passes when the existing hierarchy/filter/paging tests can be
implemented without duplicating a second row-model pipeline. If TanStack needs
Beads-specific patches or fights keyboard/tree semantics, keep the current pure
module model instead; the native provider contracts and UI design do not
depend on this choice.

## Module-owned contracts

Provider values that can evolve should remain strings with presentation
fallbacks rather than closed frontend unions.

```ts
export interface BeadsEnvelope<T> {
  moduleSchemaVersion: 1;
  provider: {
    cliVersion: string;
    schemaVersion: number;
    backend: string;
  };
  data: T;
}

export interface BeadsWorkspaceInfo {
  projectId: string;
  repoRoot: string;
  beadsDir: string;
  backend: string;
  cliVersion: string;
  schemaVersion: number;
}

export interface BeadsIssueSummary {
  id: string;
  title: string;
  status: string;
  priority: number | null;
  issueType: string;
  parentId: string | null;
  assignee: string | null;
  owner: string | null;
  labels: string[];
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  dependencyCount: number;
  dependentCount: number;
  commentCount: number;
}

export interface BeadsDependency {
  issueId: string;
  dependsOnId: string;
  type: string;
  title: string | null;
  status: string | null;
}

export interface BeadsIssueDetails extends BeadsIssueSummary {
  description: string;
  design: string;
  acceptanceCriteria: string;
  notes: string;
  specId: string | null;
  dependencies: BeadsDependency[];
  dependents: BeadsDependency[];
}

export interface BeadsCatalogue {
  issues: BeadsIssueSummary[];
  totalProviderCount: number;
  complete: boolean;
}
```

The native adapter should accept project IDs and filter DTOs, not CLI argument
arrays. The module backend owns translation to allowlisted argv.

```ts
export interface BeadsFilter {
  statuses: string[];
  issueTypes: string[];
  priorities: number[];
  assignees: string[];
  labelsAll: string[];
  labelsAny: string[];
  includeClosed: boolean;
}
```

## Native command surface

Keep the plugin API task-oriented:

```text
plugin:shep-beads|detect
plugin:shep-beads|catalogue
plugin:shep-beads|show_issue
plugin:shep-beads|show_comments       # optional in MVP
```

Do not expose `run_bd(args: string[])`.

### Allowlisted CLI invocations

Representative commands are:

```text
bd --readonly -C <authorized-project> version --json
bd --readonly -C <authorized-project> where --json
bd --readonly -C <authorized-project> context --json
bd --readonly -C <authorized-project> count --json
bd --readonly -C <authorized-project> list --all --limit <cap> --json
bd --readonly -C <authorized-project> show <validated-id> --json
bd --readonly -C <authorized-project> show <validated-id> --include-comments --json
```

`version` may be global in some releases; the adapter should test the installed
CLI contract and keep provider quirks inside `runner.rs`.

### Process safety

The native runner must:

- resolve the project ID to an exact canonical registered-project path;
- invoke `bd` directly with `std::process::Command`, never through a shell;
- validate issue IDs as bounded, non-empty arguments even though no shell is
  involved;
- force `--readonly` and `--json` inside the adapter;
- pass a fixed environment and avoid inheriting secrets not required by Beads
  where practical;
- apply operation-specific timeouts, cancellation on panel/app shutdown, and
  output-size limits;
- parse stdout as JSON and retain bounded stderr separately for diagnostics;
- treat stderr warnings as warnings when exit status and JSON are valid;
- return typed error codes such as `cli_not_found`, `not_initialized`,
  `unsupported_schema`, `timeout`, `output_too_large`, `provider_error`, and
  `invalid_response`;
- never initialize, migrate, repair, start an interactive command, or mutate a
  Beads workspace in the read-only experiment.

## State ownership

The module store is keyed by project ID/path and owns:

```text
workspace detection
catalogue and normalized hierarchy
loading/error/refresh status
filters and sort
root page and page size
expanded issue IDs
selected issue ID and detail cache
split-pane width
last successful refresh timestamp
```

Do not add Beads fields to `useTerminalStore`, `useRepoStore`, `useUIStore`, or
the global `src/lib/types.ts`.

Use explicit refresh for MVP. A short stale marker on panel reveal is fine, but
do not start a watcher or poll continuously. `bd list --watch` implies human
pretty output and is not a structured event contract.

## Detachable file layout

```text
modules/beads/
  README.md
  module.json
  frontend/
    package.json
    src/
      index.ts                    # only public frontend entrypoint
      module.tsx                  # ShepModule + panel contribution
      contracts.ts               # module DTOs
      api/beadsClient.ts          # namespaced Tauri bindings
      state/useBeadsStore.ts
      state/hierarchy.ts
      state/filtering.ts
      components/BeadsPanel.tsx
      components/BeadsToolbar.tsx
      components/IssueTree.tsx
      components/IssueRow.tsx
      components/IssueDetails.tsx
      components/SplitPane.tsx
      components/ProviderState.tsx
      components/BeadsMarkdown.tsx
      tests/hierarchy.test.ts
      tests/filtering.test.ts
      tests/store.test.ts
  backend/
    Cargo.toml
    build.rs
    permissions/
      allow-detect.toml
      allow-catalogue.toml
      allow-show-issue.toml
      default.toml
    src/
      lib.rs                      # Tauri plugin init
      commands.rs                 # typed plugin commands
      runner.rs                   # process, timeout, output bounds
      argv.rs                     # allowlisted command construction
      dto.rs                      # provider normalization
      error.rs
    tests/
      fixtures.rs
      argv.rs
      normalization.rs
  fixtures/
    bd-1.1.2/
      context.json
      count.json
      list.json
      show.json
      stderr-warning.txt
```

`module.json` is descriptive at first; it is not a runtime executable manifest.
It can record module ID, module API version, contribution IDs, native plugin
name, and platform support for tooling/architecture checks.

## Testing strategy

### Pure frontend tests

- build hierarchy from unordered provider rows;
- recursive nesting beyond one epic/task level;
- filtered descendant retains ancestors;
- root paging remains stable when branches expand;
- normal expansion state survives entering/leaving filtered view;
- selection recovery after refresh/removal;
- unknown statuses/types render safely;
- disabled or errored provider states.

### Native tests

- argv construction never accepts arbitrary flags or executable names;
- project authorization rejects unregistered and symlink-escaped paths;
- stdout/stderr separation;
- timeout and output limit enforcement;
- provider JSON normalization and missing-field defaults;
- incompatible schema and malformed JSON errors;
- warning on stderr with valid stdout remains successful;
- test process proves `--readonly` is always present.

### Integration fixtures

Store scrubbed JSON fixtures, not a copied `.beads` database. Add at least:

- empty workspace;
- one epic with nested tasks;
- task nested more than one level;
- closed/open mixtures;
- blocking dependencies distinct from parent-child;
- labels/assignee/comments;
- missing optional fields;
- provider version/schema mismatch;
- catalogue beyond the configured cap.

### Manual acceptance

1. Open Beads in a registered project with no workspace.
2. Open it in xqueue and see 134 issues organized under 30 roots.
3. Expand `xqueue-57w` and see its three children.
4. Filter to open P1 tasks and retain the epic ancestor needed for context.
5. Page roots without losing expansion or selection.
6. Select `xqueue-57w.3` and see description/design/acceptance and typed
   dependencies.
7. Refresh after an external `bd` change and recover selection predictably.
8. Disable the module, build Shep, and verify no Beads import/command remains in
   the host.

## MVP stop condition

The experiment has succeeded when it is useful as a read-only browser and its
removal test passes. Do not add mutations until users repeatedly choose this
panel over terminal `bd` inspection and the read contracts have survived at
least one Beads upgrade.
