# Ledger format

Companion to `00-problem-and-design.md`. This is the normative spec for what a reviewing
agent writes.

## 1. Ledger entry — `log/<short-sha>.md`

One file per **non-merge** upstream commit. Filename is the 7-char short sha, lowercase.
Merge commits are never given an entry (see `02-review-runbook.md` §2).

### Frontmatter schema

```yaml
---
upstream: 59e8fc7            # required, 7-char short sha
subject: Fix terminal output flow and scroll behavior   # required, upstream's subject line
authored: 2026-08-04         # required, upstream author date (YYYY-MM-DD)
reviewed: 2026-08-07         # required once verdict != pending
verdict: adapt               # required: pending|adopt|adapt|reject|n-a
integration: variant         # required for adopt|adapt: replace|variant|new
seam: terminal.engine        # the module port it plugs into, when integration: variant
areas: [pty, terminal]       # required unless n-a; free tags, prefer module names
bd: [bd-91, bd-92]           # required when verdict is adopt|adapt; else omit or []
integrated: 4f2c1ab          # our commit sha, once the work actually landed; omit until then
---
```

Rules:

- `verdict: pending` is the only state where `reviewed`, `areas`, and `bd` may be absent.
- `verdict: adopt` or `adapt` **must** carry at least one `bd` id. A decision to take
  something without a tracked task is how ideas get lost.
- `verdict: reject` **must** have a `## Why not` section with a real reason. "Not needed"
  is not a reason; "conflicts with the module boundary because X" is.
- `integrated` is added later, when the bd issue closes. It turns the ledger into an audit
  trail: `grep -L integrated log/*.md` on `adopt`/`adapt` entries = accepted but not yet done.

### Verdict vocabulary

| Verdict | Meaning | Typical trigger |
|---|---|---|
| `pending` | In the queue, not yet triaged. | Stub just created. |
| `adopt` | Take it close to verbatim — the touched paths still match upstream in our tree. | Terminal/PTY today. |
| `adapt` | The idea is worth having, but must be re-implemented against our module architecture. | Anything landing in a path we've moved under `modules/`. |
| `reject` | Deliberately declined. Reason mandatory. | Conflicts with modularization, or upstream-specific. |
| `n-a` | No bearing on our fork. | `TODO.md` churn, version bumps, `.github/`, release bookkeeping, upstream-only docs. |

Five values, deliberately. A `defer` state was considered and dropped: it decays into a
second `pending` nobody re-reads. If something is worth revisiting later, the honest record
is `adapt` + a low-priority `bd` issue, which the existing tracker already ages correctly.

### `integration` — how it lands (orthogonal to the verdict)

`verdict` says whether we take it; `integration` says what shape it takes here. Required
whenever the verdict is `adopt` or `adapt`.

| Value | Meaning |
|---|---|
| `replace` | Upstream's version supersedes ours in place. The default for bug fixes. |
| `variant` | Implemented **alongside** ours as a selectable alternative behind a module seam. Nothing is removed. |
| `new` | Capability we simply don't have; lands as its own module or module surface. |

`variant` is the interesting one and is often the right call even when `replace` would
"work" — see `00-problem-and-design.md` §3.5. When `integration: variant`, name the port in
`seam:` (e.g. `terminal.engine`, `assistants.provider`). If no such port exists yet,
`seam:` records the one that would have to be created, and that gap is the finding.

### Body

Sections vary by verdict. Keep `n-a` entries to the frontmatter plus one line.

For `adopt` / `adapt` / `reject`:

```markdown
## What upstream did
Two or three sentences. Mechanism, not just the subject line.

## Why it matters to us
Or, for reject: `## Why not` — the concrete reason, referencing our architecture.

## Mapping into our tree
Path-by-path: upstream path -> our path / module / gone. Call out anything the
path map didn't already answer, and update `path-map.yaml` when you learn something new.

## Seam feedback
Required for `adopt`/`adapt`. What did trying to place this change reveal about our
module boundaries? One of: the seam held (name it), the seam is too narrow (say which
call or type is missing), or no seam exists and one is warranted. This is the section
that pays for the whole process — see `00-problem-and-design.md` §3.5.

## Notes
Gotchas for whoever does the work. Optional.
```

Do not paste diffs into the body. `git show <sha>` is one command away and always current.

## 2. `state.yaml`

Thin. The watermark of record is the `upstream-reviewed` git ref; this file carries the
things a ref cannot express.

```yaml
upstream_remote: https://github.com/stumptowndoug/shep.git
watermark_ref: upstream-reviewed      # branch pinned at last fully triaged commit
last_fetch: 2026-08-07
last_upstream_head: 4214a4b
last_upstream_tag: v0.6.0

