# Transitional TODO native module

This internal Tauri plugin still provides the legacy TODO commands while Phase
B moves feature policy to TypeScript. New frontend code uses the semantic
Project Documents service through these transitional, permission-scoped
commands:

```text
plugin:shipctl-todos|discover_project_documents
plugin:shipctl-todos|read_project_document
plugin:shipctl-todos|write_project_document
```

The legacy `read_todos`, `toggle_todo`, `add_todo`, and `move_todo` commands
remain only for Phase D differential proof and deletion. The Rust provider owns
registered-project authorization, path containment, bounded I/O, revisions,
and atomic publication. Todo parsing and mutation policy belongs to
`modules/todos/frontend`.

The plugin is enabled by Shipctl's default `todos-module` Cargo feature. It can
be compiled out with `--no-default-features` for module-isolation verification.
