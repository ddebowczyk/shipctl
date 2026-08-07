# Extension package and registry

## Package layout

Use a signed archive with a product-specific extension, for example
`.shep-extension`:

```text
terminal-history.shep-extension
├── manifest.toml
├── signature.json
├── runtime/
│   ├── terminal-history.wasm
│   ├── dist/index.js
│   └── native/
│       ├── aarch64-apple-darwin/terminal-history
│       ├── x86_64-apple-darwin/terminal-history
│       ├── x86_64-pc-windows-msvc/terminal-history.exe
│       └── x86_64-unknown-linux-gnu/terminal-history
├── ui/
│   ├── contributions.json
│   ├── index.html
│   └── assets/
├── resources/
├── schemas/
├── migrations/
└── docs/
```

Only files declared by the manifest should be accepted. Package extraction must
reject absolute paths, parent traversal, symlink escapes, duplicate paths, and
files whose hashes do not match the signed manifest.

## Manifest contract

The manifest should include at least:

```toml
schema_version = 1
id = "dev.shep.terminal-history"
name = "Terminal History"
version = "1.4.0"
publisher = "shep"
host_api = ">=1.3,<2"

[runtime]
kind = "process"
entrypoint = "runtime/native/${target}/terminal-history"
protocol = "shep-extension-rpc/1"

[contributes]
panels = ["terminal-history"]
commands = ["terminal.history.search"]
settings = ["terminalHistory.retention"]

[permissions]
terminal = ["observe-output", "read-history"]
workspace = ["read:.shep/history/**"]
network = []
process = []
```

Additional fields should cover package hashes, minimum OS versions, supported
targets, entrypoint arguments controlled by the host, activation conditions,
resource limits, migration versions, and UI isolation mode.

## Package identity

An extension ID is permanent and publisher-qualified. Identity must not depend
on display name or installation directory. The tuple of extension ID, version,
publisher key, and content digest identifies an immutable package version.

## Installation layout

Separate immutable package code from mutable data:

```text
extensions/<id>/<version>/       immutable verified package
extension-data/<id>/             persistent extension-owned data
extension-cache/<id>/            disposable cache
extension-state/<id>/            enablement, grants, health, active version
extension-staging/<operation-id>/ temporary installation work
```

This permits side-by-side versions, atomic activation, rollback, code removal
without data loss, and explicit data purging.

## Registry model

Filesystem scanning discovers candidates, but the management registry is the
authoritative record of:

- installed versions and content digests;
- active version;
- enabled state by user or workspace scope;
- granted and denied capabilities;
- last activation and health result;
- pending migration or rollback state;
- package source and publisher trust record.

Registry changes must be transactional. A partially extracted directory must
never become an installed extension.

## Discovery scopes

Potential scopes are:

- system-managed extensions;
- user-installed extensions;
- workspace-recommended extensions;
- development extensions loaded from explicit paths.

Workspace content must not silently activate executable code. A workspace may
recommend an extension ID and version, but installation and permissions remain
an explicit user or policy decision.

## Catalogue

A future catalogue should publish signed metadata and package digests rather
than act as the runtime authority. The local extension manager must verify the
downloaded package independently of transport and catalogue trust.
