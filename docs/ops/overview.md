# Repo operations (`ops/`) — overview

How work *on* this repository is organised, and why it is modular.

Design detail lives in `research/modular-repo-ops/`; this page is the orientation.

## Why we take control of ops

Shep is developed by a large team of agents working in parallel on separate module branches.
That working model drove the app-side modularization — isolate changes so agents do not
collide, and so a failure is contained to one module. The tooling that operates on the repo
has exactly the same problem, one level up.

Before this work, every operation lived in two shared places: 40 scripts in `package.json`
and a flat `scripts/` directory mixing build, QA, module verification, and abandoned dev
spikes. That shape fails the same way an unmodularized app does:

- **Contention.** A single file every agent must edit to add a test lane or a check.
- **Duplication instead of reuse.** Six plug-out verifiers, ~1,180 lines, ~85% identical —
  differing only in a module name, a crate name, and a feature flag. Each new module copied
  the file. Data was being maintained as code.
- **No discoverability.** Finding "how do I run the tests" meant reading 40 script names and
  guessing which twelve were the test ones, in an order nobody had written down.
- **No replaceability.** Nothing could be swapped or varied without editing everything.

So ops gets the same treatment as the app: **capabilities** — self-contained, discoverable,
replaceable — instead of a shared script pile. Each capability owns its scripts, its data,
its schemas, and the written procedure an agent follows to use it.

## Shape

```
justfile                     # discovery: `just` lists every operation
ops/
├── ops.yaml                 # which provider is active for each interface
├── schema/                  # validates the capability manifests
├── test/                    # test lanes (fast, rust, full, per-module)
├── check/                   # typecheck, fmt, clippy, schemas, manifests
├── build/                   # local and release builds into ./builds/
├── modularity/              # boundary checks and module plug-out proofs
├── upstream/                # upstream-change review ledger
└── _attic/                  # dev spikes, explicitly unsupported
```

Each capability directory holds `capability.yaml` (its manifest), a `justfile` (thin
recipes), `bin/` (the real logic), `schema/` (for data it owns), and
`skills/<name>/SKILL.md` (procedures an agent is pointed at by path).

```
just                          # every capability and recipe, one screen
just test fast                # the fast lane
just modularity plugout git   # prove the git module can be compiled out
just ops skills               # the procedures available to agents
```

`ops/` is deliberately *not* under `modules/`: app modules ship in the binary and are
glob-discovered by the Cargo and pnpm workspaces. Ops capabilities never ship and must not be
reachable from app code.

## What lives in `ops/` — and what does not

The boundary is **not** "everything ops-related goes in `ops/`". That rule would force test
files away from the modules they characterize, which is the centralization this work removes.

> **A capability owns its mechanism. Subject matter stays with its subject.**

`ops/test` owns test discovery, lanes, and reporting. It does not own test *files* — those
belong to the code they test.

### The three-question test

First `yes` decides it:

1. **Does the app need it at runtime or build time?** → it never lives in `ops/`.
2. **If we swapped this capability for another provider, would this file move with it?**
   → the capability owns it. If a different provider would just read the same file in place,
   it is subject matter — leave it where it is.
3. **If we deleted this capability, should this file be deleted too?** → the capability owns it.

Question 2 is the sharp one, because it is the same question replaceability asks. Swap
`ops/test` for a different runner: the runner and lane config move; `modules/git/frontend/tests/`
does not.

### Where things live

| Resource | Location |
|---|---|
| Module and host tests | with the code they test — `modules/*/{frontend,backend}/tests/`, `src/core/**/tests/` |
| Module manifests (`module.yaml`) | with the module — plug-out deletes the module, and the manifest must go with it |
| `docs/`, `research/` | repo root — they describe the product and its reasoning, and outlive any capability |
| `profiles/` | repo root — app configuration, but *generated and verified* by `ops/modularity` |
| `builds/` | repo root, gitignored — output, not ownership |
| Capability scripts, schemas, fixtures, skills | inside the capability |

A capability's manifest declares three path sets: `owns` (deleted with it), `reads`
(inspected, never written), and `generates` (written by it, owned by the app).

## The invariants

Location is a convention; these are the rules, checked by `just ops validate`:

1. No app code imports from `ops/**`.
2. Nothing in `ops/` reaches a shipped build.
3. `owns` sets are disjoint — every path under `ops/` has exactly one owner.
4. A capability writes only to its `owns` and `generates` paths.
5. No unowned executable directory at the repo root — `scripts/` must not come back.

Invariant 5 is the anti-entropy rule and the point of the whole arrangement. The real risk is
not `docs/` surviving at the root; it is someone needing a one-off script a year from now,
finding no obvious home, and recreating `scripts/` — at which point `ops/` is decoration and
the repo has two ops systems. A stricter location rule would make that *more* likely, because
a rule that forces tests away from their modules gets broken within a month, and a rule broken
once stops being enforced at all. Checkable invariants plus a stated home for spikes
(`ops/_attic/`) survives a team that is mostly parallel agents.

Put plainly: **`ops/` is where mechanism lives, not where everything ops-related is filed.**

## Further reading

| Document | Contents |
|---|---|
| `research/modular-repo-ops/00-current-state-and-gaps.md` | evidence and the ten gaps this addresses |
| `research/modular-repo-ops/01-design.md` | capability contract, `just` layout, variants |
| `research/modular-repo-ops/02-capability-specs.md` | per-capability specs and script disposition |
| `research/modular-repo-ops/03-migration-plan.md` | sequenced migration steps and risks |
| `research/modular-repo-ops/04-ownership-boundaries.md` | the ownership rule in full |
| `research/integrate-upstream-changes/` | design behind the `upstream` capability |
