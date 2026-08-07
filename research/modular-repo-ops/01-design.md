# Modular repo ops — design

Date: 2026-08-07
Depends on: `00-current-state-and-gaps.md`

## 1. The idea, stated precisely

The app has modules (`modules/*`) that plug into a host and can be compiled out. The repo
needs the same thing one level up: **repo-ops capabilities** that plug into a thin ops host
and can be swapped or removed without touching the app or each other.

Two layers, deliberately not mixed:

| | app modules | ops capabilities |
|---|---|---|
| Location | `modules/<name>/{backend,frontend}` | `ops/<name>/` |
| Ships in the binary | yes | **never** |
| Consumers | the running app | developers and agents |
| Plug-in point | Tauri plugin + module-api | `justfile` + `capability.yaml` |
| Proof of isolation | `verify:<mod>-plugout` | `just ops validate` |

`ops/` is the answer to "one dir so we can find, replace, and vary them". It is not a
module in `modules/` because ops capabilities must never be reachable from app code, and
`modules/` is glob-discovered by both `pnpm-workspace.yaml` and the Cargo workspace.

## 2. Layout

```
justfile                        # 8 lines: imports ops modules, nothing else
ops/
├── README.md                   # what a capability is; how to add one
├── ops.yaml                    # which provider is active for each interface
├── schema/
│   ├── capability.schema.yaml  # validates every ops/*/capability.yaml
│   └── ops.schema.yaml         # validates ops.yaml
├── bin/
│   ├── ops-validate.mjs        # schema + invariant checks over ops/
│   └── ops-list.mjs            # machine-readable capability inventory
│
├── test/
│   ├── capability.yaml
│   ├── justfile                # recipes: fast, full, module, watch
│   ├── skills/<name>/SKILL.md  # agent procedures (see §7)
│   └── bin/
├── check/
│   ├── capability.yaml
│   ├── justfile                # typecheck, lint, fmt, clippy, boundaries, all
│   ├── skills/
│   └── bin/
├── build/
│   ├── capability.yaml
│   ├── justfile                # local, release, icon, bump, archive
│   ├── skills/
│   ├── schema/build-manifest.schema.yaml
│   └── bin/                    # build-local.sh, release-build.sh, ...
├── modularity/
│   ├── capability.yaml
│   ├── justfile                # boundaries, plugout <mod>, disabled <mod>, all
│   ├── skills/
│   │   ├── module-plugout-gate/SKILL.md
│   │   └── add-a-module/SKILL.md
│   ├── schema/module.schema.yaml   # validates modules/*/module.yaml (§5)
│   ├── fixtures/               # moved from scripts/smoke
│   └── bin/                    # ONE runner, replacing 6 verifiers
│                               # note: no per-module data here — see 04 §4.1
├── upstream/
│   ├── capability.yaml
│   ├── justfile                # fetch, queue, stub, triage, close
│   ├── skills/
│   │   └── upstream-review/SKILL.md   # ← 02-review-runbook.md
│   ├── schema/{entry,state,path-map}.schema.yaml
│   ├── state.yaml  path-map.yaml
│   └── log/<sha>.md
└── _attic/                     # dev spikes, explicitly unsupported (G8)
```

`scripts/` disappears. `profiles/` moves under the capability that owns it. Root
`test-prompt.mjs` goes to `_attic/`.

## 3. The capability contract

Every capability directory is self-describing and self-contained. Five required elements:

1. **`capability.yaml`** — the manifest. Machine-readable identity, interface, dependencies,
   owned paths, and command list.
2. **`justfile`** — the human/agent entry point. Recipes are *thin wrappers*; real logic
   lives in `bin/` so nothing depends on `just` being installed.
3. **`skills/<name>/SKILL.md`** — one or more procedures in agent-readable form: when to use,
   how to decide, what the invariants are, what to do on failure. A directory per skill, so
   a procedure can carry its own templates, examples, and reference files.
4. **`bin/`** — its scripts. No capability reaches into another's `bin/`.
5. **`schema/`** — YAML Schema for any data it owns, validated with `ys`.

`tests/`, `data/`, `fixtures/` as needed.

### `capability.yaml`

