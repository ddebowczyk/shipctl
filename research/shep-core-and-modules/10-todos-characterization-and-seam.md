# TODO capability characterization and seam

Date: 2026-08-06

Task: `shep-3w1.7.1`

## Scope

This record protects and maps the current TODO capability before extraction.
It describes the live source tree on branch
`codex/assistant-session-continuity`; it does not move implementation code or
change runtime behavior.

The source of truth is Markdown on disk. Frontend state is a project-keyed
render cache, and all mutations refresh that cache from disk after writing.

## Observable behavior matrix

<!-- markdownlint-disable MD013 -->

| Surface | Current behavior | Characterization evidence |
| --- | --- | --- |
| Discovery | Recursively finds case-insensitive `TODO.md` and `TODOS.md`, root first, at most three levels deep and 20 files; skips hidden and known generated directories and files over 1 MiB. | Rust `discovers_files_case_insensitively_and_skips_ignored_dirs`; native source constants. |
| Parsing | Reads GFM-style task items with unordered or ordered markers, nested indentation, nearest heading, and joined wrapped continuation text. | Existing Rust parsing tests. |
| Sidebar | When enabled, every project gets a To-dos row with an open-item badge; selecting it opens the project-scoped singleton panel. | `TodoRow.tsx`; Phase 1 panel-host smoke. |
| Panel summary | Shows open/done counts and relative paths; multiple files render separately. | `TodosPanel.tsx`; production build. |
| View selection | Uses board view when any file yields at least two columns; otherwise list view. A user can switch view for the mounted panel. | `todosModel.test.ts`; panel source. |
| Board model | Selects the heading level most often owning items, rolls deeper headings into the preceding column, groups indented children under cards, and leaves pre-column items in Inbox. | `todosModel.test.ts`. |
| Completion columns | Moving to Done, Complete, Completed, Shipped, or Finished columns synchronizes the parent checkbox; leading symbols and emoji are ignored. | `todosModel.test.ts`; panel-to-store argument mapping. |
| Toggle | Sends file path, zero-based line, rendered expected text, and next checked state. Native code rejects stale line/text and changes only the checkbox marker. Cache refresh occurs even after rejection. | Existing Rust toggle tests; `todosStore.test.ts`. |
| Move | Moves a parent card with continuation/nested lines to the end of a target section and can synchronize the parent checkbox. Cache refresh occurs even after rejection. | Existing Rust move tests; store characterization. |
| Add | Trims input, appends to the primary discovered file, or lazily creates root `TODO.md`. Kanban creation produces Backlog, In Progress, and Done columns. Board adds target the first non-done column. | Existing Rust add tests; store/model characterization. |
| External edits | Repository filesystem events refresh the cache while TODO display is enabled; direct mutation also refreshes after completion. | `ProjectList.tsx`, watcher event integration, and store characterization. |
| Settings | Global project settings control sidebar visibility and whether a newly created file uses kanban or list shape; existing files are not reformatted. | `SettingsPanel.tsx` and project settings store. |
| Agent skill | The panel can delegate installation of `shep-todos` to the Skills capability and reports success/failure through notices. | `TodosPanel.tsx`; this remains a cross-capability port. |
| Project removal | Removing a project evicts only that project's TODO render cache. | `todosStore.test.ts`. |
| Persisted panel | The current `todos` tab maps to stable panel identity `core.todos`; disabled panels use generic unavailable-panel recovery. | Existing panel persistence and composition tests. |

<!-- markdownlint-enable MD013 -->

## Current ownership map

### TODO implementation that moves into the module

- `src/components/todos/TodosPanel.tsx`: panel UI, list/board presentation,
  board model, add/toggle/move policy, skill prompt, and notice messages.
- `src/components/sidebar/TodoRow.tsx`: project navigation contribution and
  open-count badge.
- `src/stores/useTodoStore.ts`: project-keyed cache and mutation refresh
  semantics.
- TODO rules in `src/styles/globals.css`: panel, board, card, form, and skill
  button styles.
- TODO DTOs in `src/lib/types.ts`.
- TODO invoke clients in `src/lib/tauri.ts`.
- `src-tauri/src/todos.rs`: discovery, parsing, DTOs, and Markdown mutations.
- Existing native TODO tests and new frontend characterization tests.

### Composition entries that become declarative registration

- `src/core/modules/builtinPanelAdapters.ts`: current `core.todos` panel
  definition.
- `src/core/modules/builtinPanelRuntime.tsx`: current lazy loader.
- `src/components/sidebar/ProjectList.tsx`: hard-coded `TodoRow` placement.
- `src/components/settings/SettingsPanel.tsx`: hard-coded settings section.
- `src-tauri/src/lib.rs`: flat module declaration and command registration.
- `src-tauri/src/commands.rs`: flat Tauri wrappers.

