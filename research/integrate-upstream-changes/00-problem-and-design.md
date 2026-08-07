# Upstream change integration — problem and design

Date: 2026-08-07
Status: proposal, not yet implemented

## 1. Situation

- `upstream` = `https://github.com/stumptowndoug/shep.git` (already configured as a remote).
- `origin` = `https://github.com/ddebowczyk/shep.git`.
- Our `main` is a byte-identical mirror of upstream at `2adfc69` (v0.5.0). All of our
  modularization work lives on `codex/*` branches — currently
  `codex/assistant-session-continuity`, 47 commits, 332 files, +29,758 / −4,400.
- Upstream will not accept the modularization. Upstream still ships work we want.
- We therefore need a permanent, low-cost **review ledger**: for every upstream commit,
  a durable record of *seen / taken / re-implemented / rejected, and why*.

### Freshly fetched backlog (as of 2026-08-07)

`git fetch upstream` moved `upstream/main` from `2adfc69` → `4214a4b` (v0.6.0).
16 new commits. Their composition is the single most important input to this design:

| Class | Count | Commits |
|---|---|---|
| Substantive product change | 3 | `59e8fc7` terminal output flow + scroll, `2b39152` xterm 6 upgrade, `30c82dd` glass terminal themes / DOM renderer |
| Dependency upgrades (mechanical but real) | 2 | `4bd529f`, `4dce7ea` |
| Merge commits (duplicate their branch commits) | 2 | `14efb5d`, `4214a4b` |
| Pure `TODO.md` bookkeeping | 6 | `b6373c0`, `aab5284`, `389502d`, `690910c`, `d15c5d7`, `67570b0` |
| Release version bump | 1 | `83b838f` |
| Repo governance, N/A to a fork | 2 | `fa063cb` (.github templates, CONTRIBUTING), `dec8846` (gitignore TODO.md) |

**Signal ratio: 3–5 of 16.** Roughly 70% of the queue is noise, and 2 commits would be
reviewed *twice* under a naive scheme because merges re-present their branch's diff.

Second finding: the substantive work clusters in `src-tauri/src/pty/`,
`src/components/terminal/`, `src/hooks/usePty.ts` — paths that **still exist unmodified
in our fork** (terminal/PTY is not yet a module). So today's highest-value upstream work
is largely *directly cherry-pickable*, not "re-implement from scratch". That will change
as modularization advances, and the ledger has to survive that shift.

## 2. Assessment of the proposed design

The proposed shape was: gitignored `./upstream-commits/<sha>/` containing
`files/` (copied changeset) + `changes.yaml` + one `.yaml` per idea worth incorporating.

Three parts of it are more machinery than the job needs, and one part is under-specified.

### 2.1 Drop the `files/` changeset copies — git already is that store

Git permanently stores every upstream commit's full content once fetched. `git show <sha>`,
`git show <sha> -- <path>`, `git diff <sha>^ <sha>` all work offline, forever, at zero
repo cost. A copied `files/` tree is a second, stale, lossy representation of data we
already hold — it loses parent links, rename detection, and blame, and it inflates the
repo by the full size of every upstream changeset we ever look at.

The one real risk copying protects against — objects being garbage-collected if upstream
force-pushes or deletes a branch — is solved by **pinning a ref** instead of copying bytes.
One ref costs 41 bytes and keeps the entire object graph alive.

### 2.2 Drop the per-idea `.yaml` files — those are work items, and we already have a tracker

An "item worth incorporating" is a task: it has an owner, a priority, a status, and it
blocks or is blocked by other work. This repo already runs `bd` (beads) with 87 issues,
26 open, actively used. A parallel YAML tracker under `upstream-commits/` would duplicate
that, drift from it, and give agents two places to look for the same answer.

Record the *decision* in the ledger; record the *work* in `bd`; link them by id.

### 2.3 Do NOT gitignore it — this is shared team state

The premise of this whole exercise is a large agent team working in parallel. A gitignored
ledger is invisible to every other agent, every worktree, and every fresh clone. Two agents
will triage the same commit; a third will re-litigate a rejection whose reasoning was never
written where it could be read. The value of the ledger *is* that it is shared.

The likely motive for gitignoring — "don't pollute the diff against upstream" — does not
apply: we are never merging back, and upstream has no such path, so it can never conflict.
`docs/` and `research/` are already committed in this fork; this belongs with them.

### 2.4 Missing pieces

- **A watermark.** Without "reviewed through commit X", answering "what's new?" means
  scanning the whole ledger tree every time.
- **A path map** (upstream path → our owning module). This is the single biggest triage
  accelerator: most verdicts become mechanical once you know which module owns a file, or
  that no one does.
- **A merge/noise policy.** Without it we review `14efb5d` and its five branch commits as
  six independent items, and burn effort on six `TODO.md` edits.
- **An exit criterion.** The stated intent is to stop in a few months. That needs a measured
  trigger, not a feeling.

## 3. Chosen design

Three stores, each holding exactly what it is good at:

