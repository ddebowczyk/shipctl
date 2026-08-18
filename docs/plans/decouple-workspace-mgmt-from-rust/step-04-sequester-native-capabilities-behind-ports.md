<!-- markdownlint-disable MD013 -->

# Step 04 — Break up the residual `platform/tauri.ts` facade

## Outcome

`core/frontend/platform` is already mostly the desired shape: eighteen cohesive
adapters, each mapping one semantic capability to Tauri
(`git.ts`, `credentials.ts`, `processes.ts`, `projectDocuments.ts`,
`skillInstallation.ts`, `terminalSessions.ts`, `semanticTerminals.ts`,
`scheduler.ts`, `messages.ts`, `pluginData.ts`, `usageSources.ts`,
`assistantLaunch.ts`, `desktopWindow.ts`, `desktopNotifications.ts`,
`desktopApp.ts`, `moduleControl.ts`, `workspacePersistence.ts`,
`runtimeDiagnostics.ts`).

The residue is `platform/tauri.ts`: one module holding eight unrelated concerns.
This step splits it and closes the last paths by which a caller obtains native
authority without naming it.

## The eight concerns currently in one module

| Concern | Members | Target |
| --- | --- | --- |
| Renderer selection | `getCanvasAdapter` | **delete** — Step 05 moves renderer selection to TypeScript |
| Project registry | `listRepos`, `registerRepo`, `unregisterRepo`, `loadWorkspace`, `saveWorkspace` | `platform/projects.ts` behind a semantic projects service |
| Project groups | `listGroups`, `createGroup`, `renameGroup`, `deleteGroup`, `moveRepoToGroup` | same service; groups are a projection of the project registry, not a family |
| User settings | editor, project, keybinding, terminal, sidebar getters/setters | **delete** — Step 05 makes these TypeScript-owned configuration namespaces |
| Durable UI state | `getUiState`, `setLastRepoPath`, `saveAppearanceState` | one durable record namespace (Step 05); not three bespoke commands |
| Fonts | `listMonospaceFamilies`, `loadFontFamily` | `platform/fonts.ts` — genuine OS enumeration, keep |
| Terminal/PTY | 12 members incl. `attachRawTerminal`, `getTerminalPublicationStats` | fold into `platform/terminalSessions.ts`; the raw attachment path stays private to the terminal host |
| Watcher, lifecycle, system | `watchRepo`, `unwatchRepo`, `shutdownAndQuit`, `getUsername`, `getHomeDirectory`, `getDefaultShell`, `getComputerName`, `checkCommandExists`, `getMemoryStats` | `platform/system.ts` (host-environment queries) and `platform/lifecycle.ts` |

The file must not survive the step as a shrunken "misc" module. A module named
after its transport rather than its capability re-accretes by default; that is
precisely how it reached eight concerns.

## Boundary rule

Native code owns a capability only when it needs one of:

- operating-system authority: PTY, process, filesystem, keychain, clipboard,
  native window, dialog, notification, or OS event access;
- a durable primitive that must remain correct outside a JavaScript process:
  atomic file replacement, compare-and-swap, lock, or native lifecycle state;
- integrity enforcement that must precede executing plugin code;
- a platform-specific implementation whose performance or ABI cannot reasonably
  be delegated to TypeScript.

Everything else is application policy: user workflows, view identity and
placement, configuration grammar, message-routing policy, feature defaults,
user-facing commands, and composition choices.

Applied to the table above: fonts, PTY, watcher, process, and filesystem access
qualify. Renderer selection, editor preference, sidebar state, and "last repo
path" do not — they are stored natively only because the file happens to live
under the application configuration directory.

## Ownership split for the capabilities that stay

| Port family | Native kernel retains | TypeScript retains |
| --- | --- | --- |
| Terminal and process | PTY/process creation, I/O, exit state, scoped signal delivery, resource limits | presentation, focus policy, tabs, session workflow, retries, notices |
| Files and project documents | permitted filesystem access, atomic writes, project registration | document workflow, user-facing project model, views, command policy |
| Git | command execution, repository access boundary | status presentation, workflows, actions, menus |
| Credentials | keychain persistence and authenticated transport primitives | provider selection, assistant workflow, user-facing settings |
| Desktop | native windows, dialogs, notifications, clipboard, open-url | when and why to use them; menu/view intent |
| Scheduler and messages | reliable wake-up and durable delivery primitive | handler registration, routing, schedule declarations, retries |
| Durable records | opaque CAS, transaction, backup and recovery | schema, defaults, migration, interpretation, validation |
| Usage sources | scoped native collection where an external source requires it | source selection, aggregation policy, dashboard, alerts |

The right-hand column is not a promise to move code. A native provider may
remain the implementation. What moves is the vocabulary that decides how it is
used.

## Grant model

