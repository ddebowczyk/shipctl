# Module API contract-boundary refactor — execution plan

## Contract

Move the shared host/module contract out of `modules/api/` into a top-level
`module-api/` package and make its three meanings visible in both languages:

```text
module-api/
├── frontend/
│   ├── package.json
│   ├── src/
│   │   ├── host/       # host → module ports and host-supplied contexts
│   │   ├── module/     # module → host contributions and callbacks
│   │   ├── protocol/   # shared identifiers, DTOs, parsers, wire contracts
│   │   └── index.ts    # complete compatibility export surface
│   └── tests/
├── backend/
│   ├── Cargo.toml
│   └── src/
│       ├── host/
│       ├── module/
│       ├── protocol/
│       └── lib.rs      # complete compatibility export surface
└── fixtures/
```

The retained `src/` roots are deliberate: `@shipctl/module-api` currently
exports `./src/index.ts`, and `shipctl-module-api` declares `src/lib.rs`.
Keeping them avoids changing the public package/crate loading model solely for
directory presentation.

## Invariants

1. The public identities remain `@shipctl/module-api` and
   `shipctl-module-api`; existing root imports remain valid.
2. `index.ts` and `lib.rs` re-export every currently public symbol. No current
   consumer may be changed to a deep import.
3. `module-api` is a shared-contract package, not a removable feature. It has
   no `module.yaml`, does not appear in module plug-out discovery, and does not
   receive a fake module profile.
4. The module boundary checker still inspects the API package and still rejects
   feature-module deep imports from `@shipctl/module-api`.
5. Rust and TypeScript fixtures remain shared at `module-api/fixtures`; all
   compile-time `include_str!`, tests, and ops proof paths point there.
6. No behavior, runtime dependency direction, package name, crate name, or wire
   schema changes are part of this refactor.

## Baseline evidence

- Worktree began clean on `main` at `37472b6 Release v0.7.6`; `git add -A`
  produced no staged changes, so no empty preservation commit is permitted.
- `modules/api` contains 10 frontend source files, 2 Rust source files, three
  frontend contract tests, and shared fixtures.
- No source imports `@shipctl/module-api/...`; consumers use the public package
  root.
- TypeScript `workspace/willRenameFiles --dry-run` for the nine initial source
  moves returns 43 contained import edits, including the compatibility barrel.
- The current package is deliberately excluded from `ops/modularity/bin/all.mjs`;
  this is evidence that it is not an ordinary removable module.

## Directional classification

The folders express *who implements or supplies a contract*, not who happens
to import a type.

| Direction | Frontend examples | Native examples |
| --- | --- | --- |
| `host/` | `ModuleHostServices`, `PanelHostPort`, `TerminalHostPort`, command/panel/surface contexts | `DurableWriteBarrier`, `TerminalAuthority`, driver registry |
| `module/` | `ShipctlModule`, contribution records, lifecycle callbacks, terminal presentation provider | `SnapshotProvider`, terminal factory/session/observer traits |
| `protocol/` | identifiers, immutable DTOs, component props, message/capability/schedule wire parsers | snapshot records, terminal IDs/DTOs/errors/observations/color theme |

Several old files mix those categories (`module.ts`, `panels.ts`,
`terminalHost.ts`, `lib.rs`, and `terminal_host.rs`). They must be split by
declaration, not simply placed wholesale in a directory whose name would be
false.

## Execution steps

### 1. Record the preserved baseline

**Outcome.** The pre-refactor worktree is known to be clean or is preserved in
a real commit before any refactor file is created.

**Work.** Run `git status --short`, `git add -A`, inspect the staged diff, and
commit only if it contains user work. Record the commit or clean result in the
task closure.

**Acceptance criteria.** There is no uncommitted pre-existing user change and
no empty commit.

**Validation.** `git diff --cached --quiet`; `git status --short`; `git log -1
--oneline` when a preservation commit exists.

### 2. Establish `module-api` as a top-level shared-contract package

**Outcome.** The old `modules/api` tree no longer exists; its frontend,
backend, fixtures, package manifests, and documentation are rooted at
`module-api/`, while package/crate names stay unchanged.

**Work.**

- Move the package tree with Git-aware moves, retaining `frontend/src` and
  `backend/src`.
- Add explicit `module-api/frontend` and `module-api/backend` workspace
  members; update every direct Cargo `path` dependency and the pnpm lockfile.
- Remove the obsolete `module.yaml`, remove the `api` discovery exception, and
  update modularity/check fixtures so top-level `module-api/frontend` is a
  recognized API package but not an ordinary module.
- Update fixture, Rust `include_str!`, and ops-proof paths in the same step so
  the physical move does not leave a broken intermediate repository.

**Acceptance criteria.**

- `module-api/frontend/package.json` names `@shipctl/module-api`; the backend
  manifest names `shipctl-module-api`.
- No live code, manifest, or validation fixture retains `modules/api`.
- `modules/` contains removable features only; `module-api` is discovered for
  boundary checking without entering plug-out/profile/manifest loops.
- Cargo and pnpm resolve the moved package without consumer import changes.

**Validation.** `rg -n 'modules/api'` over live code/configuration has no
unintentional result; `cargo metadata --no-deps --format-version 1`; `pnpm
install --lockfile-only`; `just modularity boundaries`; `just check manifests`;
`just check schemas`.

### 3. Partition the frontend contract by direction

**Outcome.** Every frontend declaration lives under `host/`, `module/`, or
`protocol/`, and `frontend/src/index.ts` preserves the current root API exactly.

