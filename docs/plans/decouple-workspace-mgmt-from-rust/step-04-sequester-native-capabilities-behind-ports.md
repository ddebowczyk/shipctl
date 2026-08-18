<!-- markdownlint-disable MD013 -->

# Step 04 — Sequester native capabilities behind ports

## Outcome

Replace the broad frontend-to-Tauri facade with small, typed native-backed
semantic ports. The ports are injected into the TypeScript application runtime
at bootstrap and granted to plugins through declared service contracts. A
plugin never receives invoke, a Tauri window object, or an unscoped native
service bag.

This reduces native coupling while preserving the reliability, performance, and
security properties that make Rust appropriate for specific work.

## Boundary rule

Native code owns a capability only when it needs one of the following:

- operating-system authority: PTY, process, filesystem, keychain, clipboard,
  native window, dialog, notification, or OS event access;
- a durable primitive that must remain correct outside a JavaScript process:
  atomic file replacement, compare-and-swap, lock, or native lifecycle state;
- a platform-specific implementation whose performance or ABI cannot be
  reasonably delegated to TypeScript.

Everything else is application policy and belongs in the trusted TypeScript
runtime or a TypeScript plugin: user workflows, view identity and placement,
configuration grammar, message routing policy, feature defaults, user-facing
commands, and composition choices.

## Native-backed service inventory shape

Existing focused adapters such as Git, credentials, terminal sessions, desktop
windows, project documents, and notifications are the beginning of the desired
shape. The task is to make each one explicit about authority and grants, then
break up the catch-all platform/tauri facade.

| Port family | Native kernel retains | TypeScript runtime/plugins retain |
| --- | --- | --- |
| Terminal and process | PTY/process creation, I/O, exit state, scoped signal delivery, resource limits | terminal presentation, focus policy, tabs, semantic session workflow, retries, notices |
| Files and project documents | permitted filesystem access, atomic writes, project registration | document workflow, user-facing project model, views, command policy |
| Git | command execution, repository access boundary | status presentation, workflows, actions, menus |
| Credentials | keychain/credential persistence and authenticated transport primitives | provider selection, assistant workflow, user-facing settings |
| Desktop | native windows, dialogs, notifications, clipboard and open-url | when and why to use them; menu/view intent |
| Scheduler and messages | optional reliable wake-up, durable queue or timer primitive | handler registration, routing, schedule declarations, retries and feature policy |
| Durable data | generic opaque document CAS, transaction, backup and recovery | schema, defaults, migration, interpretation and validation |
| Usage sources | scoped native collection where needed | source selection, aggregation policy, dashboard and alerts |

The last two columns are intentionally not an ownership transfer of all code:
a given native provider may remain the implementation of a service. What moves
is the application vocabulary that decides how it is used.

## Grant model

Admission should resolve a plugin's declared requirements to a grant-filtered
service registry. A grant is not a security sandbox on its own; bundled and
installed code is still trusted under the current model. It is nevertheless
valuable because it:

- makes authority visible before activation;
- makes accidental dependency growth detectable;
- lets headless operation omit UI-only capabilities;
- provides a future seam for stronger isolation; and
- creates useful diagnostics when activation is rejected.

Each port needs a contract-level error model. For example, a terminal service
returns a denied or unavailable capability error, rather than leaking a Tauri
invoke error or silently falling back to an unrelated service.

## Refactoring actions

1. Complete the Step 01 ledger for every method in platform/tauri.ts and its
   caller set.
2. Split it into cohesive platform adapters with semantic method names and
   typed inputs/outputs. Keep raw invoke command names private to those
   adapters.
3. Define a native base-service registration layer at runtime bootstrap.
4. Define plugin requirement and grant declarations in the public contract.
5. Ensure only runtime composition can turn a native adapter into a public
   semantic service.
6. Move direct desktop and configuration decisions out of feature modules and
   into semantic services or contribution intents.
7. Add structured capability-denied diagnostics with plugin id, capability id,
   runtime revision, and activation phase.
8. Remove the broad facade after its final caller is moved; do not leave it as
   a convenience import.

## Tauri adapter rule

core/tauri remains the only Rust crate that imports Tauri framework APIs.
core/backend remains framework-free. TypeScript platform adapters are the only
frontend code that imports Tauri packages. Neither rule means that platform
adapters may contain product policy; they are translation and lifecycle
boundaries.

For a new native command, the review question is:

> Which native resource or durable primitive does this command protect, and
> which semantic port will own its TypeScript contract?

If the answer names a screen, tab, workspace profile, feature default, or menu
location, it is almost certainly the wrong layer.

## Validation and exit criteria

- No plugin reaches native APIs except through a declared semantic service.
- No public TypeScript contract contains invoke command names or Tauri types.
- The runtime can construct a grant-filtered service registry from manifests.
- A plugin requiring a withheld service fails before any of its contributions
  or effects become active.
- Existing native integration tests continue to prove PTY, credentials, process
  and durable-write behavior independent of UI rendering.
- The remaining platform surface is a set of cohesive adapters, not a
  catch-all service object.