Grant declaration and admission already exist: a manifest declares
`requestedGrants`, native admission validates it, and the loader re-checks it
against `requiredGrants` at load (`core/frontend/host/moduleArtifactLoader.ts:340-349`).
`usage` declares nine. The final binding is incomplete: the effective admitted
set is not carried into semantic service providers, so
`core/frontend/platform/pluginData.ts:99-114` substitutes a hard-coded product
module/key policy. Steps 02 and 05 close that gap.

Grants are not a sandbox — bundled and installed code is trusted under the
current model. They are worth keeping because they make authority visible before
activation, make dependency growth detectable, let headless operation omit
UI-only capabilities, and give a seam for a stronger isolation model later.

Two gaps to close in this step:

1. **Grant vocabulary is per-capability and ad hoc.** `usage-source.read`,
   `plugin-data.write`, `message.publish.*`, `schedule.register` are each
   invented by their capability. Establish one naming rule and record each grant
   against the resource it protects, so a reviewer can answer "what does this
   grant let the plugin reach?" without reading Rust.
2. **Denial is not uniformly structured.** Each port needs a contract-level
   denied/unavailable error rather than a leaked `invoke` failure. Where a
   capability already defines one (`plugin-data.denied`,
   `workspace.forbidden`), reuse the pattern rather than adding a variant.

`HOST_SUPPORTED_ARTIFACT_GRANTS` is intentionally a stable native capability
vocabulary. Adding a new privileged OS resource can require a Rust release.
Adding an ordinary plugin, configuration key, migration, menu, view, or project
policy that uses an existing grant must not. In particular, `plugin-data.*`
authorizes an admitted activation's own namespace, not a closed Rust or
TypeScript list of product module ids and keys.

The same rule applies to all ports: no native adapter may contain a per-plugin
ACL, registry entry, command switch, or contribution-family allowlist. The
artifact identity and effective grants arrive through the accepted-admission
binding; the adapter authorizes that capability/resource relationship, not a
product feature. This is what lets a plugin installed after the host package
was built use an existing port after restart.

One current mismatch is not a policy choice: the public `PluginDataGrant` and
provider expose `plugin-data.migrate`, while
`HOST_SUPPORTED_ARTIFACT_GRANTS` admits only `.read` and `.write`. Add
`.migrate` to the stable vocabulary and its native admission test before using
the existing atomic migration operation. That one-time API alignment preserves
least privilege; it must not become a per-plugin allowlist.

## Tauri adapter rule

`core/tauri` remains the only Rust crate importing Tauri framework APIs;
`core/backend` remains framework-free; `core/frontend/platform` remains the only
frontend location importing `@tauri-apps/*`. None of these rules permits product
policy inside an adapter — they are translation and lifetime boundaries.

For a new native command the review question is:

> Which native resource, durable primitive, or integrity boundary does this
> command protect, and which semantic port owns its TypeScript contract?

If the answer names a screen, tab, workspace profile, feature default, or menu
location, it is the wrong layer.

## Refactoring actions

1. Enumerate every `platform/tauri.ts` member with its callers before moving
   anything; several are called from exactly one place and can be inlined into
   the owning adapter instead of relocated.
2. Split the file along the eight concerns above. Delete, do not relocate, the
   members Step 05 removes.
3. Give the projects/groups pair a single semantic service; groups have no
   independent native resource.
4. Fold the raw PTY members into `terminalSessions.ts` and keep the raw
   attachment private to the terminal host.
5. Pass the accepted artifact's effective grants through the private provider
   binding from Step 02. Replace plugin-data's `DEFAULT_AUTHORIZE` and the
   matching fake default policies with that binding; retain owner derivation and
   validate scope/key/schema shape, but do not maintain a product key table.
6. Add `plugin-data.migrate` to the native supported-grant vocabulary and its
   approval fixture so the existing public migration operation can be admitted.
7. Record every grant against the resource it protects and adopt one naming
   rule.
8. Add a uniform denied/unavailable error to every port that lacks one.
9. Delete `platform/tauri.ts` when its last member has a home. Do not leave a
   re-export shim.

## Validation and exit criteria

- `platform/tauri.ts` does not exist; no module in `platform/` is named after a
  transport, and each remaining module maps to one capability.
- No plugin reaches native APIs except through a declared semantic service.
- No public TypeScript contract contains an invoke command name or a Tauri type.
- A plugin requiring a withheld grant fails before any contribution, route,
  schedule, or effect becomes active, with an error naming plugin, grant, and
  phase.
- An arbitrary admitted fixture plugin using `plugin-data.*` can migrate only
  its own namespace. A peer plugin and a fixture without that grant are denied
  with no durable write; adding that fixture's configuration key requires no
  Rust source change.
- No native port adapter contains a plugin-id/key allowlist or feature-specific
  ACL; authorization is derived from the accepted admission binding and the
  port's documented resource grant.
- Every grant has a recorded protected resource.
- Existing Rust integration tests still prove PTY, credential, process, and
  durable-write behavior with no UI rendering.
- `just modularity boundaries` and `just check all` pass with no new exception.
