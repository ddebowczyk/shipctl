# Repo ops — current state and gaps

Date: 2026-08-07
Scope: everything that operates *on* the repo (test, build, check, modularity
verification, upstream review) as opposed to code that ships *in* the app.

## 1. What exists today

### Entry points

There is exactly one: `package.json`, with **40 scripts**. No `justfile`, no `Makefile`,
no `.github/` workflows (the directory is empty), no `.claude/` project config.

Composition of those 40 scripts:

| Group | Count | Examples |
|---|---|---|
| `test:*` per module/surface | 12 | `test:git-characterization`, `test:panels`, `test:project-surfaces` |
| `verify:*` plug-out / disabled | 13 | `verify:todos-plugout`, `verify:git-native-disabled` |
| `build*` | 3 | `build`, `build:local`, `build:module-fixture` |
| `smoke:*`, `typecheck:*` | 3 | `smoke:panel-host`, `typecheck:panel-host-smoke` |
| dev/tauri/preview | 4 | `dev`, `tauri`, `preview` |
| boundary checks | 2 | `check:module-boundaries`, `test:module-boundaries` |

### `scripts/` — a flat directory mixing four unrelated concerns

```
build-local.sh  release-build.sh  post-build-dmg.sh  bump-version.sh   <- build/release
generate-update-json.sh  generate-icon.mjs

check-module-boundaries.mjs  verify-*.mjs (9 files)  lib/module-plugout.mjs  <- modularity QA
tests/ (12 files)  smoke/ (2 apps)

probe-usage.sh (41 KB)  import-live-agent-recovery.mjs                   <- dev spikes
update_model_pricing.py  ../test-prompt.mjs (at repo root)
```

### Supporting data, already effectively a schema

- `profiles/{fixture,todos,ports,skills,git,assistants}-disabled/tauri.conf.json` — six
  hand-maintained Tauri configs used to prove each module can be compiled out.
- `builds/<ts>-<target>-g<sha>-<clean|dirty>/build.json` — build manifests that already
  carry `schema_version: 1`. Good instinct, no schema file to validate against.
- `src-tauri/Cargo.toml` `[features]` — one feature per module, `default` lists five.
- `pnpm-workspace.yaml` (`modules/*/frontend`) and root `Cargo.toml`
  (`members = ["src-tauri", "modules/*/backend"]`) — module discovery already works by glob.

### Toolchain present on this machine

`just 1.47.1` (submodules stable), `ys 0.9.1` (YAML Schema), `yamllint 1.38.0`,
`yq 4.53.2`, `bd` (87 issues), `pnpm`, `cargo`.

## 2. Gaps

### G1 — No aggregate test lane, and no fast/full split

There is no `test` script. Running "the tests" today means knowing which 12 of the 40
scripts are the test ones and running them by hand, in an order nobody has written down.
The fast/full distinction the design needs does not exist in any form.

### G2 — No typecheck, lint, or format lane at all

`tsc` runs only as a side effect of `pnpm build`. There is no standalone `typecheck`.
There is **no `cargo clippy`, no `cargo fmt --check`, no ESLint, no `tsc --noEmit`
recipe anywhere in the repo.** For a codebase mid-refactor across 332 files, this is the
most expensive gap on the list.

### G3 — ~1,100 lines of near-duplicate plug-out verifiers

`verify-{todos,ports,skills,git,commands,module-fixture}-plugout.mjs` total 1,178 lines.
Diffing `verify-todos-plugout.mjs` against `verify-ports-plugout.mjs` shows they are ~85%
identical; the true delta is a handful of *values*:

```
package name      @shep/module-todos      @shep/module-ports
composition sym   todosModule             portsModule
cargo feature     todos-module            ports-module
crate             tauri-plugin-shep-todos tauri-plugin-shep-ports
capability id     todos                   ports
host glue         (none)                  src-tauri/src/ports_module.rs, host_services()
```

Every new module copies the file and edits those values. This is the single strongest
argument for the manifest-plus-runner approach: it is data pretending to be code.

### G4 — The same module is declared by hand in six places

`src-tauri/Cargo.toml` features + dependency, `src-tauri/src/lib.rs` plugin registration,
`src/core/modules/enabledModules.ts`, root `package.json` dependencies, `tauri.conf.json`
capabilities, `profiles/<mod>-disabled/tauri.conf.json`. Nothing cross-checks them.

G3 is the symptom; this is the disease. A module manifest is the fix, and the plug-out
verifier becomes its consumer rather than its duplicate.

### G5 — Test files live on the wrong side of the module boundary

`scripts/tests/` holds 12 test files while `modules/*/frontend/tests/` holds others. Reading
their imports:

- **Host-rail contract tests** (belong to the host, not to `scripts/`): `moduleComposition`,
  `globalSurfaces`, `projectActions`, `projectFacts`, `terminalSessions`,
  `projectCapabilityData`, `panelRegistry`, `panelPersistence`, `panelTabs`.
- **Module-owned** (belong next to their module): `gitCharacterization`,
  `assistantProvidersCharacterization` — the latter duplicating
  `modules/assistants/frontend/tests/`.
- **Ops-owned**: `moduleBoundaries.test.mjs` tests the boundary checker itself.

The source layer is being modularized while the test layer stayed centralized.

### G6 — No CI, so every gate is a local ritual

`.github/` is empty. The plug-out gates recorded in `research/shep-core-and-modules/*-gate.md`
were run by hand. Nothing prevents a regression between gate runs.

### G7 — Build is macOS/aarch64-only and hardcoded

`build-local.sh` hardcodes `aarch64-apple-darwin`, `shep.app`, `ditto`, `shasum`. Reasonable
today, but the target is a constant inside a script rather than a parameter.

### G8 — Dev spikes are indistinguishable from supported tooling

`probe-usage.sh` (41 KB), `import-live-agent-recovery.mjs`, `update_model_pricing.py` (Python,
with no `uv` setup despite the standing preference), and `test-prompt.mjs` sitting in the repo
root. Nothing marks these as one-offs, so agents treat them as maintained surface area.

### G9 — Build manifests are gitignored

`builds/` is in `.gitignore`, so `build.json` — the one artifact that already has a schema
version — leaves no reviewable history.

### G10 — No project-level agent configuration

No `.claude/` directory: no project skills, no settings, no permission allowlist. Every
agent rediscovers how to run things from `package.json`, which is precisely the
discoverability problem this work is meant to solve.

## 3. What this implies for the design

1. The capability layer is not a greenfield abstraction — **~1,900 lines of ops code already
   exist** and are misfiled rather than missing. This is mostly a re-homing job.
2. The highest-value first capability is `modularity`, because G3 + G4 give it an immediate,
   measurable payoff (delete ~900 lines, gain a cross-check).
3. `test` and `check` are partly greenfield (G1, G2) — they must be *created*, not moved.
4. Data-driven-with-schemas is validated by the evidence, not just by taste: profiles,
   build manifests, and plug-out verifiers are all already data, three of them hand-copied.
5. Anything the design proposes must survive having no CI (G6), so recipes must be runnable
   locally and cheaply, with the fast lane genuinely fast.

Design: `01-design.md`. Per-capability specs: `02-capability-specs.md`. Sequencing:
`03-migration-plan.md`.
