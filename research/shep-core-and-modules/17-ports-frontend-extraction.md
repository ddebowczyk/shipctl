# Ports frontend extraction

Date: 2026-08-07

Beads task: `shep-3w1.8.1.2.3`

## Outcome

The Ports capability's frontend implementation now lives in the workspace
package at `modules/ports/frontend`. The package owns its panel, data model,
Tauri client, module declaration, navigation contribution, and characterization
tests.

The host no longer contains Ports-specific rendering, model, client, command
constants, surface adapters, or runtime loaders. It discovers the capability
through the same module registry used by every other global surface.

## Module contract

The module contributes:

- module ID `shep.ports`;
- global surface ID `ports.overview`;
- global navigation ID `ports.global-navigation`;
- namespaced native calls `plugin:shep-ports|list_listening_ports` and
  `plugin:shep-ports|kill_port`.

The panel receives only generic host services. Notices use the existing notice
port. Opening a listener URL uses the new narrow `externalLinks.open` host port;
the module receives no shell or unrestricted operating-system authority.

## Removed transition adapters

The frontend cutover removes the historical flat `list_listening_ports` and
`kill_port` host commands. The host Tauri invoke handler no longer registers
them, and the frontend no longer exposes matching wrappers from `src/lib`.

There is no persisted migration for the old `core.ports` surface ID because
global surfaces are transient UI state. Persisted project tabs are unaffected.

## Verification

- Ports frontend and backend characterization tests pass.
- Module-boundary, composition, and global-surface tests pass.
- The production TypeScript and Vite build passes.
- Host Rust tests and enabled/disabled Tauri builds pass.
- A disabled composition omits the Ports surface and navigation contribution.

## Next boundary

The plug-out task should automate a disposable build with both the frontend
package and native plugin disabled, then prove that deleting the module trees
does not leave host references or break persisted-state recovery.