batches:
  - date: 2026-08-07
    range: 2adfc69..4214a4b
    commits_total: 16
    merges_skipped: 2
    triaged: 14
    n_a: 9
    adopt: 0
    adapt: 0
    reject: 0
    pending: 5
```

`adopt + adapt` per batch is the signal metric that drives the exit criterion in
`00-problem-and-design.md` §4.

## 3. `path-map.yaml`

Upstream path glob → who owns it here. This is what makes triage cheap; keep it current as
modularization proceeds, since every module extraction flips entries from `same` to a module.

```yaml
# status:
#   same     - path exists in our fork and is still structurally upstream's; adopt is viable
#   module:X - responsibility moved into modules/X; upstream patches need re-implementation
#   dead     - deleted or fully rewritten here; upstream changes are n-a
#   ignore   - upstream project bookkeeping; always n-a
#   unknown  - not yet classified; forces a manual look

paths:
  - glob: "TODO.md";                          status: ignore
  - glob: ".github/**";                       status: ignore
  - glob: "CONTRIBUTING.md";                  status: ignore
  - glob: "README.md";                        status: ignore
  - glob: "docs/vision/**";                   status: ignore   # upstream planning docs; read for intent, never copy
  - glob: "src-tauri/tauri.conf.json";        status: same
  - glob: "package.json";                     status: same     # dependency bumps are reviewable
  - glob: "pnpm-lock.yaml";                   status: same
  - glob: "src-tauri/Cargo.toml";             status: same
  - glob: "src-tauri/Cargo.lock";             status: same

  - glob: "src-tauri/src/pty/**";             status: same
  - glob: "src/components/terminal/**";       status: same
  - glob: "src/hooks/usePty.ts";              status: same
  - glob: "src/lib/terminalViewport.ts";      status: same
  - glob: "src/lib/tauri.ts";                 status: same
  - glob: "src-tauri/src/commands.rs";        status: same     # heavily edited here; expect conflicts

  - glob: "src/lib/markdownRenderer.ts";      status: dead     # verified absent 2026-08-07

  # modules already extracted — upstream edits here need re-implementation
  - glob: "src-tauri/src/git*";               status: module:git
  - glob: "src-tauri/src/skills*";            status: module:skills
  - glob: "src-tauri/src/ports*";             status: module:ports
  - glob: "src-tauri/src/todos*";             status: module:todos
  - glob: "src-tauri/src/assistant_sessions/**"; status: module:assistants
```

Written as a flat list rather than a nested tree so `rg` finds an entry by path fragment in
one hit. Entries above are seeded from paths actually touched by the 2026-08-07 backlog plus
the modules present in `modules/`; everything unlisted is `unknown` and gets a manual look.

## 4. Templates

### Noise entry (the common case)

```markdown
---
upstream: 690910c
subject: Select version 0.6.0 for release
authored: 2026-08-05
reviewed: 2026-08-07
verdict: n-a
---

Upstream release bookkeeping in `TODO.md`. No product change.
```

### Substantive entry

```markdown
---
upstream: 30c82dd
subject: Support glass terminal themes with DOM rendering
authored: 2026-08-04
reviewed: 2026-08-07
verdict: adapt
integration: variant
seam: terminal.engine
areas: [terminal]
bd: [bd-93]
---

## What upstream did
Adds a renderer-selection layer (`terminalRenderer.ts`) so the terminal can fall back to
the DOM renderer when a translucent theme is active, plus theme plumbing in
`terminalTheme.ts` and a cache keyed on renderer choice.

## Why it matters to us
We carry the same translucent-window styling and hit the same WebGL-vs-transparency
conflict. Beyond the fix itself, "which renderer backs the terminal" is exactly the kind of
choice that should be a seam rather than an edit.

## Mapping into our tree
- `src/components/terminal/terminalRenderer.ts` — new file, no conflict.
- `src/components/terminal/terminalTheme.ts` — `same`, ours is unmodified; clean apply.
- `src/components/terminal/TerminalView.tsx` — `same`, but our branch also edits it; expect
  a manual merge around the xterm init block.
- `src/styles/globals.css` — ours is heavily rewritten (−1550 lines); port by hand.

## Seam feedback
No `terminal.engine` port exists today — `TerminalView.tsx` constructs xterm directly, so
upstream's renderer choice can only land as an in-place edit. Introducing the port and
registering both the current renderer and upstream's DOM/glass renderer behind it turns a
merge into an addition. Gap recorded; the port is the first task of bd-93.

## Notes
Depends on `2b39152` (xterm 6), which under the same port becomes a second registered
engine rather than a version bump. Sequence them.
```
