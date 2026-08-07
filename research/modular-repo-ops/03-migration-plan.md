# Migration plan

Sequenced so that every step is independently reviewable and the repo stays working
throughout. Each step is a commit; steps 1–4 are prerequisites, 5–9 can be reordered.

The governing constraint: **the team is many parallel agents on module branches.** A
big-bang move of `scripts/` would conflict with every branch in flight. Ordering below puts
the high-conflict moves early and small, and the high-value work late and additive.

## Step 0 — Decide the name

**Is `ops/` the right name?** Alternatives considered: `tools/` (collides with the common
meaning of "vendored binaries"), `devkit/`, `.ops/` (hidden — bad for discoverability by
humans *and* agents), `repo/`. `ops/` is short, unambiguous, sorts high, and is clearly not
app code. Change it now or never — every path in these documents depends on it.

Skill registration is **not** a decision to make: skills are plain directories under
`ops/<capability>/skills/<name>/`, invoked by pointing an agent at the path. No `.claude/`
wiring, no symlinks, no harness coupling (`01-design.md` §7).

## Step 1 — Root `justfile` over the existing scripts

No moves. A root `justfile` whose recipes call the current `pnpm run …` names, plus
`ops/README.md` describing the target shape.

This delivers the discoverability win immediately (G1's symptom, if not its cause), is
zero-conflict, and gives every subsequent step a stable entry point to re-point.

Includes a first honest `just test fast` — the aggregate that does not exist today. Even as
a hardcoded list of the 12 `test:*` scripts, it is the single highest-value output of this
whole plan and should not wait for the capability layer.

## Step 2 — Relocate misfiled tests (G5)

Pure `git mv` + import fixes, per `02-capability-specs.md` §1. Do it before `scripts/` moves,
in its own commit, so the diff reads as "tests moved" and nothing else.

Highest conflict risk of any step — coordinate a quiet window across agent branches.

## Step 3 — `ops/` skeleton and the meta-layer

Create `ops/` with `README.md`, `ops.yaml`, `schema/capability.schema.yaml`,
`bin/ops-validate.mjs`, `bin/ops-list.mjs`, and empty capability directories each holding
only `capability.yaml` + `justfile` + `SKILL.md`.

Recipes still delegate to `pnpm run …`. Nothing has moved yet; `just ops validate` passes on
an empty-but-well-formed structure. This is the seam, built before anything plugs into it.

`ops-validate.mjs` implements the five boundary invariants from `04-ownership-boundaries.md`
§5 from the start — including the one-line extension to `check-module-boundaries.mjs` that
forbids app code importing from `ops/**`. Building the invariants before the content is what
keeps `ops/` from becoming the next `scripts/`.

## Step 4 — Module manifests + `check manifests` (G4)

Write `modules/<id>/module.yaml` for all eight modules and the cross-validator that
checks them against the six declaration sites. **Write the manifests before the runner** —
if `check manifests` passes against today's hand-maintained reality, the manifests are proven
accurate, and the runner in step 5 can be trusted to consume them.

If it does not pass, that is a finding worth having on its own: the six sites have already
drifted.

## Step 5 — Generic plug-out runner (G3)

Build against `todos` **and** `ports` simultaneously (simple shape + host-glue shape). Prove
byte-equivalent behaviour to the existing verifiers before deleting them:

```
just modularity plugout todos    # new runner
pnpm verify:todos-plugout        # old script
# same pass/fail, same artifacts
```

Then port `skills`, `git`, `commands`, `module-fixture` and delete all six. Expected net:
−1,178 lines of script, +~250 runner, +~240 of manifest (already written in step 4).

Largest single payoff in the plan. Also the step most likely to reveal that the shape is
wrong — hence proving equivalence rather than trusting the abstraction.

## Step 6 — Move `build` and the remaining `scripts/`

`git mv` into `ops/build/bin` and `ops/modularity/bin`. `scripts/smoke/` →
`ops/modularity/fixtures`. Dev spikes → `ops/_attic` with the README.

`profiles/` **stays at the repo root** — it is app configuration consumed by
`tauri build --config`, and becomes generated rather than hand-maintained
(`04-ownership-boundaries.md` §4.2).

Mechanical, but touches `package.json` paths and the profile references inside the module
manifests — run `just modularity all` before and after.

## Step 7 — Fill in `ops/check` (G2)

`types`, `fmt`, `clippy`, `schemas`, `all`. Land `clippy` **soft** (non-blocking, reported)
and ratchet: a 332-file refactor will produce a warning count nobody has measured, and
blocking on it stalls the migration for an unknown cost.

## Step 8 — Move the upstream ledger in

`research/integrate-upstream-changes/{02-review-runbook.md → ops/upstream/SKILL.md}`, plus
`state.yaml`, `path-map.yaml`, `log/`, and the schemas derived from `01-ledger-format.md`.
Move, don't copy. Leave the design rationale in `research/`.

Independent of steps 2–7 — can run in parallel with them, by a different agent.

## Step 9 — Skill index, then CI

Add `just ops skills` (reads the `skills:` list from every `capability.yaml`) and the pointer
section in the repo `CLAUDE.md`: *repo operations live in `ops/`; run `just` for commands and
`just ops skills` for procedures.* That pointer is the whole discovery mechanism — it is what
lets an agent that was not explicitly told still find the right procedure.

Then CI becomes a short workflow calling `just check all` and `just test fast` on PR,
`just test full` nightly (G6) — the whole reason CI was deferred is that it is trivial once
the lanes exist.

## Verification at each step

```
just ops validate        # meta-layer intact
just check all           # from step 7
just test fast           # from step 1
just modularity all      # from step 5 — the expensive one, at step boundaries only
```

Rule: **no step lands without `just modularity all` passing.** It is the only thing that
proves the app architecture survived a change to the tooling that measures it.

## Risks

| Risk | Mitigation |
|---|---|
| `git mv` storms conflict with agent branches | Steps 2 and 6 in quiet windows; both are pure moves, so conflicts resolve by taking the move |
| Plug-out runner over-generalizes from one module | Build against `todos` + `ports` together; prove equivalence before deleting |
| `just` unavailable on Linux/CI | Recipes stay one-line wrappers; `bin/` is always directly callable |
| Manifests become decoration | `just check manifests` in the fast lane from step 4 onward |
| `ops/` becomes the new `scripts/` dump | `capability.yaml` required, `ops validate` rejects loose files, `_attic` gives spikes a legitimate home |
| Migration stalls half-done | Steps 1–3 deliver standalone value; if it stops after step 3 the repo is still better off than today |

## What "done" looks like

- `just` lists every operation the repo supports, on one screen.
- `scripts/` and `profiles/` no longer exist at the root; `package.json` has ~6 delegators.
- Adding a module means writing one manifest, not editing six files and copying a verifier.
- Adding an ops capability means creating one directory that passes `ops validate`.
- Swapping a capability means changing one line in `ops.yaml`.
