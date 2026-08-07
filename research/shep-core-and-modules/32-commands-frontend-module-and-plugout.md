# Commands frontend module and plug-out gate

## Outcome

Commands is now a self-contained frontend module under
`modules/commands/frontend`. The host composes only its public
`commandsModule` entrypoint. The catalogue, runtime state, panel, project-row
navigation, styles, lifecycle behavior, and characterization tests are owned by
the module.

The host retains the two capability-neutral services Commands needs:

- `projectData` reads and replaces the `commands` section of project YAML;
- `terminalSessions` launches, stops, focuses, and reports lifecycle for opaque
  module-owned sessions.

No Commands store, DTO, panel component, PTY mapping, CSS, CRUD handler, or
command-specific branch remains in host UI code.

## Public composition

The module contributes:

- project panel `core.commands`;
- project navigation `commands.project-navigation`;
- shortcut `Shift+Cmd+C`;
- native-menu event `new_commands` through generic panel metadata;
- project-open loading/autostart and project-removal cleanup.

The current panel ID and the pre-module tab kind remain stable migration data,
so existing saved tabs hydrate through the generic panel persistence path.
They are compatibility identities, not host-owned Commands implementation.

## Runtime ownership

The module maps each configured command to an opaque terminal-session owner
key. It never sees PTY IDs, xterm instances, or terminal tab IDs. Lifecycle
events map to the existing `running`, `stopped`, and `crashed` UI states.

Persistence completes before create, update, or delete mutates module state.
Project loading is first-visit-only, concurrent loads are coalesced, and
autostart remains sequential. Launch failures are surfaced through the generic
notice service and release their pending owner mapping.

## Resource isolation correction

The disabled build exposed an implicit dependency that ordinary type checks
could not detect: the To-dos panel reused `commands-panel*` CSS classes. To-dos
now owns equivalent `todos-panel*` structure and styling in its own module.
This ensures removing Commands cannot degrade an unrelated panel while leaving
the build technically green.

The root stylesheet no longer contains Commands CSS. Commands imports its own
`commands.css` from its public package entrypoint.

## Plug-out proof

The verification matrix covers three profiles:

1. enabled source: Commands tests, composition, panel persistence, boundary
   tests, panel-host typecheck, and production build;
2. disabled composition: the Commands profile entry is removed in a disposable
   copy and the host still tests and builds;
3. source absent: `modules/commands` and its workspace dependency are deleted
   in a disposable copy, dependency-graph absence is asserted, implementation
   references are rejected, and the host still tests and builds.

The production environment switch
`VITE_SHEP_COMMANDS_MODULE=disabled` additionally proves a normal disabled
bundle. Its output contains no Commands panel, project row, styles, or module
navigation implementation.

Run:

```sh
pnpm test:commands-characterization
pnpm verify:commands-frontend-disabled
pnpm verify:commands-plugout
```

## Boundary result

Commands is removable without changing lifecycle, panel rendering, sidebar,
terminal, or project-data host implementations. This validates the terminal
and project-data ports against their first real consumer and leaves assistant
continuity as the next terminal-backed capability to extract.

## Closure evidence

The phase-closing gate additionally ran the complete host native suite: 45
tests passed. Beads lint and dependency-cycle checks were clean.

The browser panel-host harness loaded the real Commands module, opened its
add-command editor, cancelled the edit, and then loaded the To-dos module with
its own module-local layout styles. This verifies both the Commands entrypoint
and the CSS isolation correction through the rendered runtime path.

The environment still cannot script the native Tauri window without macOS
Accessibility permission. The final operator smoke must therefore exercise a
real command launch and stop through the built application. This is a bounded
interactive-evidence gap rather than a known failure: terminal launch, focus,
exit classification, and cleanup are covered by the generic terminal-session
contract and Commands characterization suites.
