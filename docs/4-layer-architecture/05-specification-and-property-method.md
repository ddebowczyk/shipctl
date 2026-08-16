# Specification and property method

<!-- markdownlint-disable MD013 -->

## Purpose

This migration changes authority while it preserves behavior. Example tests
alone cannot explore the relevant combinations of plugin order, partial
failure, disposal, registry revision, artifact identity, grants, and resource
ownership. Each migration seam therefore starts as a normative capability
record and one or more property cards.

The method follows the local property-testing guide in
`~/projects/_kb-docs/property-based-testing`. The specification layout borrows
the useful parts of `cordis-python/spec/` and `intercom/spec/journals/`:

- versioned, closed record schemas;
- numbered normative semantics;
- explicit dependency edges;
- one falsifiable claim per property;
- a stated independent oracle;
- shared conformance laws;
- explicit host composition and passive package imports;
- property IDs linked to executable tests.

Shipctl does not copy their fixed tier numbers or language-specific design
fields. Its dependency graph determines order directly.

## Normative record

Each migration capability record must answer:

| Field | Meaning |
| --- | --- |
| `schema_version` | Version of the record shape, not the product API |
| `id` | Stable capability or migration-seam ID |
| `status` | `draft`, `specified`, `implementing`, `implemented`, `deprecated` |
| `problem` | The concrete failure that exists without the capability |
| `origin` | Current Shipctl files and external references that informed it |
| `semantics` | Independently citable `MUST`, `MUST-NOT`, `SHOULD`, and `MAY` rules |
| `target_design` | Owners, public surface, private surface, and concurrency rules |
| `depends_on` | Other record IDs that must be proven first |
| `properties` | Full property cards derived from semantics |
| `open_questions` | Deliberately deferred choices and their decision owner |
| `deletion_gate` | Exact old paths or symbols removable after proof |

The checker must prove that IDs are unique, dependencies resolve, the graph is
acyclic, property evidence references local semantics, test IDs exist when a
card says `implemented`, and every uncited `MUST` is reported for review.

## Property card

Every property card contains these fields:

```yaml
id: PROP-AREA-NAME-001
claim: One universally quantified, falsifiable sentence.
shape: state-machine
evidence: [SEM-001]
domain:
  generates: The valid and invalid inputs to explore.
  excludes: Explicit regions outside this property.
  strategy_hint: How to construct valid values with little filtering.
preconditions: []
oracle:
  candidates:
    - kind: model
      description: How the expected result is computed.
      independence: Why it cannot fail in the same way as production code.
      failure_modes: How this oracle can still be wrong.
    - kind: differential
      description: A materially independent alternative.
      independence: Which shared failure it avoids.
      failure_modes: How this alternative can still be wrong.
  selected: model
  selection_reason: Why review selected this oracle or combination.
failure_value: A concrete defect that this test must catch.
test_tier: pr
status: proposed
test_id: null
```

The claim contains one proposition. If it needs “and,” split it unless both
parts are inseparable in the domain invariant.

The phase documents show the first oracle next to each proposed property. The
[oracle review](18-property-oracle-review.md) supplies a second candidate and
states how both can fail. A property cannot move from `proposed` to `specified`
until human review selects one candidate or a stated combination.

## Property shapes used by this program

| Shape | Migration use |
| --- | --- |
| Roundtrip | manifests, canonical records, snapshots, persisted layouts |
| Differential | legacy client versus semantic adapter; old provider versus extracted provider |
| Idempotency | repeated disposal, repeated desired revision, retry of an accepted operation |
| Safety | forbidden imports, grant denial, path traversal, no partial publication |
| Conservation | registered effects equal live activation-owned effects |
| Monotonicity | accepted revision and transition sequence never moves backward |
| State machine | activation, replacement, failure, disposal, and resource leases |
| Metamorphic | equivalent contribution permutations produce the same canonical catalog |

“Does not crash” is not an adequate property. It must state the semantic fact
that remains true.

## Generator rules

- Construct valid manifests and command histories directly. Do not generate
  arbitrary JSON and discard most of it.
- Generate boundary cases: empty sets, one contribution, duplicate IDs,
  replacement at the same version with a different digest, absent optional
  services, failed readiness, repeated disposal, stale revisions, and plugin
  removal while views or leases exist.
- Generate path segments and byte content for artifact tests. Keep unsafe paths
  in an explicit invalid generator.
- Generate activation histories with a command model rather than unrelated
  method calls.
- Record generator classifications such as operation kind, graph depth,
  duplicate presence, failure phase, and live lease count.
- Treat excessive filtering, unreachable commands, or unobserved transition
  classes as a failed generator review even when assertions pass.

## Oracle rules

The preferred oracle order is:

1. a small pure state model;
2. a mathematical or schema invariant;
3. a roundtrip against retained original values;
4. a differential comparison with the characterized legacy path;
5. a metamorphic relation independent of implementation order.

The oracle must not call the production function under test to compute its
expectation. Shared type declarations are acceptable; shared control flow is
not.

Differential tests are transitional. They protect a move, but they do not make
legacy behavior correct forever. A semantic property replaces the differential
test before the old implementation is deleted when the desired behavior
intentionally differs.

## Tool choice

- TypeScript properties use `fast-check` with the repository's existing Node
  test runner unless a browser integration requires the existing browser test
  harness.
- Rust properties use `proptest`; its persisted regression files are reviewed
  test artifacts.
- Cross-language protocols use canonical JSON fixtures plus independent Rust
  and TypeScript validators.
- Hegel is not a default dependency. The local guide describes it as a
  developer-preview experiment. A future experiment needs a separate decision
  and cannot block this migration.

## Test tiers

| Tier | Obligation |
| --- | --- |
| Local | replay persisted counterexamples and run the focused property while editing |
| Pull request | replay all accepted failures and run a fresh bounded campaign for changed seams |
| Scheduled | explore longer state histories, failure points, and cross-capability combinations |
| Release | run end-state conformance, packaging, installed-app, and control-plane proofs |

The runner configuration records seeds, paths, and measured duration. This
plan does not invent case counts or time budgets. Maintainers set them from
measured runtime and the authority of the relevant CI lane.

## Failure workflow

```text
semantic rule
    -> property proposal and review
    -> generator and independent oracle
    -> deliberate defect proves the test can fail
    -> fresh campaign
    -> shrink and replay
    -> classify product defect, contract defect, generator defect, or harness defect
    -> commit minimized regression
    -> fix production code
    -> rerun regression and fresh campaign
```

The test mutation and its contract must not be silently changed in the same
patch as the production fix. If the contract is wrong, amend the specification
first and state why.

## Evidence record

Each property run used for a migration gate emits structured evidence with:

- repository revision and dirty-state identity;
- property and test IDs;
- runner and library versions;
- seed and shrink path;
- generated-class distribution;
- pass, fail, or excluded result;
- minimized counterexample path when present;
- commands used for deterministic replay;
- phase and deletion gate that the result supports.

Ephemeral campaigns live under ignored `target/architecture-evidence/`.
Accepted minimized TypeScript regressions live beside their tests. Rust
regressions use committed `proptest-regressions/` paths. The proof command emits
JSON so an agent can inspect it without parsing test prose.

## Contract-change order

For each slice:

1. update and validate the capability record;
2. add or update the property and prove its deliberate failure mutation;
3. implement the smallest production change;
4. run deterministic regressions and the fresh campaign;
5. record evidence and remove only the paths named by the deletion gate.

This order makes a changed test distinguishable from changed product behavior.
