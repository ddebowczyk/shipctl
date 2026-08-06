# Skills host rails

Date: 2026-08-07

Task: `shep-3w1.8.2.2.1`

## Outcome

The host now composes project actions and an optional Skills provider through
generic module contracts. Skills-specific UI and store knowledge has been
removed from `ProjectItem`, `AppShell`, `useGitWatcher`, and
`moduleHostServices`.

The existing Skills store remains in place for this safe checkpoint. A single
registered compatibility module adapts it to the new contracts. That adapter
is transitional: the frontend extraction task moves it under
`modules/skills/frontend` and deletes the host-local adapter.

## Generic project-action rail

`ProjectActionContribution` lets a module provide one context-menu group for a
project. A contribution may also refresh its data when the menu opens and
subscribe the host to changes in its module-owned state.

The host retains only placement and rendering responsibilities:

- it chooses where contributed groups appear in the project menu;
- it translates generic labels, icon descriptors, selection state, and action
  flags into shared menu components; and
- it contains failures while resolving, refreshing, subscribing, cleaning up,
  or running a contributed action.

Contribution order is deterministic. A failed contribution is omitted without
hiding healthy sibling groups, and refresh uses `Promise.allSettled` so one
module cannot block another.

## Optional Skills provider

An enabled module may expose one `SkillsProviderContribution`. Composition
validates that the provider belongs to its declaring module and rejects
profiles with multiple Skills providers.

`ModuleHostServices.skills` remains a stable consumer contract for TODO. When
no provider is enabled, reads return an empty snapshot, subscriptions are a
no-op, and installation rejects with a clear capability-unavailable error.
This keeps consumers independent of the Skills implementation and makes later
plug-out behavior explicit.

## Temporary compatibility boundary

`src/core/modules/skillsCompatibilityAdapter.ts` is the only production file
outside the existing Skills store that imports `useSkillStore`. It currently
owns:

- the project action group and install/remove interaction;
- the read/install-only service exposed to TODO;
- project-list, filesystem-change, and project-removal lifecycle reactions;
  and
- adaptation from the Zustand state shape to the stable module snapshot.

It is included through the same compile-time module profile as extracted
modules. No host component imports a Skills implementation symbol, and no
module imports a sibling module implementation.

## Preserved behavior

- The Agent Skills group appears only when the project has a populated catalog.
- Opening the project menu refreshes that project.
- Project-list and filesystem events refresh all affected projects.
- Project removal evicts only that project's process-local cache.
- Install/remove selection and failure notices retain their existing labels and
  behavior.
- TODO still reads and installs `shep-todos` through the host-mediated port.

The native policy and command surface are deliberately unchanged in this
slice. The next task moves that policy and its resources atomically into an
internal Tauri plugin.

## Verification

```sh
pnpm exec tsc --noEmit
pnpm test:project-actions
pnpm test:module-composition
pnpm test:skills-characterization
pnpm test:todos-characterization
pnpm check:module-boundaries
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

The project-action suite specifically verifies contribution failure
containment for group resolution, refresh, subscriptions, and cleanup. Module
composition tests verify optional, singular, module-owned Skills provider
selection and default-profile wiring.
