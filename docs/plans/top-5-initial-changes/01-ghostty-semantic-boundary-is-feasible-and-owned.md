# Ghostty semantic boundary is feasible and owned

## Outcome

Prove with executable fixtures that the pinned Ghostty dependency can expose
every terminal fact and operation required of Shipctl's sole VT authority, then
record the dependency strategy that owns any proven gap.

This is the go/no-go enabler for the
[single-VT end state](../top-5-single-vt-closure/end-state.md). It does not build
the production semantic protocol or the replacement renderer.

## Context and purpose

The target architecture removes xterm as a parser. That makes
`libghostty-vt` load-bearing for screen state, history, effects, selection, and
mode-aware input encoding. The dependency is currently a git revision pinned in
`core/backend/Cargo.toml`, and at least one exposed contract is misleading:
`max_scrollback` is described as lines but behaves as a byte heuristic subject
to a geometry-derived floor. The public API also has no complete-row retention
trim, and the OSC 9 effect payload is a known binding gap.

The expensive closure work must not begin on API assumptions. Ownership starts
with an executable falsification attempt, not with choosing vendoring in
advance. A pinned dependency is acceptable when its public contract is enough;
vendoring or a narrow owned patch is justified only by a fixture-proven product
requirement that the pinned surface cannot meet.

## Affected areas

- `core/backend/Cargo.toml` and `Cargo.lock`
- `core/backend/src/terminal/replay.rs`
- focused Ghostty compatibility fixtures under the backend terminal capability
- dependency provenance and update documentation under `docs/ops/`
- conditionally, an owned Ghostty source or binding patch

## Work to be done

### A. Run the semantic go/no-go gate

1. Derive the required semantic inventory from the accepted end state and the
   current product capability surface. The fixtures must cover:
   - geometry, active screen, semantic rows and cells, graphemes, widths,
     continuation cells, styles, colors, wrapping, cursor, modes, palette,
     default colors, hyperlinks, and retained history;
   - ordered non-cell effects used by the product, including title, working
     directory, bell, notification, and clipboard behavior;
   - mode-aware key, text, paste, and mouse encoding; and
   - word, line, range, and copied-output selection semantics.
2. Exercise the real pinned safe API. Record any required fact available only
   through an unsafe binding, formatter output, undocumented behavior, or not
   at all. ANSI formatter output is not accepted as the future semantic read
   boundary.
3. Prove that facts copied from Ghostty into Shipctl-owned values remain valid
   after the dependency call returns. No client or transport contract may
   retain borrowed FFI state.
4. Include edge cases that distinguish terminal emulators: combining and wide
   graphemes, wrap-pending cursor state, reflow, alternate screen, child-owned
   palette/default colors, hyperlinks, history eviction, and mode transitions
   affecting input encoding.
5. Reuse the measured retention fixtures from change 03 for
   `max_scrollback`; do not establish a second retention interpretation here.
6. Produce a gap ledger. Each gap names the required behavior, observed API
   limit, smallest credible ownership branch, and the evidence that makes the
   behavior necessary.
7. Return exactly one result:
   - **feasible**: the safe API plus accepted narrow owned extensions can meet
     the complete inventory; or
   - **falsified**: a required behavior cannot be exposed or owned under an
     approved maintenance contract.

If this gate is falsified, stop the single-VT closure and return the evidence
for an owner architecture decision. The other initial enablers remain useful
and do not need to be reverted.

### B. Own the dependency contract

1. After feasibility and the retention decision from change 03, record the
   selected dependency branch:
   - **pinned upstream** when the public API satisfies the approved semantics;
   - **vendored released source** when source provenance or reproducible
     availability is an approved requirement; or
   - **owned fork or vendor patch** when a proved semantic or retention API gap
     must be closed.
2. Record repository and nested-source revisions, licenses, build mechanism,
   exposed API assumptions, known documentation defects, and the approving
   owner.
3. Keep extensions narrow. For example, an OSC effect payload or complete-row
    retention operation may be exposed when its fixture proves the need; this
    enabler must not create Shipctl's full semantic frame encoder.
4. Make the compatibility corpus an upgrade gate. Document how to update the
    dependency, regenerate bindings where applicable, run the fixtures, inspect
    behavioral changes, and record approval.
5. If vendoring or forking is selected, prove source identity and the chosen
    build path in an isolated environment. Do not treat a warm Cargo cache as
    evidence that the owned source is reproducible.

## Acceptance criteria

- The complete required semantic inventory has executable evidence against the
  exact pinned dependency revision.
- The result is explicitly feasible or falsified; unknown, undocumented, or
  formatter-only facts are recorded as gaps rather than assumed away.
- The feasible result leaves no required semantic fact or operation without a
  safe read/encode path or an approved narrow ownership extension.
- No future frontend contract depends on borrowed FFI state or ANSI replay.
- The dependency provenance, license, build path, known hazards, update
  procedure, and approving owner are recorded in-tree.
- The selected pinned, vendored, or forked branch follows measured product
  needs. Vendoring is not selected merely as a precaution.
- A dependency update that changes a relied-on semantic or retention behavior
  fails the compatibility gate before production code is accepted.
- Production semantic transport, client model, surface rendering, and xterm
  cutover remain in the closure plan.

## How to validate

Run the focused compatibility corpus first, then the existing terminal and
repository gates. If a vendored or forked branch is selected, repeat the parser
build proof in a fresh isolated source/cache environment without deleting the
developer's existing caches or worktree state.

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::replay
cargo test --manifest-path core/backend/Cargo.toml terminal::runtime
./research/20260809-124553-fut-tty/vt-proof/run.sh
just test rust
just check all
git diff --check
```
