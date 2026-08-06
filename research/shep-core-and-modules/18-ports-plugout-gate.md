# Ports extraction plug-out gate

## Outcome

Ports is a removable production module. Its React panel, model, client,
characterization tests, native policy, native tests, and Tauri permission
resources live under `modules/ports/`.

The host has only declarative composition and narrow infrastructure adapters:

- `src/core/modules/enabledModules.ts` imports the public frontend package;
- `src-tauri/src/enabled_modules.rs` installs the optional native plugin;
- `src-tauri/src/ports_module.rs` supplies project catalog and fixed process
  observation or termination implementations to the plugin interfaces.

The infrastructure adapter receives no generic command from the module and is
removed with the composition wiring in the source-absent proof.

## Generic global-surface behavior

Ports contributes a process-local global surface and footer navigation action.
It does not add a persisted tab kind. The generic surface host preserves its
active surface across project switches and provides a bounded unavailable state
for unknown or disabled contributions.

The panel uses generic notice and external-link host services. Native calls use
only the namespaced plugin commands declared by the module.

## Reusable removal proof

Run the complete matrix with:

```sh
pnpm verify:ports-plugout
```

The verifier proves three distinct states:

1. Enabled: characterization, composition, global-surface, panel, frontend,
   Rust, and full Tauri builds pass.
2. Disabled: a disposable copy omits frontend composition and builds the native
   host without the Ports feature or permission grant.
3. Source absent: another disposable copy removes the module trees, host
   adapter, dependency and feature declarations, capability grant, and
   composition wiring. Dependency graph assertions plus frontend, Rust, and
   full Tauri builds still pass.

Persisted-reference recovery is covered by the generic panel persistence suite.
Ports itself has no persisted surface state to migrate.
