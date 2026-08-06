# Global-surface contribution rail

Date: 2026-08-06

## Outcome

Settings, Usage, and Ports now reach the shell through one generic,
compile-time contribution rail. The host no longer stores three booleans,
renders three capability-specific branches, or hard-codes three footer
buttons. Ports remains in its existing source location behind a built-in
adapter; moving its implementation is the next migration slice.

The user-visible contract is unchanged:

- only one global surface can be active;
- selecting the active footer action closes it;
- selecting another action replaces it;
- selecting a tab or opening a project panel closes it;
- switching projects directly leaves it open;
- active state is process-local and is not persisted.

## Contract

The frontend module API exposes two independent declarations:

1. `GlobalSurfaceContribution` owns a namespaced ID, lazy component loader,
   module owner, and optional unavailable metadata.
2. `GlobalNavigationContribution` owns a namespaced action ID, points to a
   surface ID, and supplies label, icon descriptor, and ordering metadata.

Keeping navigation separate means a module can expose a global surface without
requiring footer placement. It also lets the registry reject a navigation
action whose surface is absent.

`ShepModule` accepts `globalSurfaces` and `globalNavigation`. The compile-time
profile in `enabledModules.ts` remains the only optional-module import point.

## Host ownership

The host retains only generic responsibilities:

- validate namespaced IDs, uniqueness, target existence, and module ownership;
- order navigation actions;
- track one active surface ID;
- lazy-load and render the selected contribution;
- contain loading and render failures;
- offer retry and close actions for unavailable surfaces.

Built-in Settings, Usage, and Ports declarations live in
`builtinGlobalSurfaceAdapters.ts`. Their lazy loaders live in
`builtinGlobalSurfaceRuntime.ts`, keeping component knowledge out of
`AppShell`. `SidebarFooter` renders the registry's navigation list, while
`GlobalSurfaceHost` renders the selected surface.

Unknown or disabled IDs produce a recoverable unavailable view instead of an
exception. A disabled module contributes neither its surface nor its
navigation action.

## Verification

`pnpm test:global-surfaces` protects registration, validation, mutual
exclusion, toggle-close behavior, and unknown-surface recovery.

`pnpm test:module-composition` protects enabled and disabled module
composition. `pnpm test:ports-characterization` continues to protect the
existing Ports semantics while it remains behind the adapter.

The next slice, `shep-3w1.8.1.2.2`, can extract native Ports policy without
changing this frontend placement contract.
