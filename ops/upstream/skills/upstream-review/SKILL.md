---
name: upstream-review
description: Triage upstream changes into a durable ledger without mutating the product trunk.
---

# Upstream review runbook

The repeatable procedure. Written to be executed by an agent without further context;
read `reference/ledger-format.md` for the entry schema it produces.

`main` in this repository is the product trunk and the only authority over
product state. The original Shipctl repository is not a trunk and never becomes
one: `upstream/main` is a read-only intake feed. Review fetches and records
upstream changes; it never synchronizes, resets, rebases, merges, cherry-picks,
or checks upstream content out into a product branch.

This is one-way selective intake, not contribution-fork maintenance. Never open
a pull request against the original Shipctl repository or push our product branches
or tags to it. Selected behavior becomes local bd work and is incorporated into
our independent codebase.

Cadence: every 1–2 weeks, or when upstream tags a release.

## 0. One-time setup

```bash
git remote get-url upstream                 # already configured: stumptowndoug/shep
git fetch upstream
git branch -f upstream-reviewed 2adfc69     # last commit we have fully triaged (v0.5.0)
mkdir -p ops/upstream/log
```

`upstream-reviewed` is the watermark **and** the GC pin that keeps fetched objects alive.
Never push it to `origin`'s default branch flow; it is a local/fork bookkeeping ref
(pushing it to `origin` is fine and is how other agents pick it up).

## 1. Fetch and size the queue

```bash
git fetch upstream --tags
git log --no-merges --reverse --oneline upstream-reviewed..upstream/main
git rev-list --count --no-merges upstream-reviewed..upstream/main
```

`--no-merges` is mandatory. Merge commits re-present diffs already reviewed on their branch
side; in the 2026-08-07 batch, `14efb5d` and `4214a4b` between them duplicated seven commits.
Merges get no ledger entry.

## 2. Stub the batch

For each sha in the queue, create `log/<short-sha>.md` with `verdict: pending` and the
frontmatter fields obtainable without reading the diff:

```bash
git log -1 --format='%h%n%s%n%ad' --date=short <sha>
```

Stubbing the whole batch first means an interrupted session leaves a complete, accurate
queue on disk rather than a half-scanned range.

## 3. Fast-triage against the path map

```bash
git show --stat --format="" <sha>
```

Intersect the touched paths with `ops/upstream/path-map.yaml`:

- **every path is `ignore` or `dead`** → `verdict: n-a`, one-line body, done. Expect this for
  ~60–70% of commits (`TODO.md` churn, release bookkeeping, `.github/`).
- **only version/lockfile paths** → `n-a` unless the bump carries a behavioural change we
  care about; check `package.json`/`Cargo.toml` deltas, not the lockfile.
- **any path is `unknown`** → resolve it: check whether the file exists here
  (`test -e <path>`), whether it moved under `modules/`, and add the entry to
  `ops/upstream/path-map.yaml`. The map only stays useful if triage feeds it.
- **anything else** → §4.

## 4. Deep triage

Read the change:

```bash
git show <sha>                              # full diff
git show <sha> -- <path>                    # one file
git diff upstream-reviewed <sha> -- <path>  # cumulative, when a series builds up
```

Decide, in order:

1. **Do we want the behaviour?** No → `reject`, and write a real reason under `## Why not`.
2. **Do we already have it?** Our branch has diverged substantially; check before assuming.
   Yes → `reject` with the pointer to our implementation.
3. **`replace`, `variant`, or `new`?** Apply the test from
   `research/integrate-upstream-changes/00-problem-and-design.md` §3.5:
   a *correction* to code we still share verbatim is `replace`; a *strategy* someone could
   reasonably want to choose between (renderer, provider, backend, transport) is `variant`;
   a capability we lack entirely is `new`.
4. **`adopt` or `adapt`?** `adopt` if the touched paths are `same` in the path map and the
   change can land close to verbatim. `adapt` if it must be re-expressed against a module
   boundary — which includes every `variant`, since a variant means building or extending a
   port rather than editing in place.
5. **Write `## Seam feedback`.** Did the boundary hold, need widening, or not exist? This is
   required for `adopt`/`adapt` and is frequently the most valuable line in the entry.

Then open the work item and record its id:

```bash
bd create "Port upstream <sha>: <subject>" \
   -t task -p 2 -l upstream \
   -d "Upstream <sha>. Ledger: ops/upstream/log/<sha>.md"
```

The ledger holds the decision; `bd` holds the work. Do not restate the plan in both — the
ledger entry links to the bd id, the bd issue links back to the ledger path.

## 5. Close the batch

Only when every commit in the range has a non-`pending` verdict:

```bash
git branch -f upstream-reviewed upstream/main
```

Append the batch record to `ops/upstream/state.yaml` (see `reference/ledger-format.md` §2): totals, merges
skipped, verdict breakdown. If the batch produced no features but exposed a missing seam,
say so in the batch record — that is a productive batch, not a quiet one, and it must not
be read as evidence for winding down.

Commit the ledger:

```bash
git add ops/upstream
git commit -m "chore(upstream): triage <range>"
```

## 6. Doing the work

Ledger triage and implementation are separate activities — never block a batch on writing
code. Implementation happens later from the linked `bd` issue, on a short-lived branch
created from the product trunk `main`. When the work lands, add `integrated: <our-sha>` to
the ledger entry and close the bd issue.

Useful extraction commands for the implementer:

```bash
git show <sha> -- <path> > /tmp/upstream.patch    # inspect
git diff main <sha> -- <path>                     # compare against the product trunk
```

Direct cherry-pick is reserved for a later implementation task and only for structurally
isolated patches that preserve local module boundaries. Otherwise reimplement the behavior
through the local seams. The review procedure itself never mutates product branches.

## 7. Standing queries

```bash
# what is still untriaged
rg -l 'verdict: pending' ops/upstream/log/

# accepted but not yet implemented
rg -l 'verdict: (adopt|adapt)' ops/upstream/log/ \
  | xargs rg -L 'integrated:'

# everything we rejected, with reasons
rg -l 'verdict: reject' ops/upstream/log/ | xargs rg -A3 '## Why not'

# seam gaps found so far
rg -A4 '## Seam feedback' ops/upstream/log/

# open upstream-derived work
bd list --json --no-pager -l upstream
```

## 8. Winding down

Per `00-problem-and-design.md` §4: stop when three consecutive batches produce zero
`adopt`/`adapt` **and** zero seam findings, or when >80% of upstream-touched paths resolve
to `dead`/`module:*`. Record the decision as a final entry in `state.yaml` and a note at the
top of `research/integrate-upstream-changes/00-problem-and-design.md`, so a future reader knows the process ended deliberately
rather than lapsed.
