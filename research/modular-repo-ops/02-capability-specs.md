# Capability specs

Concrete definition of the five capabilities that cover what exists today, including the
full disposition of the current 40 `package.json` scripts and 23 `scripts/` files.

## 1. `ops/test`

**Owns** test execution and the lane split (G1). Does not own boundary or plug-out checks —
those belong to `modularity`.

### Lanes

| Recipe | Contents | Target |
|---|---|---|
| `just test fast` | all `node --test` suites: `modules/*/frontend/tests/**`, host-rail tests | < 30 s |
| `just test rust` | `cargo test --workspace` (src-tauri + 8 module crates) | minutes |
| `just test full` | `fast` + `rust` + `just modularity all` | long; pre-gate only |
| `just test module <id>` | that module's frontend + backend tests, from its manifest | seconds |

`fast` must stay genuinely fast or it will not be run; anything invoking `cargo build` or
`tauri build` belongs in `full`.

### Absorbs

All 12 `test:*` scripts. The per-module ones (`test:git-characterization`,
`test:todos-characterization`, `test:ports-characterization`,
`test:skills-characterization`, `test:assistant-providers-characterization`) collapse into
`just test module <id>` driven by `tests:` in each module manifest — the manifest already
carries both the frontend glob and the cargo invocation, so five scripts become zero.

Surface-level suites (`test:panels`, `test:project-surfaces`, `test:global-surfaces`,
`test:project-data`, `test:project-actions`, `test:terminal-sessions`,
`test:panel-persistence`, `test:module-composition`) are host-rail contract tests; they run
in `fast` as a group and stay individually addressable via `just test one <file>`.

### Relocations (G5)

- Host-rail tests `scripts/tests/{moduleComposition,globalSurfaces,projectActions,projectFacts,terminalSessions,projectCapabilityData,panelRegistry,panelPersistence,panelTabs}.test.ts` → `src/core/**/tests/` (they test the host, not ops).
- `scripts/tests/gitCharacterization.test.ts` → `modules/git/frontend/tests/`.
- `scripts/tests/assistantProvidersCharacterization.test.ts` → merge into
  `modules/assistants/frontend/tests/` (it duplicates that directory today).
- `scripts/tests/moduleBoundaries.test.mjs` → `ops/modularity/tests/` (it tests the checker).

Do this relocation as its own commit, before any capability wiring — it is a pure `git mv`
plus import-path fixes, and mixing it into the ops migration makes both unreviewable.

## 2. `ops/check` — mostly new (G2)

**Owns** every non-executing correctness gate.

| Recipe | Command | Status |
|---|---|---|
| `just check types` | `tsc --noEmit` | **new** |
| `just check types-all` | + `tsc -p scripts/smoke/*/tsconfig.json` | absorbs `typecheck:panel-host-smoke` |
| `just check fmt` | `cargo fmt --all --check` | **new** |
| `just check clippy` | `cargo clippy --workspace --all-targets -- -D warnings` | **new** |
| `just check schemas` | `ys` over `ops/**/*.yaml` + `yamllint` | **new** |
| `just check manifests` | module manifests vs the six declaration sites (G4) | **new** |
| `just check all` | every `lane: fast` check above | **new** |

`check manifests` is the highest-value new gate: it cross-validates each
`modules/<id>/module.yaml` against `src-tauri/Cargo.toml` features and dependencies,
`src-tauri/src/lib.rs` plugin registration, `src/core/modules/enabledModules.ts`, root
`package.json` dependencies, `src-tauri/tauri.conf.json` capabilities, and the module's
profile. It turns a six-place hand-sync into a one-place declaration with a checker.

Expect `clippy -D warnings` to fail loudly on first run against a 332-file refactor. Land it
non-blocking (`just check clippy-soft`) and ratchet, rather than blocking the migration on a
cleanup of unknown size.

## 3. `ops/build`

**Owns** producing and archiving artifacts.

| Recipe | Backing script |
|---|---|
| `just build app` | `pnpm build` (boundaries + tsc + vite) |
| `just build local` | `bin/build-local.sh` → `builds/<ts>-<target>-g<sha>-<state>/` |
| `just build local-archive` | `bin/build-local.sh --archive-only` |
| `just build release` | `bin/release-build.sh` |
| `just build dmg` | `bin/post-build-dmg.sh` |
| `just build icon` | `bin/generate-icon.mjs` |
| `just build bump <version>` | `bin/bump-version.sh` |
| `just build update-json` | `bin/generate-update-json.sh` |

Two improvements while moving:

- **Formalize `build.json`** as `ops/build/schema/build-manifest.schema.yaml`. It already
  declares `schema_version: 1` with no schema to validate against; `just build local` should
  validate its own output with `ys` before reporting success.
- **Parameterize the target** (G7): `just build local target=aarch64-apple-darwin`, with the
  current value as the default rather than a constant inside the script.

On G9 (`builds/` gitignored): keep bundles ignored, but consider committing manifests to
`ops/build/history/<ts>.json`. It is the only cheap way to answer "what did we ship, from
which commit, with which hashes" — a question the current setup cannot answer after a
`builds/` cleanup. Optional; flagged, not decided.

## 4. `ops/modularity` — the crown jewel

**Owns** every proof that the module architecture actually holds.

