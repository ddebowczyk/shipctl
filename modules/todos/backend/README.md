# TODO native module

This internal Tauri plugin owns TODO Markdown discovery, parsing, and mutation.
It exposes only these permission-scoped commands:

```text
plugin:shipctl-todos|read_todos
plugin:shipctl-todos|toggle_todo
plugin:shipctl-todos|add_todo
plugin:shipctl-todos|move_todo
```

The plugin is enabled by Shipctl's default `todos-module` Cargo feature and can be
compiled out with `--no-default-features` for module-isolation verification.
