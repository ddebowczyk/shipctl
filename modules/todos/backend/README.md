# TODO native module

This internal Tauri plugin owns TODO Markdown discovery, parsing, and mutation.
It exposes only these permission-scoped commands:

```text
plugin:shep-todos|read_todos
plugin:shep-todos|toggle_todo
plugin:shep-todos|add_todo
plugin:shep-todos|move_todo
```

The plugin is enabled by Shep's default `todos-module` Cargo feature and can be
compiled out with `--no-default-features` for module-isolation verification.
