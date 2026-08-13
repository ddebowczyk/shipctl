# `shipctl-tauri-adapter`

This crate is the only host-core layer that imports Tauri. It translates
desktop IPC, app events, and filesystem-watch events into `shipctl-core`
services.

It must contain no domain state or business rules. Put those in
`core/backend/<capability>/`. This boundary lets the `shipctl` CLI depend on
the same backend core without linking Tauri, WebKit, or Wry.

`src-tauri/` is the composition shell. It creates Tauri state, registers these
commands, and installs feature modules. A module-specific Tauri adapter stays
in `modules/<name>/host/`.
