# Prove the execution task and gate contract

## Outcome

The ordered phase hierarchy, one-file/one-task execution protocol, and closure
gates are executable against the live Beads graph before product implementation
begins.

## Depends on

- Completed plan-contract phase at commit `cf58721`.
- The execution contract in
  `docs/plans/20260808-090754-agent-module-control-plane/09-execution-order-and-task-contract.md`.

## Production change

Record and prove the operational contract used by every downstream phase. Do
not change Shipctl runtime behavior in this governance task.

## Diagnostic or observability change

Establish repeatable checks for the exact ordered blocker chain, the mapping
between action-plan files and Beads children, child closure before phase
closure, and a phase-identifying Git commit.

## Mechanism-level integration test

Query the live Beads database rather than a rendered fixture. Verify the 14
ordered subepics, each adjacent `blocks` edge, current readiness/blocked state,
and graph acyclicity. Run the execution-pack verifier against the same live
database.

## Acceptance evidence

- The hierarchy contains the 14 plan chapters in the documented order.
- Every adjacent pair has exactly one predecessor-to-successor `blocks` edge.
- `shep-btu.3` remains blocked until this subepic closes.
- This action-plan directory contains exactly one file and this subepic has
  exactly one matching child task.
- The execution-pack verifier reports a valid, acyclic live hierarchy.
- The action plan passes Markdown lint and the repository diff passes
  whitespace validation.

## Non-goals

- Implementing named instances or module lifecycle behavior.
- Rewriting phase-specific design owned by later plan chapters.
- Pushing commits to a remote.
