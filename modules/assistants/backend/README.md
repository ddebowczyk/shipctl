# Assistant native module

This internal `shep-assistants` Tauri plugin owns durable Claude and Codex
session identity, provider argv policy, capture, restore, and shutdown
preparation. It also owns model discovery for Assistant launchers: Claude's
local entitlement cache and aliases, Codex app-server model discovery, and
provider CLI catalog probes. It depends on the host only through the narrow
`TerminalAuthority` port; PTY implementation and app lifecycle remain core
infrastructure.

Frontend calls use the `plugin:shep-assistants|...` namespace and explicit
generated permissions, including `get_models_for_provider`. The restore manifest remains at
`~/.shep/assistant-sessions.json` with its existing schema and semantics.
