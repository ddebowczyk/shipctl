# Skills capability characterization and seam

Date: 2026-08-07

Task: `shep-3w1.8.2.1`

## Outcome

Skills is currently a fixed, compile-time catalog of two Shep-provided agent
skills. It is not a general skill index and has no user/global scope. For each
registered project, Shep treats the existence of
`.agents/skills/<name>/SKILL.md` as installed state and keeps a process-local
render cache of that result.

The current behavior is protected by `pnpm test:skills-characterization` before
any runtime implementation moves. Fixtures use synthetic temporary project
roots and contain no user workspace data.

## Observable behavior

<!-- markdownlint-disable MD013 -->

| Behavior | Current contract | Evidence |
| --- | --- | --- |
| Catalog | Exactly `shep-todos` and `orchestrate`, in compile-time registry order. Names, titles, descriptions, and Markdown are embedded in the binary. | `src-tauri/src/skills.rs`; native characterization |
| Project scope | Installed state is keyed by project path. One project's installation does not affect another. There is no active-project dependency. | `useSkillStore`; frontend and native characterization |
| User/global scope | None. Shep does not inspect home-directory skill roots or merge provider catalogs. | Native source and call graph |
| Installed state | A regular/resolvable `SKILL.md` at `.agents/skills/<name>/SKILL.md` is sufficient. Frontmatter and contents are not parsed, so malformed metadata still appears installed. A Claude pointer alone does not count. | `has_skill`; native characterization |
| Initial/empty state | The frontend starts with no cached projects, so the Agent Skills context-menu section is absent until a refresh succeeds. A successful empty result remains an empty project snapshot. | `useSkillStore`; `ProjectItem`; frontend characterization |
| Missing root | Listing a missing project still returns the fixed catalog with every item uninstalled. Installation rejects missing or non-directory roots. | Native characterization |
| Refresh | All registered projects refresh on project-list changes, relevant filesystem events, and a 60-second watcher fallback. Opening a project context menu also refreshes that project. | `useGitWatcher`; `watcher.rs`; `ProjectItem` |
| Refresh failure | Single and batch refresh failures are swallowed and preserve the last successful cache for that project. Other fulfilled projects still update. | Frontend characterization |
| Install | Writes the embedded Markdown under `.agents/skills/<name>/SKILL.md`, then creates `.claude/skills/<name>` as a relative symlink on Unix. An existing Claude entry is left alone. The frontend refreshes after a successful mutation. | Native tests; frontend characterization |
| Remove | Removes the standard project skill directory and removes the Claude entry only when it appears Shep-owned. Removing an absent known skill is a no-op. | Native tests |
| Mutation failure | Unknown names and failed writes reject. The project context menu reports the rejection through a notice and does not refresh after a failed mutation. | Native tests; `ProjectItem`; frontend characterization |
| Persistence | No Skills state is persisted by Shep. Disk is the source of truth; the Zustand map is only a process-local render cache. Project removal evicts only that cache entry. | `useSkillStore`; frontend characterization |
| Cross-capability use | TODO consumes a host-mediated read/install-only Skills port for `shep-todos`; it does not import the Skills implementation. | `ModuleSkillsPort`; `TodosPanel` |

<!-- markdownlint-enable MD013 -->

## Current ownership map

### Skills implementation that moves

- `src/stores/useSkillStore.ts`: project-keyed render cache, refresh policy,
  install/remove orchestration, and failure containment.
- Skills-specific context-menu construction in
  `src/components/sidebar/ProjectItem.tsx`.
- `SkillInfo` in `src/lib/types.ts` and the three flat invoke clients in
  `src/lib/tauri.ts`.
- `src-tauri/src/skills.rs`, `todo_skill.md`, and `orchestrate_skill.md`: fixed
  catalog, embedded resources, project filesystem policy, and native tests.
- Flat wrappers in `src-tauri/src/commands.rs` and registrations in
  `src-tauri/src/lib.rs`.

### Host and infrastructure responsibilities that remain

- registered-project identity and canonical project-root authorization;
- project context-menu placement and generic contribution rendering;
- recursive filesystem watching, debounce, fallback polling, and delivery of
  project-root change facts;
- notice rendering and project-removal lifecycle dispatch; and
- the stable optional Skills service consumed by TODO.

Generic filesystem authority belongs to the native host boundary. The Skills
frontend must not continue sending an arbitrary path that native code trusts as
a project root.

## Current coupling and fidelity risks

- `ProjectItem` imports the global Skills store and owns capability-specific
  menu labels, icons, mutation selection, and error notices.
- `useGitWatcher` imports the Skills store directly for initial and external
  refreshes.
- `AppShell` explicitly evicts Skills state during project removal.
- `moduleHostServices` adapts the global store into TODO's Skills port, so the
  host currently knows the implementation rather than an enabled contribution.
- The native API accepts any UI-supplied absolute path. Registration and
  containment are not verified at the command boundary.
- Installed state is intentionally shallow: content changes, invalid
  frontmatter, and provider compatibility are invisible as long as the file
  exists.
- Cache equality compares only name and installed state. Runtime title or
  description changes would not update an existing cache, though the current
  catalog cannot change without rebuilding Shep.
- The watcher is shared with Git and reports project roots, not skill-specific
  paths. This is correct for current refresh behavior but remains host
  infrastructure, not module-owned filesystem observation.

## Required module boundary

The frontend module needs narrow contracts for:

1. a generic project context-menu contribution;
2. project-list, project-removal, and project-filesystem-change lifecycle;
3. notices;
4. a module-owned Skills service adapter exposed through the existing
   read/install-only host port used by TODO; and
5. a module client that invokes only namespaced plugin commands.

The native plugin should own the fixed catalog, embedded Markdown resources,
DTOs, install/remove policy, and tests. Commands should accept a host-authorized
project identity/root and a known skill name. The host authorizes the registered
root; the module resolves only its fixed relative locations beneath that root.

## Safe migration slices

The migration is not atomic as one task. Keep each slice buildable:

1. add generic project-action composition and a host-mediated optional Skills
   provider seam while the current store remains the adapter;
2. move native policy/resources into an optional internal Tauri plugin with
   namespaced commands, explicit permissions, and a disabled profile;
3. move the store, client, DTO, context-menu contribution, and tests into
   `modules/skills/frontend`, then remove flat frontend/native adapters; and
4. prove enabled, disabled, and physically source-absent builds in the existing
   close-gate task.

At no point should old and new native implementations both own writes.

## Verification contract

```sh
pnpm test:skills-characterization
pnpm test:module-composition
pnpm check:module-boundaries
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```
