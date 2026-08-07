# Git native extraction

Date: 2026-08-06

Task: `shep-3w1.8.3.2.2`

## Outcome

Git's native policy is now owned by the optional internal plugin crate at
`modules/git/backend`. The plugin owns repository DTOs, argument construction,
porcelain and numstat parsing, preview limits, worktree placement, file
visibility, mutations, and error normalization. The host retains project
registration and grants only an exact registered project root.

All 20 native commands use the `plugin:shep-git|...` namespace and generated,
explicit Tauri permissions. The old flat command registrations and forwarding
wrappers have been removed. There is one mutation owner during and after this
cutover.

## Authority boundary

The renderer still identifies the project by its stored path, but that string
is not treated as filesystem authority. For every command the host:

1. loads the registered projects from `WorkspaceManager`;
2. requires an exact string match to one registered project root; and
3. canonicalizes that registered root before returning authority to the
   plugin.

The plugin applies a second, operation-specific boundary:

- file arguments must be non-empty normalized relative paths;
- absolute paths, root components, platform prefixes, `.` components, and
  parent traversal are rejected;
- working-file reads canonicalize the target and reject symlink escapes;
- Git index and `HEAD` reads pass the validated relative argument directly to
  Git using an argument vector; and
- worktree destinations remain derived under the canonical sibling
  `.shep-worktrees/<repo>` root, with symlinked destination roots rejected.

The plugin does not import Shep's workspace implementation. Its only host port
is the `ProjectRootAuthority` trait, supplied when the host registers the
plugin.

## Build and permission shape

The host's `git-module` Cargo feature enables the optional
`tauri-plugin-shep-git` dependency and installs it through the shared module
installer. The normal Tauri profile lists one explicit permission for each
command. Existing module-disabled profiles enable the Git feature and include
the same permissions, so each profile continues to disable only its named
module.

`profiles/git-disabled/tauri.conf.json` omits Git permissions and builds the
host with `--no-default-features --features
todos-module,ports-module,skills-module`. This proves that native host code no
longer requires the Git crate.

## Characterization retained and strengthened

The six pre-extraction native repository fixtures moved with the backend
module. Three boundary tests were added:

- exact registered-root authorization;
- rejection of absolute and parent-traversing file arguments; and
- rejection of a working-tree symlink that escapes the authorized root.

The frontend characterization also asserts that current Git clients invoke
the namespaced plugin surface and do not call the old flat names.

## Verification evidence

The extraction was verified with:

```sh
cargo test --manifest-path modules/git/backend/Cargo.toml -- --test-threads=1
cargo check --manifest-path src-tauri/Cargo.toml
pnpm exec tsc --noEmit
pnpm test:git-characterization
pnpm verify:git-native-disabled
```

Results: nine backend tests and five frontend characterization tests passed;
the normal host compiled with Git enabled; and a production frontend plus
native Tauri build completed with Git disabled.

## Remaining seam

The frontend DTOs, client functions, stores, watcher integration, and UI
surfaces still occupy host-era paths. They already call the namespaced native
surface, but physical ownership moves in the next two slices. No temporary
flat native compatibility path remains.
