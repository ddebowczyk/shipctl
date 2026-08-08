# `shipctl-core` — the host's own capabilities (Rust)

The native half of the same split the frontend uses in `core/frontend/`: one
directory per capability, each owning its state, its logic and the Tauri
commands that expose it. There is no `commands.rs` at the crate root, because
"is a command" is a file kind, not a concern.

## Layout

| Directory | Owns | Commands |
| --- | --- | --- |
| `workspace/` | the on-disk config schema, its loader and the `WorkspaceManager` that guards it | none — it is the persistence layer the others read |
| `platform/` | host-environment queries and OS handoffs | `get_username`, `get_home_directory`, `get_default_shell`, `get_computer_name`, `check_command_exists`, `reveal_in_finder`, `open_url` |
| `appearance/` | font enumeration and loading (`fonts.rs`) | `list_monospace_families`, `load_font_family` |
| `terminal/` | PTY lifecycle: `PtyManager`, per-session state, memory accounting | `spawn_pty`, `write_pty`, `resize_pty`, `kill_pty`, `update_pty_color_theme`, `get_pty_session_count`, `get_terminal_settings`, `save_terminal_settings`, `get_memory_stats` |
| `projects/` | the repository list, groups, and the git `watcher.rs` | `list_repos`, `register_repo`, `unregister_repo`, `load_workspace`, `save_workspace`, `list_groups`, `create_group`, `rename_group`, `delete_group`, `move_repo_to_group`, `watch_repo`, `unwatch_repo` |
| `settings/` | preferences no other capability owns: editor choice, project defaults, keybindings, sidebar state | `get_editor_settings`, `save_editor_settings`, `get_project_settings`, `save_project_settings`, `get_keybinding_settings`, `save_keybinding_settings`, `get_sidebar_settings`, `open_in_editor` |

Every capability follows the same shape: `mod.rs` declares the submodules, the
logic lives in named files, and `commands.rs` holds only `#[tauri::command]`
wrappers over that logic.

## What is *not* here

`src-tauri/` is the Tauri shell and holds no capability logic. It has four files
plus a `modules/` directory:

- `main.rs` — the binary entry point
- `lib.rs` — builds the app: constructs the managers from this crate, puts them
  in Tauri state, registers every handler, installs the module plugins
- `menu.rs` — the native menu
- `lifecycle.rs` — `shutdown_and_quit`, which spans the terminal capability, the
  projects watcher and the app handle at once, so it belongs to the composing
  shell rather than to any one capability
- `modules/` — one file per pluggable module, each exposing a single
  `host_services()` that bridges this crate's capabilities to that module's API,
  behind its own feature flag

**An adapter in `src-tauri/src/modules/` exists only to hand over host-owned
state.** The `PtyManager` qualifies: terminals live for the whole app and no
module can own one. A module's own files, its own config, its own subprocesses
do *not* qualify — those live in the module crate, even when they touch the
filesystem or the Keychain. If a host-side authority trait would be implemented
purely by free functions with no host state behind them, the functions belong in
the module and the trait should not exist. `pi_config` was the worked example of
getting this wrong: 210 lines of `~/.pi/agent` handling sat in `src-tauri/`
behind a `PiConfigAuthority` trait, so the host depended on the module's types
while the module depended on the host for the implementation. It now lives in
`modules/assistants/backend/src/pi_config.rs` and the trait is gone.

If a change to `src-tauri/src/*.rs` is about *what the app does* rather than
*how it is assembled*, it is in the wrong crate.

## Where does a new file go?

Same rule as the frontend, in the same order: one capability uses it → that
capability; two or more already use it → the capability that owns the data, not
a `common` bucket; it reads or writes config → `workspace/`; it composes several
capabilities → `src-tauri/`; none of the above → the boundaries are wrong, say so
rather than parking the file.
