# Usage frontend module

Date: 2026-08-07

## Outcome

Usage is no longer a host-owned frontend capability. Its DTOs, Tauri client,
stores, quota helpers, global panel, sidebar widget, settings section, CSS,
logos, refresh schedule, and ingestion-event listener now live under
`modules/usage/frontend` and compose through the public
`@shep/module-usage` entrypoint.

The host has no Usage-specific UI, state, client function, lifecycle adapter,
resource, or global-surface branch. The persisted surface identity remains
`core.usage`, so an existing active Usage surface remains valid after upgrade
and becomes the generic unavailable state when the module is disabled.

## Generic contract corrections

Two missing pieces became visible during the extraction:

1. A sidebar contribution now declares its target `surfaceId`; the host gives
   the lazy component an `open()` callback. This prevents the module from
   importing the host UI store. Composition rejects a sidebar target that is
   not a surface owned by the same module.
2. Settings contributions now select `projects.after` or `terminal.after`.
   The default is `projects.after`, preserving existing Git and To-dos
   placement. Usage selects `terminal.after`, preserving its previous location
   without a feature-specific branch in `SettingsPanel`.

These are declarative placement and activation contracts, not an event bus.
They do not expose Usage types or create module-to-module imports.

## Module-owned behavior

The public `usageModule` contributes:

- global surface `core.usage` and its footer navigation action;
- the sidebar utilization widget targeting that same surface;
- the Usage Providers settings section after Terminal settings;
- the three-second snapshot refresh and one-minute refresh cadence;
- activation-time settings, snapshots, and provider refresh;
- the `usage-ingest-complete` listener and deterministic teardown.

Provider visibility defaults, quota windows, reset interpretation, pace
thresholds, error text, state scope, and settings rollback behavior are
unchanged and remain covered by the characterization suite.

## Remaining compatibility boundary

The frontend client still invokes the existing flat native Usage commands, and
the native workspace configuration still owns its typed `usage:` field. That
is intentional for this safe slice. The next migration extracts the Rust
backend into a namespaced internal Tauri plugin before compatibility removal.

Atomic mutation of shared global configuration was a prerequisite for removing
typed host ownership. Bead `shep-3w1.8.6.2.5` subsequently landed that boundary,
as documented in `43-atomic-global-config-mutations.md`.

## Verification

The following checks passed:

```sh
pnpm exec tsc --noEmit
pnpm test:module-boundaries
pnpm test:module-composition
pnpm test:global-surfaces
pnpm test:usage-characterization
pnpm build:module-fixture
pnpm build
pnpm verify:usage-frontend-disabled
```

The enabled production build emitted lazy Usage surface chunks. The disabled
production build omitted the Usage navigation, surfaces, settings UI, and
lifecycle markers from `dist`.
