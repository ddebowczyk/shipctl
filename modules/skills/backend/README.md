# Shep Skills native module

This internal Tauri plugin owns Shep's fixed agent-skill catalog, embedded
Markdown resources, installed-state inspection, and install/remove policy.

Commands are namespaced under `plugin:shep-skills|...` and require the matching
generated allow permissions. The host supplies a narrow project-root authority;
the module cannot write outside an exact registered project root selected by
that authority.