```yaml
schema_version: 1
id: modularity
provides: modularity            # the interface; several dirs may provide one interface
description: Verify app modules can be compiled out and stay within their boundaries.
status: supported               # supported | experimental | deprecated
requires:
  tools: [node, pnpm, cargo, git]
  capabilities: [check]         # ops-level dependencies, must be acyclic
owns:                           # deleted along with the capability
  - ops/modularity/**
reads:                          # inspected, never written
  - modules/**
  - src-tauri/**
generates:                      # written by this capability, owned by the app
  - profiles/**
commands:
  - name: boundaries
    summary: Static import-boundary check across module packages.
    lane: fast
  - name: plugout
    summary: Prove one module can be deleted entirely and the app still builds.
    lane: slow
    args: [module]
skills:                         # procedures under skills/<name>/SKILL.md
  - name: module-plugout-gate
    summary: Run and record the full plug-out gate for a module.
  - name: add-a-module
    summary: Create a new app module and its manifest, wired to every declaration site.
```

`lane: fast | slow` is the field that makes a repo-wide fast lane composable: `just test fast`
and `just check all` collect every `lane: fast` command across capabilities, so a new
capability joins the fast lane by declaring itself, not by editing a central list.

## 4. Discoverability: `just` with submodules

`just` 1.47.1 supports stable modules, which gives a two-level, self-documenting surface:

```just
# ./justfile
mod test      'ops/test/justfile'
mod check     'ops/check/justfile'
mod build     'ops/build/justfile'
mod modularity 'ops/modularity/justfile'
mod upstream  'ops/upstream/justfile'
mod ops       'ops/justfile'

default:
    @just --list --list-submodules
```

```
just                          # every capability and recipe, one screen
just test fast                # the fast lane
just modularity plugout git   # one plug-out proof
just upstream queue           # untriaged upstream commits
just ops validate             # the meta-check
```

Two rules keep this honest:

- **Recipes must be thin.** Every recipe is one line calling `bin/`. `just` is a discovery
  and dispatch layer, never a place where logic lives — the toolchain note in the user's
  global config says `just` is Mac-only, so CI and Linux agents must be able to call
  `node ops/test/bin/run.mjs --lane fast` directly and get identical behaviour.
- **`package.json` scripts become delegators**, not a second implementation:
  `"test": "just test fast"` with a plain fallback documented in `ops/test/SKILL.md`.

## 5. Data-driven modules: the manifest that kills the duplication

G3/G4 are solved by one file per module, consumed by every ops capability that currently
hardcodes the same facts.

```yaml
# modules/git/module.yaml   -- lives with the module, not in ops/ (see 04 §4.1)
schema_version: 1
id: git
frontend:
  package: "@shep/module-git"
  path: modules/git/frontend
  composition_symbol: gitModule
backend:
  crate: tauri-plugin-shep-git
  path: modules/git/backend
  cargo_feature: git-module
  dependency_alias: shep-module-git
  plugin_init: "shep_module_git::init()"
  host_glue: []                        # extra files/edits, e.g. src-tauri/src/ports_module.rs
tauri:
  capability_identifier: git
  permissions: [shep-git:allow-git-status, ...]
profile: profiles/git-disabled/tauri.conf.json
tests:
  frontend: modules/git/frontend/tests
  backend: cargo test --manifest-path modules/git/backend/Cargo.toml
```

Discovered by the same `modules/*` glob that `pnpm-workspace.yaml` and the Cargo workspace
already use. One runner reads them and performs the delete-and-rebuild proof generically.
Expected outcome: **six verifiers (~1,178 lines) collapse to one runner (~250 lines) plus six
manifests (~30 lines each)**, and the manifest becomes the single declaration that
`ops/check` can cross-validate against `Cargo.toml`, `lib.rs`, `enabledModules.ts`,
`package.json`, and `tauri.conf.json` — closing G4 as a side effect.

Keeping the manifest inside the module is load-bearing, not cosmetic: plug-out deletes
`modules/git/` outright, so the manifest must go with it. A copy under `ops/` would survive
as an orphan and the runner would have to clean up after itself — see `04-ownership-boundaries.md`
§4.1. It also leaves `ops/modularity` with zero per-module knowledge, which is what makes it
genuinely replaceable.

