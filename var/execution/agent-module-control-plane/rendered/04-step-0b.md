# Step 0B — Saved instance state specification

## Overall goal

Agents can safely add, remove, enable, disable, inspect, diagnose, verify,
update, and reconfigure any supported Shipctl capability module in a running
instance, with diagnostic and verification mechanisms in every phase and
without breaking active terminal continuity.

## Phase authority

Read the complete phase document before making implementation decisions:

```text
/Users/ddebowczyk/projects/_ext_experiments/shep/docs/plans/20260808-090754-agent-module-control-plane/00b-saved-instance-state-spec.md
```

The phase document owns the detailed objective, design, boundaries, exit proof,
and non-goals. This subepic owns the execution process. Do not copy a stale
snapshot of the phase details into child tasks.

Create action plans in:

```text
var/execution/agent-module-control-plane/action-plans/04-step-0b
```

## Execution process

1. Claim this subepic (`shep-btu.4`) and record the live branch, commit,
   worktree state, and Beads state. Preserve unrelated changes.
2. Read the phase document in full. Treat its objectives and exit proof as the
   contract, while treating file names and implementation seams as hypotheses
   to revalidate.
3. Re-baseline every related code path before decomposing work. Use all four
   discovery surfaces:
   - `ast-grep outline` before detailed reads of unfamiliar source files;
   - `rg` for exact symbols, contracts, call sites, tests, and configuration;
   - `qmd search` for related indexed documentation, then retrieve and read the
     complete source document;
   - `codegraph` query, explore, node, and impact views for dependency and
     change-radius evidence.
4. Separate facts, assessments, and assumptions. Adjust the phase plan when the
   live code invalidates a planned seam, but retain the stated objective and
   exit proof. Prefer a simpler, more consistent path when it proves the same
   outcome.
5. Create one focused action-plan Markdown file for every necessary execution
   task in the action-plan directory above. Derive the number of files from the
   work; do not impose an arbitrary task count. Each file must state:
   - outcome;
   - dependencies;
   - production change;
   - diagnostic or observability change;
   - mechanism-level integration test;
   - acceptance evidence;
   - non-goals.
6. Create exactly one Beads task under this subepic for every action-plan file.
   Use the action-plan file as the task body, add only real dependency edges,
   then verify child coverage and graph acyclicity with the installed `bd` CLI.
7. Execute one ready child task at a time: claim it, implement the smallest
   complete change, run its acceptance and diagnostic checks, record evidence,
   and close it before claiming the next task.
8. Verify the phase outcome through the production boundary named by the phase
   document. A failed acceptance condition becomes a correction task; it is not
   waived by unit-test or compile success.
9. Inspect every subsequent phase document affected by discoveries in this
   phase. Correct contradictions, stale seams, or avoidable complexity while
   preserving downstream objectives. Material corrections must be tracked by a
   child task and verified.
10. Close and clean up the phase: all child tasks closed, action plans and plan
    documents current, diagnostics and integration evidence recorded, relevant
    gates green, and temporary artifacts removed.
11. Review the exact diff, stage only phase-owned changes, and commit them. The
    commit subject must identify the completed phase, for example
    `phase Step 0B: complete <outcome>`.
12. Close this subepic with the commit and verification evidence. Then select
    the next dependency-unblocked subepic in the parent epic and continue
    immediately. Do not push unless separately authorized.

## Completion proof

- The phase document's outcome and exit proof are satisfied.
- Every action-plan file maps one-to-one to a closed child task.
- Diagnostics let an agent distinguish success, failure, and partial state.
- Mechanism integration tests exercise the real boundary, not only mocks.
- Subsequent phases are consistent with the implementation now present.
- The phase commit exists and its subject identifies `Step 0B`.
- This subepic and all descendants are closed before execution advances.

## Transition

- Previous ordered subepic: Named instance specification.
- Next ordered subepic: Named instance foundation implementation.