These entries should disappear as capability-specific branches. Generic host
composition remains outside the module.

### Host responsibilities that do not move

- project registration, canonical project paths, active project selection, and
  project removal lifecycle;
- panel placement, focus, persistence, unavailable-panel recovery, and icon
  rendering primitives;
- application settings storage primitives;
- repository/filesystem watcher infrastructure and event delivery;
- notice/toast rendering and theme primitives; and
- terminal and PTY infrastructure.

## Required frontend ports

The TODO frontend must depend on stable contracts rather than importing global
stores:

<!-- markdownlint-disable MD013 -->

| Port | Minimum authority exposed to TODO |
| --- | --- |
| Project context | Active project path and project-removal lifecycle callback. |
| Panel host | Register the project-scoped singleton panel and open/focus it for a project. |
| Project navigation | Contribute a project row with label, icon, badge, visibility, and activation. |
| Settings | Read/write `showTodos` and `todoFileStyle` through module-owned settings contribution backed by host storage. |
| Filesystem changes | Subscribe to project-relative changes relevant to recognized TODO filenames; no direct watcher-store import. |
| Notices | Publish typed info/error notices. |
| Skills | Query and request installation of the `shep-todos` skill through a capability contract, without importing the Skills store or implementation. |

<!-- markdownlint-enable MD013 -->

The first extraction may model Skills as an optional host service port. TODO
must not import `modules/skills` directly when Skills is extracted later.

## Required native boundary

Create `modules/todos/backend` as an internal Tauri plugin with namespaced
commands and explicit permissions. The frontend client belongs to the TODO
module and invokes only that plugin surface.

Proposed command semantics:

- `plugin:todos|read` accepts an authorized project identity/path and returns
  module-owned DTOs;
- `plugin:todos|toggle` identifies the project plus relative file, line,
  expected text, and desired checked state;
- `plugin:todos|add` identifies the project plus optional relative file,
  text, optional section line, and creation style; and
- `plugin:todos|move` identifies the project plus relative file, source
  identity, target section, and optional checked-state synchronization.

The host should authorize a registered project root. Native mutation must
resolve and validate relative files beneath that root before reading or
writing. The current flat API accepts arbitrary absolute `filePath` values;
preserve user-visible behavior, but do not preserve that excess authority in
the module contract.

## Current coupling and fidelity risks

- `TodosPanel` reads five global stores directly: terminal/project context,
  TODO cache, Skills, project settings, and notices.
- `TodoRow` reads TODO, terminal, and settings stores and opens the panel by a
  legacy tab kind.
- Settings owns TODO-specific copy and imports the TODO store to trigger a
  refresh when enabled.
- Project removal explicitly calls the TODO store from `AppShell`.
- The frontend invoke client and DTOs are mixed into global files.
- Native wrappers are mixed into `commands.rs`, and commands are registered in
  the host's global invoke list.
- Filesystem refresh currently rides Git/project watcher behavior rather than a
  capability-neutral filesystem-change port.
- Cache equality ignores `relativePath`, item indentation, and item section
  title while comparing line/text/check state and section-line identity. This
  can leave presentation-only changes stale until another compared field
  changes; decide explicitly whether to fix this under a separate behavior
  change, not silently during extraction.
- Native mutations currently trust an absolute file path supplied by the
  frontend. The plugin boundary should narrow this to authorized project-local
  relative paths.
- Skill installation is optional product integration, not core TODO storage;
  it must stay behind a port so either module can be removed independently.

## Compile-green extraction sequence

1. Create module-owned DTOs, board model, tests, and a frontend client adapter
   while the existing panel still consumes compatible types.
2. Create the internal native TODO plugin by moving implementation and native
   tests, then register it through the existing backend module rails.
3. Introduce project, navigation, settings, filesystem-change, notice, and
   optional Skills ports at the narrowest shape demanded by TODO.
4. Move the store, panel, sidebar contribution, settings contribution, styles,
   and tests under `modules/todos/frontend` and register its public module
   entrypoint.
5. Switch persistence from built-in `core.todos` composition to the module's
   stable panel identity with a tested migration for existing tabs.
6. Delete the old component/store/client/DTO/native wrappers and every
   TODO-specific host branch in the same cutover.
7. Pass enabled, disabled, and physically source-absent builds; verify generic
   persisted-panel recovery and the manual smoke matrix.

At no point should old and new implementations both own writes.

## Verification contract

Characterization task:

```sh
pnpm test:todos-characterization
pnpm test:panels
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

Extraction tasks must retain the same behavioral assertions while relocating
them with the module. The final plug-out gate must also use the reusable
source-removal profile established in Phase 2.
