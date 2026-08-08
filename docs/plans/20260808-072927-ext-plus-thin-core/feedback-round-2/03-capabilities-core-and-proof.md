# Capabilities, thin-core boundary, and proof

## One capability model

The current `module.yaml` files list Tauri command permissions, while real
modules also use event subscriptions, channels, and host services. Replace that
partial vocabulary with one authoritative capability catalog, proposed at
`modules/api/capabilities.yaml`, and generate the manifest schema, TypeScript
types, Rust checks, and documentation from it.

A module manifest requests distinct grant kinds:

```yaml
grants:
  invoke: []
  subscribe: []
  channel: []
  services: []
```

The catalog defines valid identifiers and their typed request, response, event,
or channel payload contracts. The four lists stay distinct even when tooling
generates them from one source: opening a stream is not equivalent to invoking a
command, and subscribing is not equivalent to publishing or receiving every
event.

The host constructs each native and service port as a closure over the module
instance identity and its validated grants. A module never passes `moduleId` as
authority. Every listener, channel, timer, and resource returned by a port is
registered in that instance's activation scope.

This mediation remains advisory for JavaScript running in the shared webview; it
does not turn trusted in-process code into a sandbox. The plan must preserve
that trust statement and reserve untrusted extensions for the isolated runtime
model in [`fully-modular-tauri`](../../fully-modular-tauri/README.md).

## Required coverage

The mediated-port experiment must cover the current edge shapes, not only the
smallest module:

<!-- markdownlint-disable MD013 -->

| Module | Boundary that must be proven |
| --- | --- |
| `todos` | native invoke and structured denial |
| `usage` | native invoke, event subscription, scheduled work, and teardown |
| `assistants` | native invoke, channel creation, terminal ownership, and shutdown lifecycle |
| `git` | broad native invoke surface, project-facts provider, subscription, and teardown |

<!-- markdownlint-enable MD013 -->

The generated catalog should reject unknown grants and ensure each direct
`@tauri-apps/api` use is gone before the compatibility shim is removed.

## Thin-core responsibility rule

New behavior belongs in the reloadable module system unless it is necessary to
boot, discover, validate, load, reconcile, authorize, observe, or recover
modules, or to preserve the agent's control channel while they change. This is
a responsibility boundary, not a size target. `shared/` cannot be used to evade
it.

The current capability map is documented in the
[frontend core guide](../../../../core/frontend/README.md). It should be
rebaselined as follows:

<!-- markdownlint-disable MD013 -->

| Current area | Disposition | Stable responsibility |
| --- | --- | --- |
| `platform/` | Stable TypeScript shell | Typed Tauri transport, protocol codecs, and error extraction. |
| `host/` | Stable TypeScript shell | Registry service, supervisor, scoped ports, catalog snapshot, recovery, and module chrome. |
| `shell/` | Stable TypeScript shell | Boot, layout slots, tab/surface composition, error boundaries, module management, and updater handoff. |
| `terminal/` | Stable Rust and TypeScript shell | PTY authority, output transport, xterm host, session identity, and the agent control channel. |
| `projects/` | Split | Stable workspace identity/context service; project-management behavior and optional UI move to modules. |
| `appearance/` | Split | Stable theme tokens and applicator; theme catalogs and preference UI may move to modules. |
| `settings/` | Split | Stable persistence contract and host recovery settings; application-specific preferences and UI move to their owner module. |
| `shared/` | Audit and split | Keep only proven cross-boundary primitives such as notices and accessibility; move domain behavior to its owner. |
| `modules/api/` | Stable public contract | Versioned manifest, capabilities, host ports, and contribution types; it is not a feature. |
| Current feature modules | Reloadable modules | `assistants`, `commands`, `fixture`, `git`, `ports`, `skills`, `todos`, and `usage`. |

<!-- markdownlint-enable MD013 -->

The Rust inventory is separate and explicit: PTY, workspace identity,
credentials, module registry, lifecycle authority, and protocol mediation stay
compiled. Existing native module plugins and changes to Tauri command/plugin
registration are restart-required integrations even when their TypeScript
frontends are live-loadable.

## Restart classification

- **Live:** validated manifest/configuration changes and TypeScript module
  install, enable, update, rollback, disable, or logical remove under the
  activation and ownership contracts.
- **Live with drain:** operations whose old instance retains tracked resource
  leases; public behavior changes at commit while physical disposal follows.
- **Restart-required:** Rust code, Tauri command or plugin registration, CSP or
  import-policy changes, the static shell, or a resource type lacking safe
  ownership semantics.

Classification happens during preflight. A restart-required result leaves the
active desired revision untouched and explains the exact boundary.

## Decisive end-to-end proof

The v1 gate must exercise the agent's real path, not only an internal module
toggle:

```text
originating Shipctl terminal is interactive with module A active
  -> agent edits TypeScript or declarative configuration
  -> dev watcher builds immutable digest B
  -> CLI requests B and receives registry revision R
  -> host validates and prepares B beside A
  -> catalog and new-work routing switch atomically to B
  -> CLI observes R applied, with no webview reload
  -> originating terminal accepts input and returns output
  -> rollback selects immutable A and preserves the terminal again
```

The failure path builds or activates an invalid version C. It must prove that B
remains active, no partial C contributions or handles remain, the terminal stays
interactive, and the agent receives a structured phase-and-cause diagnostic.

The proof should assert a version marker exported by the evaluated runtime, not
infer new-code loading from changed files on disk or from a deactivation cycle.

## Revised critical path

Keep the packaged dynamic-import and React-identity experiments. Move immutable
versioning, complete capability mediation, activation scopes, atomic snapshots,
resource leases, and live A-to-B rollback ahead of the first lifecycle claim.
Then add the registry adapters and source watcher and run the end-to-end proof
above with the assistants boundary included.

Only after this gate passes should settings UI and broad module migration be
scheduled. Reload-safe PTY reattachment can proceed independently as resilience
work, but it does not satisfy or block the live-reconfiguration mission.
