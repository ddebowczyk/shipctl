# TODO native extraction

## Outcome

TODO Markdown discovery, parsing, serialization, and mutation now live in
`modules/todos/backend/`. The internal `shep-todos` Tauri plugin owns all four
commands and their generated permission definitions.

The global Rust command facade and root invoke-handler list contain no TODO
implementation or forwarding entry.

## Command and permission contract

| Operation | Invoke command | Permission |
| --- | --- | --- |
| Read | `plugin:shep-todos\|read_todos` | `shep-todos:allow-read-todos` |
| Toggle | `plugin:shep-todos\|toggle_todo` | `shep-todos:allow-toggle-todo` |
| Add | `plugin:shep-todos\|add_todo` | `shep-todos:allow-add-todo` |
| Move | `plugin:shep-todos\|move_todo` | `shep-todos:allow-move-todo` |

The plugin crate generates one allow and one deny permission per command. The
application grants the four allow permissions through an isolated inline
`todos` capability in the enabled app profile; the default host capability
remains capability-neutral. The grant is inline because Tauri validates every
discovered capability file even when a build profile does not select it.

## Enablement and plug-out seam

The root app enables the optional plugin dependency through the default-on
`todos-module` Cargo feature. Native isolation can therefore be checked with:

```sh
pnpm verify:todos-native-disabled
```

The `profiles/todos-disabled/tauri.conf.json` overlay selects only the host
capability, avoiding stale grants when the plugin is compiled out. The final
TODO plug-out task owns the complete enabled, disabled, and source-absent
matrix across both frontend and native composition.

## Compatibility

The frontend client changed atomically from flat command names to the plugin
namespace. Argument names, result DTOs, optimistic concurrency checks, file
scan limits, mutation behavior, and watcher-triggered refresh policy did not
change.

There are no temporary forwarding commands to remove.
