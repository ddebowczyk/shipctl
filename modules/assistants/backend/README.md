# Assistant native module

This internal `shep-assistants` Tauri plugin owns durable Claude and Codex
session identity, provider argv policy, capture, restore, and shutdown
preparation. It depends on the host only through the narrow
`TerminalAuthority` port; PTY implementation and app lifecycle remain core
infrastructure.

Frontend calls use the `plugin:shep-assistants|...` namespace and explicit
generated permissions. The restore manifest remains at
`~/.shep/assistant-sessions.json` with its existing schema and semantics.