| Recipe | Absorbs |
|---|---|
| `just modularity boundaries` | `check:module-boundaries` |
| `just modularity plugout <id>` | 6 × `verify:*-plugout` scripts |
| `just modularity frontend-disabled <id>` | 3 × `verify:*-frontend-disabled` |
| `just modularity native-disabled <id>` | 5 × `verify:*-native-disabled` |
| `just modularity fixture` | `build:module-fixture`, `verify:module-fixture-plugout` |
| `just modularity smoke <fixture>` | `smoke:panel-host`, `smoke:module-fixture` |
| `just modularity profiles-check` | **new** — assert `profiles/*` match the manifests |
| `just modularity profiles-sync` | **new** — regenerate `profiles/*` from the manifests |
| `just modularity all` | every module × every proof |
| `just modularity gate <id>` | the full plug-out gate for one module, in gate order |

`profiles/` stays at the repo root as app configuration and becomes *generated* data rather
than hand-maintained (`04-ownership-boundaries.md` §4.2). It is listed under `generates:` in
`capability.yaml`, not `owns:`.

`just modularity gate <id>` is worth calling out: `research/shep-core-and-modules/` contains
eight hand-written gate documents (`*-plugout-gate.md`, `07/08-phase-*-gate.md`) describing
sequences that were executed manually. Encoding the sequence as a recipe turns a document
into something reproducible, and lets the gate doc record *results* rather than *steps*. The
judgement that cannot be encoded — what counts as a clean gate, what to do when a step fails
— goes in `skills/module-plugout-gate/SKILL.md` next to it.

The generic runner replaces the six copies described in `00-current-state-and-gaps.md` §G3,
driven by the manifests at `modules/*/module.yaml`. `scripts/lib/module-plugout.mjs`
already contains the shared primitives (`run`, `capture`, temp-worktree handling) — it is the
seed of the runner, not a rewrite.

**Generalize from two modules, not one.** `todos`/`skills` are the simple shape; `ports` and
`assistants` carry host glue (`src-tauri/src/ports_module.rs`, `host_services()`) that the
others lack. Build the runner against `todos` **and** `ports` together so the `host_glue`
field is designed against a real case.

## 5. `ops/upstream`

**Owns** the upstream review ledger designed in `research/integrate-upstream-changes/`.
That work already specifies `state.yaml`, `path-map.yaml`, `log/<sha>.md` and a runbook —
this capability is where it lands, gaining schemas and recipes.

| Recipe | Action |
|---|---|
| `just upstream fetch` | `git fetch upstream --tags`, update `last_fetch` in `state.yaml` |
| `just upstream queue` | `git log --no-merges --reverse upstream-reviewed..upstream/main` |
| `just upstream stub` | create `pending` ledger entries for the whole queue |
| `just upstream triage <sha>` | show diff + path-map verdict hints |
| `just upstream status` | pending / adopt / adapt / reject / n-a counts |
| `just upstream close` | verify none pending, advance `upstream-reviewed`, append batch |

`02-review-runbook.md` becomes `ops/upstream/skills/upstream-review/SKILL.md` largely
verbatim, with the entry and batch templates from `01-ledger-format.md` alongside it as
`templates/`. The ledger frontmatter schema becomes `ops/upstream/schema/entry.schema.yaml`,
validated by `just check schemas` (frontmatter extracted with `mq` or a ten-line reader).

Invoke it by pointing an agent at the path — "follow
`ops/upstream/skills/upstream-review/SKILL.md`" — not through any harness registration.

Move rather than copy — `research/integrate-upstream-changes/` keeps the design rationale
(`00-problem-and-design.md`), `ops/upstream/` gets the operational files. Two copies of a
runbook is exactly the drift the whole design is meant to prevent.

## 6. `ops/_attic`

Explicitly unsupported, excluded from `ops validate` and from every lane. Contents (G8):
`probe-usage.sh` (41 KB), `import-live-agent-recovery.mjs`, `update_model_pricing.py`,
`test-prompt.mjs` (currently in the repo root).

A one-line `README.md` per file: what it was for, when last used, whether it still works.
If `update_model_pricing.py` is to be kept, it needs a `uv` script header per the standing
Python-tooling preference; if not, delete it. The point of `_attic` is that "unknown status"
becomes a *stated* status.

## 7. Disposition summary

| Today | Goes to |
|---|---|
| 12 `test:*` scripts | `ops/test` (5 collapse into `test module <id>`) |
| 13 `verify:*` scripts | `ops/modularity` (6 collapse into one runner) |
| `check:module-boundaries`, `test:module-boundaries` | `ops/modularity` |
| `build`, `build:local`, `build:module-fixture` | `ops/build` (fixture → `ops/modularity`) |
| `smoke:*`, `typecheck:panel-host-smoke` | `ops/modularity`, `ops/check` |
| `dev`, `tauri`, `preview` | stay in `package.json` — app dev loop, not repo ops |
| `scripts/{build,release,bump,icon,update-json}*` | `ops/build/bin` |
| `scripts/{check,verify}-*.mjs`, `scripts/lib` | `ops/modularity/bin` |
| `scripts/smoke/` | `ops/modularity/fixtures` |
| `profiles/` | **stays at root**, generated by `ops/modularity` |
| `scripts/tests/` | split per G5 — mostly to `src/core`, none stay in ops except one |
| 4 dev spikes | `ops/_attic` |

Net: `scripts/` ceases to exist at the repo root, `profiles/` survives as generated app
configuration, and `package.json` drops from 40 scripts to ~6 delegators plus the app dev
loop. What stays where and why: `04-ownership-boundaries.md`.