**Work.**

- Move pure wire/parser files to `protocol/` (`capabilities`, `messages`, and
  `schedules`), keeping their tests next to the package and updating direct test
  imports.
- Split mixed declarations into directional files. In particular, separate
  host ports/contexts from module contribution records in command, panel,
  surface, module lifecycle, and terminal contracts.
- Keep all cross-direction dependencies type-only where possible. Do not add
  public subpath exports: the public API remains the root barrel.
- Use TypeScript LSP rename-file previews before each move; inspect paths and
  edit counts, then apply reviewed source changes and update the barrel.

**Acceptance criteria.**

- `frontend/src/{host,module,protocol}` all exist and contain only contracts of
  the stated direction.
- Every symbol previously exported by `frontend/src/index.ts` remains exported
  by the new root barrel with its original name.
- Existing consumers still import only `@shipctl/module-api`.
- Parser contract tests retain the same wire behavior and fixtures.

**Validation.** `lsproxy typescript workspace willRenameFiles --dry-run` for
planned file moves; `pnpm exec node --test module-api/frontend/tests/*.test.ts`;
`just check types`; `just modularity boundaries`; source checks for no legacy
relative imports and no `@shipctl/module-api/` consumer imports.

### 4. Partition the native contract by direction

**Outcome.** Native host ports, module-provided traits, and shared values have
separate Rust modules beneath `backend/src/{host,module,protocol}`, while
`shipctl_module_api::*` root imports remain source-compatible.

**Work.**

- Move snapshot and terminal DTOs, IDs, errors, and observations to
  `protocol/`.
- Put host-implemented authority/barrier/registry behavior in `host/` and
  module-implemented provider/factory/session/observer traits in `module/`.
- Rebuild `lib.rs` as the compatibility re-export boundary. Preserve any public
  `terminal_host` compatibility module only when a live external import proves
  it is needed.
- Update Rust `mod` declarations manually; rust-analyzer does not promise to
  rewrite them during file moves.

**Acceptance criteria.**

- The three native directories reflect the directional table above.
- Every current root-level public Rust import compiles unchanged.
- The crate remains a leaf: no new host/module/Tauri implementation dependency
  enters `Cargo.toml`.
- Existing crate tests still exercise terminal ID, barrier, and driver registry
  behavior.

**Validation.** Rust LSP move preview for review only; `cargo fmt --all
--check`; `cargo test -p shipctl-module-api`; `cargo check --workspace`; `rg
'shipctl_module_api::terminal_host'` to decide whether a compatibility module
is required.

### 5. Update durable documentation and enforcement evidence

**Outcome.** Current architecture documentation teaches `module-api` as a
top-level shared-contract package, and enforcement tests prove that it is not a
removable module while module boundary rules stay intact.

**Work.** Update root instructions/layout documentation, `modules/README.md`,
the moved frontend/backend READMEs, modularity fixture expectations, and any
current ops proof path. Leave dated plans and historical research unchanged
unless they purport to describe the current layout.

**Acceptance criteria.**

- Current guidance uses `module-api`, explains the three directions, and does
  not label it a feature module.
- Tests cover top-level API package discovery and preserve the existing
  no-deep-import rule.
- No current operational command contains a stale `modules/api` path.

**Validation.** `rg -n 'modules/api' AGENTS.md CLAUDE.md README.md core modules
ops justfile package.json pnpm-workspace.yaml Cargo.toml`; `pnpm exec node
--test ops/modularity/tests/*.test.mjs`; `just ops validate`.

### 6. Complete integration validation and commit the refactor

**Outcome.** The repository proves the new package layout, contract surface,
and feature boundaries end-to-end; the completed refactor is committed without
unrelated changes.

**Work.** Run the complete applicable test/type/schema/format suite, inspect
the diff and public export surface, resolve failures, stage all refactor files,
and create one focused commit.

**Acceptance criteria.**

- Every prior task is closed with its stated proof.
- No `modules/api` directory or live reference remains.
- Full frontend, Rust, modularity, formatting, schema, and manifest checks
pass.
- The final commit contains only the plan, Beads metadata, and refactor changes.

**Validation.** `just check all`; `just test full`; `git diff --check`; `git
status --short`; `git show --stat --oneline HEAD`; `bd status --json`; `bd show
<epic> --json`.

## Beads execution graph

```text
baseline
  └─ top-level package relocation
       └─ frontend directional partition
            └─ native directional partition
                 └─ documentation and enforcement
                      └─ final integration and commit
```

The frontend and native partitions could be independent after the physical
relocation, but this run executes ready work serially as requested.

## Known review points

- A TypeScript file-move LSP preview rewrites relative imports only; keep the
  root barrel stable so bare consumer imports do not receive an unnecessary
  mass rewrite.
- Rust `workspace/willRenameFiles` currently returns no module-declaration
  edits. Update `mod.rs`/`lib.rs` deliberately and validate with Cargo.
- A package move changes workspace discovery and the lockfile even though the
  package name stays stable. Treat those changes as required build metadata,
  not product API changes.
- Do not retrofit `module.yaml` path patterns to include `module-api`: that
  would incorrectly make a shared contract look removable. Removing the
  manifest and deleting the special case expresses the intended model.

## Approval and execution authority

The active user goal explicitly requests creation of this plan, conversion into
a Beads epic/tasks, and autonomous task-by-task execution. This document is
therefore the reviewed execution specification for the requested refactor.
