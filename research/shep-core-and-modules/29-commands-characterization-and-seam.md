# Commands characterization and seam

Date: 2026-08-07

Task: `shep-3w1.8.4.1`

## Outcome

Commands is a project-scoped capability currently spread across host UI,
workspace persistence, and PTY infrastructure. Its observable behavior is now
protected by `scripts/tests/commandsCharacterization.test.ts` before any code
movement.

The target split is:

- the Commands module owns command configuration types, catalogue state,
  naming, editing, autostart policy, panel UI, sidebar/tab/menu contributions,
  and styles;
- core owns generic project-data storage and PTY-backed terminal sessions; and
- the module reaches those services only through capability-neutral ports.

There is no Commands-specific native operation today. A native Commands plugin
would only relocate generic file and PTY infrastructure, so the extraction
must not invent one. Native code is justified only if a future Commands-only
operation appears.

## Protected behavior

- Project state: loading configuration creates `stopped` entries with null PTY
  IDs and keeps catalogues isolated by project path.
- Naming: names are lowercased, truncated to 32 characters before cleanup,
  normalized, and de-duplicated with `_2`, `_3`, and so on.
- Editing: blank commands are rejected; existing rows autosave after 500 ms;
  hidden environment and working-directory fields survive edits.
- Persistence: create, update, and delete save the complete workspace before
  mutating memory or stopping a command. Workspace name and Assistants data are
  preserved.
- Project switch: configuration and `autostart` commands load only on the first
  in-process visit.
- Execution: command details and terminal dimensions pass to core PTY
  infrastructure. The terminal tab retains command name and PTY ID.
- Exit: manual stop or exit code zero becomes `stopped`; another natural exit
  becomes `crashed`; the PTY ID is cleared.
- Panel: persisted identity is `core.commands`, project scoped and singleton,
  with `Shift+Cmd+C`. Older `kind: commands` state migrates to that identity.

## Current ownership and coupling

Module candidates:

- `src/components/commands/CommandsPanel.tsx`
- `src/components/sidebar/CommandsRow.tsx`
- `src/stores/useCommandStore.ts`
- the Commands CSS block in `src/styles/globals.css`
- Commands metadata now embedded in `builtinPanelAdapters.ts`,
  `builtinPanelRuntime.tsx`, `tabKindMeta.tsx`, and `TabBar.tsx`

Host infrastructure that must remain outside the module:

- PTY creation, termination, output, exit events, terminal tabs, and xterm
  ownership in `src/hooks/usePty.ts` and terminal infrastructure;
- project registration and active-project lifecycle; and
- durable filesystem access and atomicity policy for project-local data.

Temporary host workflow coupling remains in `AppShell.tsx`: it loads and saves
the whole `WorkspaceConfig`, runs first-visit autostart, dispatches native-menu
events, and passes Commands callbacks through the built-in panel runtime.

## Required generic ports

### Project capability data

Add a project-scoped data service that reads and replaces a module-owned value
by stable capability ID. The host owns file access, serialization, write
ordering, and notices; it does not import the Commands schema.

The safe transition should first adapt this service to the existing
`.shep/workspace.yml` document, preserving `name`, `assistants`, and unknown
keys. The Commands module then consumes the `commands` value through the port.
Only after both Commands and Assistants have migrated may the host's typed
aggregate `WorkspaceConfig.commands` field disappear or become opaque.

### Terminal sessions

Add a terminal-session service that can launch and stop a PTY-backed session
for a project and subscribe to lifecycle changes. A launch request contains a
command, arguments, environment, working directory, label, and opaque owner
key. The service owns terminal-tab creation and PTY cleanup; the Commands
module maps owner keys and lifecycle events to its own `running`, `stopped`,
and `crashed` state.

This boundary must preserve current tab identity and exit semantics. It should
also make the current duplicate-start behavior explicit before changing it.

## Compatibility risks captured, not fixed

- `resolveCommandCwd` strips a leading slash and permits `..`; for example,
  `../shared` becomes `/repo/../shared`. Hardening this would be a separate
  behavior and security decision.
- Starting a command whose tab already exists creates a new PTY and then
  focuses the old tab. This can orphan the newly created PTY. Extraction must
  preserve or deliberately fix this under a separate characterized task.
- Workspace writes currently replace one typed aggregate containing Commands
  and Assistants. A naive module write can drop sibling capability data.
- First-visit autostart is process-memory policy, not a persisted statement
  that a command is already running.
- The sidebar badge counts configured commands, not running commands.

## Safe migration slices

1. Add and characterize capability-neutral project-data and terminal-session
   ports, backed by current host behavior.
2. Move Commands types, state, workflow, panel, navigation, menu/tab metadata,
   and CSS under `modules/commands/frontend`; compose only its public module
   entrypoint.
3. Remove built-in Commands adapters and host branches, then prove enabled,
   disabled, and physically source-absent builds with generic persisted-panel
   recovery.

Each slice must leave the application buildable. The project-data adapter may
be temporary, but capability-specific callbacks must not become permanent host
API.

## Verification evidence

```sh
pnpm test:commands-characterization
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

The focused suite has nine passing tests covering project isolation, runtime
reset and updates, naming, working-directory behavior, save ordering,
first-visit autostart, panel identity, host coupling inventory, PTY handoff,
and exit-state mapping.
