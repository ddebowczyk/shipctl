# Canvas adapters

`canvas/` is the host-owned composition boundary for the main application
canvas. It is not a feature module and it is not a module API.

## Contract

`@shipctl/core/canvas` exports JSX-free model and action types plus
`createCanvasModel()`. `@shipctl/core/canvas/views` exports `CanvasHost`.

- `CanvasModel` is an immutable description of the selected content, terminal
  presentation slots, sidebar facts, tab-bar contributions, and trailing
  layout eligibility.
- `CanvasActions` contains explicit shell-owned operations. An adapter asks for
  work through these callbacks; it does not own project, terminal, or native
  window policy.
- `CanvasPorts` gives an adapter a host-owned `CanvasSurfaceCatalog`, terminal
  renderer ports, and module host services. The catalog is compiled from the
  static bundled module profile at startup. It gives the adapter validated
  panel, surface, visual-navigation, sidebar, project-navigation, and
  project-layout references without exposing a layout-library type to a module.

`CanvasHost` receives an adapter resolved once during application bootstrap.
`ui.canvas: legacy` is the default; `ui.canvas: layman` selects the
experimental `layman/LaymanCanvas.tsx`, which holds the same legacy canvas in
one controlled Layman pane. The selection is immutable for the application
lifetime: change global configuration and restart rather than hot-swapping a
live terminal canvas.

### Layman source

The proof adapter uses the approved GitHub source revision
`github:ddebowczyk/react-layman#8d0c41a0a52830f3072771af674d63d80215384e`.
That exact revision includes the generated `lib/` export required by Git
installs, an SSR-safe drag preview, and CAS conflict recovery with stale-result
guards. The canvas test guards this pin.

## Ownership

An adapter owns placement and DOM layout. It may select where a panel, global
surface, terminal slot, or trailing project layout appears. It may not start
terminal registries, activate modules, load runtime modules, listen for
Tauri menu events, or call native Tauri APIs. `shell/AppShell.tsx` owns those
operations and builds the model, actions, and ports.

Feature modules continue to contribute panels, global surfaces, navigation,
sidebar surfaces, and project layout through `@shipctl/module-api`. They do not
import this directory. The modularity checker rejects both feature-module and
Tauri imports from canvas source.

`CanvasSurfaceCatalog` is host code in `host/`, not another discovery system.
It validates ownership and target references once, wraps failed view loads in a
stable recoverable error, and is fixed for the application lifetime. An adapter
may place catalog entries but may not add a runtime module or mutate the static
profile.

## Terminal rule

Every live terminal descriptor produces a mounted canvas slot. `visible` is a
presentation fact only: it never requests an attach, detach, or close. Slots
are sorted by terminal ID and then tab ID before rendering. A slot is visible
only when its tab is active in the active project and no global surface is
open. This preserves terminal renderer lifetime across tab changes.
