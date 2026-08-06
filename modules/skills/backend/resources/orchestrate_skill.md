---
name: orchestrate
description: Drive a feature end-to-end as planner/orchestrator while delegating implementation to a different agent CLI running headless, then finish with a fresh-context audit. Use ONLY when the user explicitly asks — /orchestrate, "drive another agent/model", "delegate this to <tool>", "run a plan-worker-audit workflow". Never self-select this skill just because a task is large; if orchestration seems like a good fit, suggest it and let the user decide.
---

# Orchestrate: plan → delegate → review → audit

You — whichever agent loaded this skill — are the planner, orchestrator,
and reviewer. A **worker** (another agent CLI run headless) writes the
code. A fresh-context audit checks the result. You own the plan, all git
operations, and the final verdict — the worker only edits files.

## Role assignment — settle it up front, once

Detect the available CLIs (`which codex claude gemini opencode pi agy`).
Then, unless the user already named tools or models, ask **one compact
question** before planning: proposed worker and proposed auditor, with
your recommendation stated and alternatives listed. Recommend a worker
from a **different model family than your own**, and an auditor from a
third family when one is available — cross-model review catches
uncorrelated blind spots. Don't re-ask per phase or per task; the
assignment holds for the whole run.

## Tool reference

Flags verified against installed versions; they drift between releases —
on failure, check the tool's `--help` once, adapt, then fall back to the
next choice.

| CLI | Headless dispatch | Feedback / resume | Model selection |
|---|---|---|---|
| codex | `codex exec -s workspace-write -C <root> -o <result-file> - < spec.md` | `codex exec resume --last "<feedback>"` | `-m <id>` |
| claude | `claude -p "$(cat spec.md)" --permission-mode acceptEdits` | `claude -p --continue "<feedback>"` | `--model sonnet\|opus\|haiku` or full id |
| gemini | `gemini -p "$(cat spec.md)" --approval-mode auto_edit` | `gemini -p --resume latest "<feedback>"` | `-m gemini-3-pro-preview`, `-m gemini-3-flash-preview`; omit for Auto (recommended) |
| pi | `pi -p "$(cat spec.md)"` | `pi -p -c "<feedback>"` | `--model <pattern>` (fuzzy, `provider/id:<thinking>`); discover: `pi --list-models [search]` |
| agy | `agy -p "$(cat spec.md)" --print-timeout 30m` | `agy -p -c "<feedback>"` | `--model "<display name>"`; discover: `agy models` |
| opencode | `opencode run "$(cat spec.md)"` | `opencode run -c "<feedback>"` | `-m provider/model`; discover: `opencode models` |

Per-tool caveats:

- **agy** needs the Antigravity app running, and its print mode defaults
  to a 5-minute timeout — always set `--print-timeout` generously. Its
  permission bypass flag is `--dangerously-skip-permissions`; use it only
  if the user has okayed that mode.
- **pi** executes tools directly (no approval layer) and bills provider
  API keys per token rather than a subscription — say so when proposing it.
- **codex / claude / gemini / agy** ride the user's existing
  subscriptions; prefer them when cost matters.
- `gemini -p` and `codex exec` both accept the spec on stdin, which
  avoids shell-quoting issues with large specs.

## Model selection

- **Default to each CLI's own default model** — it's what the vendor
  tuned the tool for and what the subscription covers. Pin a model only
  when the user asks or the task clearly warrants it (e.g. a cheap/fast
  model for mechanical edits, a frontier model for gnarly refactors).
- When the user wants options, discover them with `pi --list-models`,
  `agy models`, or `opencode models` and present a short list — don't
  dump full catalogs.
- **Fallback rule:** if a pinned model errors or isn't available, retry
  once on the CLI's default model, and record the substitution in the
  final report. If the CLI itself fails twice, move to the next available
  CLI (tell the user in the report, or immediately if they pinned it).

## Decisions still belong to the user

You own execution; the user owns product and scope. Keep asks rare,
compact, and batched — a run should need at most a couple:

