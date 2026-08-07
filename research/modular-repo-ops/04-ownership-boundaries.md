# Ownership boundaries — what goes in `ops/` and what stays put

Date: 2026-08-07
Answers: do we allow `tests/`, `docs/`, `profiles/` outside `ops/`, or enforce a
totalitarian "all ops-related things live in `ops/`" rule?

## 1. Answer: permissive by location, strict by invariant

**Not totalitarian.** Enforcing that everything ops-adjacent lives under `ops/` would be
actively harmful, for a reason specific to this repo: it re-creates the exact problem the
migration exists to fix. `scripts/tests/` holding module tests is gap G5. Moving those files
to `ops/test/tests/` would be the same centralization with a nicer address — tests still
divorced from the code they characterize, app modules still not self-contained, plug-out
still leaving orphans behind.

There *is* a hard rule. It is just not "is this file ops-related?" — it is about **ownership
and lifetime**, which is what actually determines whether a capability is replaceable.

## 2. The rule

> **A capability owns its mechanism. Subject matter stays with its subject.**

`ops/test` owns test *discovery, lanes, and reporting*. It does not own test *files* — those
belong to the code they test. `ops/build` owns the build *procedure*; the app it builds stays
in `src/`. `ops/upstream` owns the review *ledger and runbook*; the upstream *content* stays
in git.

### The three-question test

Applied to any file, in order. First `yes` decides it.

1. **Does the app need it at runtime or build time?** → it never lives in `ops/`.
2. **If we swapped this capability for another provider of the same interface, would this
   file move with it?** → the capability owns it. If the file would stay put and the new
   provider would read it just the same, it is subject matter — leave it where it is.
3. **If we deleted this capability entirely, should this file be deleted too?** → the
   capability owns it.

Question 2 is the sharp one, because it is the same question replaceability asks. Swap
`ops/test` for `ops/test-vitest`: the runner and lane config move; `modules/git/frontend/tests/`
does not. That settles test-file placement without appeal to taste.

## 3. Applying it

| Resource | Where it lives | Why |
|---|---|---|
| `modules/*/frontend/tests/`, `modules/*/backend/tests/` | **stays with the module** | Q2: a different runner reads the same files. Cargo *requires* it; pnpm workspace discovery assumes it. Also: plug-out deletes `modules/git/` and its tests must go with it. |
| host-rail tests (currently `scripts/tests/`) | **`src/core/**/tests/`** | Same rule — they characterize the host, so they belong to the host (G5). |
| `ops/modularity/tests/` | in the capability | Q3: tests *of the boundary checker*. Delete the capability, delete them. |
| `docs/` | **stays at root** | Describes the product and its architecture. Q1/Q2/Q3 all say no. |
| `ops/<cap>/README.md`, `skills/` | in the capability | Describes the capability itself; swaps with it. |
| `research/` | **stays at root** | The reasoning record. Survives any capability. |
| `research/integrate-upstream-changes/` | **split, deliberately** | Design rationale stays in `research/`; `state.yaml`, `path-map.yaml`, `log/`, runbook move to `ops/upstream/`. A different review process would keep the ledger and discard the rationale. |
| `builds/` | **stays at root**, gitignored | Output, not ownership. Capabilities write to it; none owns it. |
| `.beads/`, `assets/`, `dist/`, `node_modules/` | root | Untouched. |
| `CLAUDE.md`, `README.md` | root | Plus a pointer section to `ops/` (`03-migration-plan.md` step 9). |
| `scripts/smoke/` fixture apps | **`ops/modularity/fixtures/`** | Q3: harnesses that exist only to prove the module system works. Note `modules/fixture/` is a real app module and stays. |

## 4. Two corrections to the earlier documents

Applying the rule honestly breaks two placements I proposed in `01-design.md`.

### 4.1 Module manifests belong to the module, not to `ops/modularity`

I put them at `ops/modularity/modules/<id>.yaml`. Q2 and Q3 both say that is wrong, and
there is a concrete bug: **plug-out deletes `modules/git/` entirely — an
`ops/modularity/modules/git.yaml` would survive as an orphan**, and the verifier would have
to reach outside the module to clean up after itself. That is precisely the coupling the
plug-out proof is meant to disprove.

Correct location: **`modules/<id>/module.yaml`**, next to the `package.json` and `Cargo.toml`
already there. It is a declaration the module makes about itself, in the same spirit.

This is strictly better on three counts: adding a module touches only its own directory;
`ops/modularity` ends up containing *zero* per-module knowledge, making it genuinely generic
and replaceable; and discovery works by the same `modules/*` glob that `pnpm-workspace.yaml`
and the Cargo workspace already use.

### 4.2 `profiles/` stays at root

I proposed moving it to `ops/modularity/profiles/`. Q1 says no: these are Tauri app configs
passed to `tauri build --config`, resolved as app configuration.

Better framing — they are **derived data**: `profiles/<id>-disabled/tauri.conf.json` is
computable from the module manifests. So they stay at root, stay committed (a build must not
require running a generator first), and `ops/modularity` gains:

- `just modularity profiles-check` — assert each profile matches what the manifests imply
  (fast lane, closes part of G4)
- `just modularity profiles-sync` — regenerate them

That is the general pattern for derived files: **owned by the app, generated and verified by
a capability.** It needs a third manifest field alongside `owns` and `reads`:

```yaml
owns:      [ops/modularity/**]          # deleted with the capability
reads:     [modules/**, src-tauri/**]   # inspected, never written
generates: [profiles/**]                # written, but owned by the app
```

## 5. Enforceable invariants

The discipline is not "keep `ops/` pure" — it is these five, checked by `just ops validate`
and the boundary checker. Location is a convention; these are the rules.

1. **No app code imports from `ops/**`.** Extend `check-module-boundaries.mjs` — one new
   forbidden prefix. This is the invariant that keeps ops out of the product.
2. **Nothing in `ops/` reaches a shipped build.** Assert `ops/` appears in no Vite input
   graph and no Cargo workspace member, and that no built bundle references it.
3. **`owns` sets are disjoint** across capabilities; every path under `ops/` is owned by
   exactly one capability (or is a root meta-file). This is what rejects a new dumping ground.
4. **A capability writes only to `owns` and `generates`.** `reads` paths are read-only.
   Violations are how a capability quietly becomes load-bearing for another.
5. **No unowned executable directory at the repo root.** The specific anti-entropy rule:
   `scripts/` must not come back. If a new operation appears with nowhere to go, that is a
   missing capability, and `ops/_attic/` is the honest holding pen.

## 6. Why this is the safer choice

The genuine risk to this design is not `docs/` surviving at the root. It is a year from now
when someone needs a one-off script, finds no obvious home, and creates `scripts/` again — at
which point `ops/` is decoration and the repo has two ops systems.

A totalitarian location rule does not prevent that; it makes it *more* likely, because a rule
that forces test files away from their modules will be broken within a month, and a rule
broken once stops being enforced at all. Five checkable invariants plus a stated home for
one-offs survives contact with a team that is mostly parallel agents.

Put plainly: **`ops/` is where mechanism lives, not where everything ops-related is filed.**
