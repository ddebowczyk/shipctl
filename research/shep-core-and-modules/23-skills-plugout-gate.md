# Skills plug-out gate

Date: 2026-08-06

## Result

Skills is now a removable vertical module. Its frontend and native
implementation can be disabled independently, and deleting
`modules/skills/` from a disposable source copy leaves the remaining Shep
application buildable and testable.

The host retains only the generic optional `ModuleSkillsPort` contract and
project-action/lifecycle dispatch. This is intentional host API, not Skills
implementation coupling: TODOs consume an optional service by contribution
ID and continue with an unavailable-provider result when no implementation is
registered.

## Owned boundary

`modules/skills/` owns:

- the fixed Skills catalog, bundled Markdown resources, install/remove policy,
  command handlers, generated Tauri permissions, and native tests;
- the namespaced native client, DTO, project-keyed cache, action menu,
  lifecycle hooks, error notices, and frontend tests;
- the sole public `skillsModule` contribution used by compile-time
  composition.

The only native host adapter is `src-tauri/src/skills_module.rs`, which grants
the plugin an exact set of registered project roots. The adapter disappears
with the module feature during the source-absent proof.

## Reusable verification change

The earlier TODO and Ports plug-out recipes encoded the complete list of
other frontend modules and Cargo default features. That assumption stopped
scaling when Skills was added. The shared harness now removes one named
frontend contribution and one named Cargo default feature. Older disabled
profiles also keep newer sibling modules enabled, so each profile proves one
module is absent rather than accidentally testing a smaller application.

`scripts/verify-skills-plugout.mjs` performs every destructive operation only
inside a validated temporary copy. It removes Skills composition, native
feature/plugin registration, permissions, package dependencies, smoke mocks,
profile resources, and then the module directory itself.

## Verification matrix

<!-- markdownlint-disable MD013 -->

| Profile | Evidence | Result |
| --- | --- | --- |
| Enabled | Skills frontend/native characterization, module composition, project actions, TODO characterization, panel and boundary tests, smoke type-check, production frontend build, 41 host Rust tests, Tauri debug build | Pass |
| Frontend and native disabled | Skills omitted from frontend composition and Cargo features; sibling TODO and Ports modules retained; composition, project actions, TODO, panel and boundary tests, production frontend build, Tauri debug build | Pass |
| Source absent | `modules/skills/` and its profile physically removed; pnpm and Cargo graphs checked; implementation-reference scan empty; composition, project actions, TODO, panel and boundary tests, smoke type-check, production frontend build, 40 host Rust tests, Tauri debug build | Pass |

<!-- markdownlint-enable MD013 -->

The one-test difference in the host Rust totals is the module-host adapter's
exact-root check, which correctly disappears with the Skills feature.

The source-absent scan checks host source, native composition, permissions,
package metadata, and the panel smoke entry for Skills package, crate,
feature, command, and permission identifiers. The generic service contract is
deliberately excluded because it remains valid without a provider.

## State and recovery

Skills contributes no panel, terminal, persisted tab identity, or durable
module state. Its cache is process-local and derived from project files.
Removing the implementation therefore requires no persisted-state migration.
Generic provider selection returns no Skills provider, project action
composition omits the menu group, and TODOs retain their existing
provider-unavailable behavior.

## Smoke scope

Automated tests exercise the changed action/provider/lifecycle paths, and the
panel-host smoke entry type-checks both enabled and source-absent forms. The
full Phase 0 interactive desktop checklist was not rerun: the user's real Shep
process and PTY sessions were deliberately left untouched. Skills extraction
does not change PTY ownership, shutdown, project persistence, or window
lifecycle, so no broader manual-session claim is made at this gate.

## Commands

```bash
pnpm verify:skills-plugout
pnpm verify:skills-plugout --source-absent-only
pnpm check:module-boundaries
git diff --check
```

The first complete matrix exposed one remaining Skills command mock in the
source-absent browser harness. The removal recipe was corrected, and the
source-absent profile then passed in full. A final exact-staged matrix is the
commit gate.

## Rollback

- `5913bf4` is the native Skills extraction checkpoint.
- `960de7d` is the frontend Skills extraction checkpoint.
- Reverting the plug-out-gate commit removes only verification/profile
  infrastructure and this record; it does not restore a dual implementation.