- **Planning:** if requirements genuinely fork (two defensible designs,
  unclear scope boundary), ask one batched question before dispatching.
  Don't ask about things the codebase or conventions already answer.
- **Mid-run:** reversible and in-scope → proceed. Scope-changing,
  destructive, or outward-facing (pushes, publishes, deletions) → stop
  and ask.
- **Review/audit:** findings that imply a scope decision (e.g. "fixing
  this properly means changing the API") go to the user — in the report
  if the run can complete without it, as a question if it blocks.

## Working directory

Keep orchestration artifacts in `.orchestrate/<task-slug>/` at the repo
root: `plan.md`, one spec per task (`task-1.md`, …), and worker output
(`task-1.result.md`, …). Never commit this directory; add it to
`.gitignore` if the repo has one and it isn't listed.

## Phase 1 — Plan

1. Explore the codebase enough to plan concretely (files, patterns,
   constraints). Do this yourself — planning is your job, not the worker's.
2. Write `plan.md`: the goal, approach, role assignment (worker, auditor,
   models), and an ordered list of worker tasks. Prefer few, meaty tasks
   over many tiny ones; each roundtrip to the worker has overhead.
3. Write one spec file per task. **Specs must be fully self-contained** —
   the worker sees nothing but the spec and the repo. Each spec includes:
   - Goal (one paragraph) and any repo conventions that apply
   - Exact files to touch (and files NOT to touch)
   - Acceptance criteria as a checklist
   - A verify command (test/build/lint) the work must pass
   - The line: "Do not commit. Do not create branches. Leave changes in
     the working tree."

## Phase 2 — Dispatch

Run the worker in a background shell, one task at a time. Sequential is
the default — "continue/resume last session" feedback targets the most
recent session, so parallel workers make feedback ambiguous. Run tasks
in parallel only when they are truly independent AND each gets its own
git worktree; otherwise don't.

## Phase 3 — Review each task

When the worker finishes:

1. Read its result summary and `git diff`.
2. Check the diff against the spec's acceptance criteria, and check that
   it matches repo conventions (the repo's agent instructions apply to
   the worker's code too — you enforce them).
3. Run the verify command yourself. Do not trust the worker's claim that
   it passed.
4. Verdict:
   - **Pass** → next task.
   - **Small issues** (naming, a missed edge case, style) → fix them
     yourself; cheaper than a roundtrip.
   - **Substantive miss** → resume the worker's session with feedback
     (see table above). Maximum 2 feedback rounds per task; after that,
     take the task over and implement it yourself. Note the takeover in
     `plan.md`.

## Phase 4 — Fresh-context audit

After all tasks pass, get a review from a context that did NOT watch the
work happen — the assigned auditor, run headless and read-only where the
tool supports it (`codex exec -s read-only` or `codex exec review`;
`gemini -p --approval-mode plan`; otherwise a plain `-p` run told to only
read). Give it the goal, the full diff, and the prompt: "Review this
change for bugs, missed requirements, and convention violations."

Triage the findings yourself: fix confirmed real issues (route back
through Phase 2/3 if substantial), explicitly dismiss false positives
with a reason, and escalate scope-level findings to the user per the
decisions section.

## Phase 5 — Report

Tell the user, in this order: what was built and whether verification
passed (with the actual command output as evidence), what the worker did
vs. what you did or took over, audit findings and how each was resolved,
any model/CLI substitutions that happened, and anything left open. If
the project has a `TODO.md` board (shep-todos), update it to reflect the
finished work.

## Rules

- You own git. The worker never commits, branches, or pushes. You only
  commit if the user asked for commits.
- Never paste large code bodies into specs — reference file paths; the
  worker can read the repo.
- If a worker errors twice on dispatch (auth, flags), stop retrying:
  adapt once from `--help`, then fall back per the model-selection rules
  and tell the user why.
- The user's approval covers the plan's scope. New scope discovered
  mid-flight goes in the report, not into extra worker tasks.
