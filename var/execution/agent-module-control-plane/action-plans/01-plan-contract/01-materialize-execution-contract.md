# Materialize and prove the plan execution contract

## Outcome

The complete plan pack maps one-to-one to an ordered, recoverable Beads epic
hierarchy, backed by reusable configuration and a deterministic generator.

## Depends on

None. This is the first task in the first dependency-ready subepic.

## Production change

- Register the repository-operations `execution` capability.
- Store the parent configuration, one phase YAML per plan Markdown chapter, and
  the shared Jinja subepic template under `var/execution/`.
- Provide an idempotent CLI that renders, applies, and verifies the hierarchy.
- Preserve the plan chapters as the detailed implementation authority.

This governance task changes execution infrastructure, not Shipctl runtime
behavior.

## Diagnostic or observability change

The generator emits structured TOON by default or JSON on request. Its `verify`
operation checks chapter coverage, exact parent/child relationships, exact
rendered bodies and specifications, the ordered blocker chain, persisted ID
state, and whole-graph acyclicity.

## Mechanism-level integration test

Run the generator against the live repository Beads database, then run
`verify` independently. Query the parent children and every blocking edge with
`bd` rather than accepting render success as proof of materialization.

## Acceptance evidence

- Every Markdown file in the plan root has exactly one phase YAML and subepic.
- The parent epic and all subepics carry stable external references.
- Every subepic embeds the full absolute phase-document path and common process.
- Only the first subepic is dependency-ready; each successor depends on the
  preceding subepic.
- YAML, Markdown, ops-manifest, and whitespace validation pass.
- A second generator run updates in place without creating duplicate issues.

## Non-goals

- Do not implement named instances or module lifecycle behavior in this task.
- Do not duplicate phase implementation detail in Beads descriptions.
- Do not push repository commits.