Note the sequencing risk: `ports` and `assistants` have host glue the others lack. Generalize
from **two** modules before assuming the shape (see `03-migration-plan.md`).

## 6. Variants and replaceability

`provides` decouples the interface from the implementation; `ops.yaml` selects.

```yaml
# ops/ops.yaml
schema_version: 1
active:
  test: test
  check: check
  build: build
  modularity: modularity
  upstream: upstream
```

To try an alternative test runner: add `ops/test-vitest/` with `provides: test`, flip the
entry, run both, delete the loser. Nothing else in the repo changes — the same
`integration: variant` reasoning applied to upstream changes in
`research/integrate-upstream-changes/00-problem-and-design.md` §3.5, applied here to ops.

Keep v1 honest: `ops.yaml` exists and is validated, but there is **no dispatch engine**.
The root `justfile` names providers directly. Build the indirection when a second provider
actually exists; until then it is a comment with a schema.

## 7. Skills: plain directories, invoked by path

Skills live at `ops/<capability>/skills/<skill-name>/SKILL.md` and are **not** registered
with any agent harness. An agent is pointed at the path and told to follow it:

> Follow the procedure in `ops/upstream/skills/upstream-review/SKILL.md`.

No `.claude/` directory, no symlinks, no `link-skills` recipe, no dependency on how a
particular harness discovers skills. This is the right call for three reasons:

- **Self-containment holds.** A capability directory is complete and portable — copy
  `ops/upstream/` into another repo and its procedures come with it.
- **Harness-agnostic.** Claude Code, Codex, and a human all consume the same file the same
  way. Auto-registration would bind the design to one of them.
- **No sync step.** Nothing can drift between a registered copy and the real one.

A skill is a directory rather than a bare file so it can carry its own templates, examples,
and reference material (`SKILL.md` plus `templates/`, `reference/`).

### What this gives up, and the substitute

Auto-registration bought one thing: an agent noticing a relevant skill *without being told*.
Replace that with cheap, explicit discovery rather than machinery:

- `capability.yaml` lists its skills with one-line descriptions; `just ops skills` prints the
  full inventory across capabilities in one screen.
- The repo `CLAUDE.md` gains a short section: "repo operations live in `ops/`; run `just` to
  see commands and `just ops skills` to see procedures." That single pointer is what makes
  an unprompted agent find them.
- `ops/README.md` indexes them for humans.

Frontmatter with `name` and `description` is still worth keeping in each `SKILL.md` — not for
a harness, but because it is what `just ops skills` reads and what a reader sees first.

## 8. Schemas and self-validation

`ys` validates YAML Schema; `yamllint` catches formatting. `just ops validate` runs:

1. every `ops/*/capability.yaml` against `schema/capability.schema.yaml`
2. `ops.yaml` against its schema, and every `active:` value resolves to a real provider
3. every `modules/*/module.yaml` against `ops/modularity/schema/module.schema.yaml`
4. `ops/upstream/{state,path-map}.yaml` against theirs
5. invariants a schema cannot express: `requires.capabilities` is acyclic; every command in
   `capability.yaml` exists as a recipe in its `justfile`; every entry in `skills:` resolves
   to a real `skills/<name>/SKILL.md` with frontmatter (and every skill directory is listed);
   no capability imports another's `bin/`

Item 5 is the part that actually holds the design together over months — schema validation
alone would let the manifests drift into decoration.

`ops validate` is itself `lane: fast`, so the meta-layer is checked by the same lane it
defines.

## 9. What this design deliberately does not do

- **No generic plugin runtime for ops.** Capabilities are directories with a convention,
  discovered by glob. No registry service, no lifecycle, no versioning.
- **No abstraction over `pnpm`/`cargo`.** Recipes call the real tools.
- **No CI in v1.** G6 is real, but the capability layer is the prerequisite: once
  `just check all` and `just test fast` exist, CI is a ten-line workflow calling them.
  Designing both at once risks shaping the capabilities around a CI runner.
- **No move of app modules.** `modules/` is untouched by this work, except that
  module-owned tests come home (G5).
