# `shipctl-core` — the host's own capabilities (Rust)

The native half of the same split the frontend uses in `core/frontend/`: one
directory per capability, each owning its state and logic. This crate has no
Tauri dependency. `core/tauri/` owns the command, event, and watcher adapters
that expose these capabilities to the desktop app.

## Layout

<!-- markdownlint-disable MD013 -->

| Directory | Owns | Tauri adapter commands |
| --- | --- | --- |
| `workspace/` | project registry plus opaque legacy configuration/workspace bootstrap reads guarded by `WorkspaceManager` | `read_global_configuration_value`, `read_project_configuration_value` are compatibility-only imports; repo and group commands remain here |
| `platform/` | host-environment queries and OS handoffs | `get_username`, `get_home_directory`, `get_default_shell`, `get_computer_name`, `check_command_exists`, `reveal_in_finder`, `open_in_editor`, `open_url` |
| `appearance/` | font enumeration and loading (`fonts.rs`) | `list_monospace_families`, `load_font_family` |
| `processes/` | scoped process inspection and authorized termination | process inspection, termination, and activation release |
| `project_documents/` | registered-project document discovery, revision reads, and atomic writes | project document discovery, read, write, and activation release |
| `git/` | scoped Git execution and activation-owned repository observation | Git requests, repository observation, and activation release |
| `skill_installation/` | registered-project authorization and atomic skill publication and removal | skill installation inspection, install, removal, and activation release |
| `semantic_terminal/` | Ghostty-backed screen interpretation and activation-scoped semantic terminal authority | semantic snapshot, attachment, input, resize, history, anchor, selection, diagnostics, and activation release |
| `terminal/` | host-owned terminal registry, ordered runtimes, VT replay, attachments, lifecycle, exit and agent activity | `list_terminals`, `get_terminal`, `spawn_terminal`, `update_terminal_metadata`, `attach_terminal`, `detach_terminal`, `write_terminal`, `resize_terminal`, `close_terminal`, registry subscription, `set_terminal_retention` resource commit |
| `projects/` | the repository list and groups | `list_repos`, `register_repo`, `unregister_repo`, `load_workspace`, `save_workspace`, `list_groups`, `create_group`, `rename_group`, `delete_group`, `move_repo_to_group`, `watch_repo`, `unwatch_repo` |

<!-- markdownlint-enable MD013 -->

Every capability follows the same shape: `mod.rs` declares submodules and the
logic lives in named files. The matching adapter in `core/tauri/` holds only
`#[tauri::command]` wrappers over that logic. This keeps `shipctl-core`
available to the standalone CLI without Tauri, WebKit, or Wry.

## What is *not* here

`core/tauri/` is the framework adapter. It owns all direct Tauri imports:
commands, IPC channels, app events, and the filesystem watcher. It must not
own domain state or business rules.

`src-tauri/` is the Tauri shell and holds no capability logic. It has four files
plus a small module-composition directory:

- `main.rs` — the binary entry point
- `lib.rs` — builds the app: constructs the managers from this crate, puts them
  in Tauri state, registers every handler, and installs transitional module
  plugins
- `menu.rs` — the native menu
- `lifecycle.rs` — `shutdown_and_quit`, which spans the terminal capability, the
  projects watcher and the app handle at once, so it belongs to the composing
  shell rather than to any one capability
- `modules/` — the feature-gated build inventory and the explicit plugin
  composition list. Module-owned host adapters live in
`modules/<name>/host/`, beside the transitional module they adapt.

**A transitional module-owned host adapter lives in
`modules/<name>/host/`.** It translates host services, such as
`TerminalService`, to the module's narrow authority traits and exposes
`install(...)`. The shell calls that public function but does not contain the
adapter implementation. A module's own files, config, and subprocesses remain
in its module crate. Tauri ACL manifests are the one build constraint: the app
crate keeps each installed plugin as a direct optional dependency so
`tauri::generate_context!()` can discover its permissions.

New native authority does not use this transitional pattern. It becomes a
named Tauri-free capability in this crate plus a private adapter in
`core/tauri/`. The TypeScript module consumes its public semantic service.

If a change to `src-tauri/src/*.rs` is about *what the app does* rather than
*how it is assembled*, it is in the wrong crate.

## Where does a new file go?

Same rule as the frontend, in the same order: one capability uses it → that
capability; two or more already use it → the capability that owns the data, not
a `common` bucket; it reads or writes config → `workspace/`; it uses a Tauri
type → `core/tauri/`; it composes several capabilities → `src-tauri/`; none of
the above → the boundaries are wrong, say so rather than parking the file.