| Store | Holds | Mechanism |
|---|---|---|
| **git** | upstream content | `upstream` remote + a pinned `upstream-reviewed` ref |
| **ledger** (committed markdown) | the decision and its reasoning | `research/integrate-upstream-changes/log/<sha>.md` |
| **bd** | the resulting work | `bd` issues labelled `upstream`, id recorded in the ledger entry |

### 3.1 The watermark is a git ref, so the queue is a git command

Keep a branch `upstream-reviewed` pointing at the last fully triaged upstream commit.

```
git fetch upstream
git log --no-merges --reverse --oneline upstream-reviewed..upstream/main   # the queue
```

This is self-maintaining: a triaged commit leaves the queue by construction, the ref pins
objects against GC, and there is no counter to keep in sync with reality.

`--no-merges` is not optional — it is what stops `14efb5d`-style merges from re-presenting
diffs we already reviewed commit-by-commit.

Deliberately **not** overloading `main` for this: `main` is the fork's PR target and will
eventually carry modular work, at which point it stops being a faithful upstream mirror.
A dedicated ref has one job.

### 3.2 One markdown file per non-merge upstream commit

`log/<short-sha>.md`, YAML frontmatter (machine-queryable) + free-form body (agent- and
human-readable). Flat directory, no per-commit subdirectory — a directory holding one file
is pure ceremony. Noise commits get a 6-line file; substantive ones get real prose.

Format spec and templates: `01-ledger-format.md`.

### 3.3 A path map makes triage mechanical

`path-map.yaml` maps upstream path globs to the module that owns them in our fork, or marks
them dead. An agent triaging a commit intersects its touched paths with the map and gets the
verdict for free in the common cases: everything maps to `n-a` → `n-a`; everything maps to
paths still identical to upstream → `adopt` candidate; anything maps to a module → `adapt`.

Seeded from today's evidence — e.g. `src/lib/markdownRenderer.ts` no longer exists in our
tree, while all the terminal/PTY paths do.

### 3.4 Verdict vocabulary (five values, no more)

`pending` · `adopt` · `adapt` · `reject` · `n-a` — defined in `01-ledger-format.md`.

### 3.5 Adopt as a *variant*, not a replacement — upstream as a modularity probe

The default reading of "integrate an upstream change" is *replace our code with theirs*.
For a codebase whose whole point is module isolation, that is usually the weaker option.

Take `2b39152` / `30c82dd`: upstream moved the terminal to xterm 6 and added a DOM renderer
for translucent themes. Framed as a replacement, that is a risky in-place rewrite of
`TerminalView.tsx` — a file our branch is already editing. Framed as a **variant**, it is a
`terminal.engine` port with two registered implementations: the current renderer and
upstream's. Nothing is removed, both are selectable, and the two can be compared at runtime
instead of in a diff.

This is why the ledger carries `integration: replace | variant | new` as a field separate
from the verdict, and why `variant` entries name the `seam:` they plug into.

The second-order benefit is the one worth optimising for: **each upstream commit is a free
conformance test of our module boundaries.** Trying to land a change as a variant answers a
question no amount of internal review does — can a genuinely externally-authored
implementation drop into this seam without touching the host?

- It lands cleanly → the boundary is proven by an adversarial example.
- It lands but needs a new call or type on the port → precise, evidence-backed gap.
- It cannot land without editing the host → there is no real seam there yet, and upstream
  just told us where to build one.

That finding is recorded in the entry's `## Seam feedback` section and is often worth more
than the feature itself. It also changes the exit criterion's meaning: a batch that yields
no features but exposes a missing port is still a productive batch. Note that in
`state.yaml` rather than reading it as a signal to wind down.

Not everything should be a variant — a bug fix in code we share verbatim is a `replace`, and
manufacturing a port for it is waste. The test is whether the change embodies a *strategy*
someone might reasonably want to choose between (renderer, provider, storage backend,
transport). Strategies become variants; corrections become replacements.

## 4. Cost and exit

Per cycle (fetch every 1–2 weeks, ~15 commits): ~10 commits resolve to `n-a` in seconds via
the path map, ~3–5 need genuine reading. Call it 20–40 minutes of agent time per cycle.

Record per batch in `state.yaml`: commits triaged, of which `n-a`, and `adopt`+`adapt` count.

**Stop when three consecutive batches produce zero `adopt`/`adapt` items**, or when more
than 80% of upstream-touched paths resolve to `dead`/`unowned` in the path map — at that
point the codebases have diverged past the point where reading upstream pays for itself.
Write the wind-down decision as a final ledger entry rather than letting the process
silently lapse.

## 5. Layout

```
research/integrate-upstream-changes/     # committed
├── 00-problem-and-design.md             # this file
├── 01-ledger-format.md                  # entry schema, verdicts, templates
├── 02-review-runbook.md                 # the repeatable procedure
├── state.yaml                           # last fetch, watermark, per-batch stats
├── path-map.yaml                        # upstream path glob -> owner / dead
└── log/
    ├── 59e8fc7.md
    ├── 2b39152.md
    └── ...
```

Co-located with the analysis rather than a top-level `./upstream-commits/`, so the process
docs and the records they describe stay together. If a top-level path is preferred later,
only `02-review-runbook.md` needs editing.
