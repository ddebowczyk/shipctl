# Core host

`core/` contains capabilities owned by the Shipctl host, split into matching
frontend and backend packages:

- `frontend/` is the `@shipctl/core` workspace package. Read its README before
  adding browser code.
- `backend/` is the `shipctl-core` Rust crate. It owns native capability logic and
  Tauri command implementations.

Composition stays at the edges: `core/frontend/shell/` assembles screens and
`src-tauri/` assembles the native app. Pluggable features belong in `modules/`.
