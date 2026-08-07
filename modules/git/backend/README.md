# Shep Git native module

This internal Tauri plugin owns Git command construction, output parsing,
repository DTOs, preview limits, worktree placement, and repository mutations.

Renderer calls are namespaced under `plugin:shep-git|...` and require one
generated permission per command. The host supplies only an exact
registered-project root authority. File-oriented commands accept normalized
relative paths; absolute paths, parent traversal, and working-tree symlink
escapes are rejected.

The crate is optional through Shep's `git-module` Cargo feature. It does not
import the host workspace implementation.
