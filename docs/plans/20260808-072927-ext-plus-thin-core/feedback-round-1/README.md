# Feedback round 1 — live agent reconfiguration

**Review status:** Changes requested. **Reviewed:** 2026-08-08.
**Mission intent:** Make Shipctl reconfigurable by agents while it is running. A
small Rust and TypeScript shell may remain static, but application capabilities
outside that shell should be loadable and reconfigurable as JavaScript or
TypeScript modules/extensions. Restart-required changes must be explicit
exceptions, not the normal configuration path.

## Bottom line

Do not schedule the plan as written. It establishes disk-loaded frontend
modules, but its primary lifecycle operation is a webview reload. That does not
prove live reconfiguration and can break the active agent session that initiated
the change.

The plan should retain a deliberately small, stable shell and add a live
reconciliation path for the reloadable portion of the application. Where a
restart is genuinely required, the system must identify the boundary and report
that requirement before applying the change.

## Findings

### 1. Critical — reload-first lifecycle breaks the mission

The plan reloads the webview after install, enable, disable, and remove
operations ([plan](../README.md),
[target architecture](../02-target-architecture.md)). Current PTYs bind their
output channel when they are spawned
([backend terminal commands](../../../../core/backend/src/terminal/commands.rs)),
while frontend session identity is held in in-memory maps
([frontend PTY hook](../../../../core/frontend/terminal/usePty.ts)). There is no
demonstrated list, attach, or reconnect path.

A webview reload can therefore discard the frontend state and channel belonging
to the agent's terminal while leaving the native process alive. The initiating
agent may lose its control path precisely when it changes Shipctl.

**Required plan change:** Make live reconciliation part of the first usable
lifecycle, or first prove reload-safe PTY discovery and reattachment. Reload
must not be the default mechanism for configuration changes.

### 2. High — the agent control plane is acknowledged but not planned

The risks document mentions watched source paths
([risks and decisions](../05-risks-and-decisions.md)), but this is absent from
the experiments, implementation phases, and exit gate. The planned management
surface consists of Tauri IPC commands and a human-operated settings UI
([migration and sequencing](../04-migration-and-sequencing.md)). Tauri IPC alone
is not a shell-addressable control plane for an agent.

**Required plan change:** Add an agent-facing declarative or CLI surface that
can request a change, observe completion, and receive structured diagnostics.
Define a typed module-change event so the running application can reconcile
registries, contributions, routes, commands, and active instances without a
webview reload.

### 3. High — the reload experiment does not prove changed code is loaded

The target architecture uses a stable `<id>/module.mjs` URL, while the reload
experiment only deactivates and reactivates the module
([experiments](../03-experiments.md)). JavaScript module loading is cached by
resolved URL, so overwriting that file does not prove that version B will be
evaluated in the same webview.

**Required plan change:** Use immutable version- or content-addressed module
paths, an atomic active-version switch, and an experiment that proves
`A -> B -> rollback to A` without a webview reload. Failed validation or
activation must leave A active. The existing fully modular plan already
describes immutable version directories and a transactional registry
([extension package and registry](../../fully-modular-tauri/03-extension-package-and-registry.md));
reuse that property here.

### 4. High — native mediation has no coherent permission vocabulary

The proposed port checks commands, events, and channels against permissions
([target architecture](../02-target-architecture.md)), but current module
manifests expose only Tauri command permissions
([todos manifest](../../../../modules/todos/module.yaml)). Existing modules also
invoke host facilities and subscribe to events without equivalent manifest
grants, including assistants
([assistants client](../../../../modules/assistants/frontend/src/client.ts)),
usage, and git.

A todos-only mediation experiment will not validate the contract needed by the
current module set.

**Required plan change:** Define separate, typed grants for command invocation,
event subscription, and channel creation, or generate those grants from one
authoritative capability model. Validate the model against assistants, usage,
and git as well as todos.

### 5. High — the thin core is asserted rather than bounded

The plan keeps layout, terminal, projects, settings, and appearance static, but
the current frontend core also owns settings, updater, themes, terminal, and
project UI ([frontend core guide](../../../../core/frontend/README.md)). It lists
modules to migrate without assigning every remaining TypeScript capability to
either the stable shell or the reloadable extension system.

**Required plan change:** Add an explicit capability inventory with a justified
disposition for each item:

- stable Rust shell;
- stable TypeScript shell;
- reloadable module/extension;
- restart-required integration, with the technical reason.

The architecture gate should reject new application behavior in the stable
shell unless it is necessary to load, isolate, reconcile, observe, or recover
reloadable capabilities. This is a responsibility boundary, not a line-count
target.

## Required end-to-end proof

The plan's decisive experiment and exit gate should prove this path:

```text
agent edits TypeScript or configuration
  -> watcher builds immutable version B
  -> host validates B
  -> active-version registry switches atomically
  -> affected registries and runtime instances reconcile
  -> UI behavior changes without a webview reload
  -> the originating terminal remains interactive
```

The failure path must prove that version A remains active and that the agent
receives a structured diagnostic identifying the failed phase and cause.

## Restart classification

The plan should classify changes by technical boundary rather than assuming one
lifecycle for all changes.

- **Live by default:** module configuration, install/enable of independently
  loadable TypeScript modules, contribution metadata, commands, routes, labels,
  ordering, settings, and updates whose instances satisfy the disposal and
  activation contract.
- **Conditionally live:** disable, remove, or update of active modules that own
  resources. These require tracked ownership, deterministic disposal, and
  transaction rollback. If a particular resource cannot meet that contract,
  the system reports the restart requirement before committing the change.
- **Restart-required exceptions:** changes to Rust code, the compiled Tauri
  command/plugin surface, CSP or import policy that the running webview cannot
  change safely, and the minimal static shell itself.

## Required revisions before scheduling

1. Replace reload-first lifecycle acceptance criteria with the end-to-end live
   reconciliation proof above.
2. Promote the agent control plane and source/config watcher into an
   implementation phase, experiments, and the final exit gate.
3. Adopt immutable module versions and transactional activation before active
   module updates are claimed to be supported.
4. Specify and test the complete native command/event/channel capability model.
5. Inventory all current frontend capabilities and justify the stable versus
   reloadable disposition of each.
6. Define restart classification and structured preflight diagnostics as part
   of the public lifecycle contract.

The early loader and boundary experiments remain useful, but the roadmap must
be resequenced around preserving the initiating agent session and proving live
change from source/config input through runtime reconciliation.
