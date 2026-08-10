# The VT dependency contract is owned

## Outcome

Make Shipctl explicitly own the behavior it relies on from libghostty-vt:
proven compatibility fixtures, recorded provenance, an upgrade procedure, and
an owner decision for pinned, vendored, or forked source. Do not make vendoring
a prerequisite unless the required retention semantics justify it.

## Context and purpose

The canonical host parser is pinned to a third-party git commit
(`core/backend/Cargo.toml:23`, `uzaaft/libghostty-rs` at
`72ac98f292879bf9f788fcbb11238c562a1eebe6`). Its Rust and C documentation
misstate the unit of `max_scrollback` — the generated binding reads "Maximum
number of lines to keep in scrollback history" at
`libghostty-vt-sys/src/bindings.rs:2030`, mirroring the same error upstream —
and neither exposed API provides complete-row trimming. Recovery, resize
convergence, and retention all depend on this surface.

The team proposal is right that dependency behavior needs ownership rather than
trust in an inaccurate doc string. Its unconditional recommendation to vendor
is not yet established as essential: the no-fork architecture works with an
honest byte safety cap and row-limited projections. Vendoring or forking becomes
necessary only if the owner requires exact physical row deletion, offline source
availability, or another capability the pinned public API cannot provide.

Ownership means maintaining and gating the contract regardless of where the
source is hosted.

## Affected areas

- `core/backend/Cargo.toml`
- `Cargo.lock`
- `core/backend/src/terminal/replay.rs`
- terminal compatibility fixtures
- dependency provenance and update documentation under `docs/ops/`
- conditionally, vendored Ghostty/libghostty source and bindings

## Work to be done

1. Record the current libghostty-vt repository, commit, nested Ghostty source,
   build mechanism, licenses, exposed APIs, and known documentation defects.
2. Add semantic compatibility fixtures for retention, replay/snapshot state,
   resize/reflow, alternate screen, cursor/wrap/modes, colors, Unicode, links,
   and child-visible query responses. Prefer canonical state/behavior assertions
   over brittle exact formatter bytes unless exact bytes are themselves a
   declared wire contract.
3. Make those fixtures the gate for every dependency update and document the
   update procedure, evidence to capture, and approving owner.
4. Resolve the dependency strategy using the change 3 measurements and product
   semantics:
   - **Pinned upstream:** accepted when byte-bounded physical retention and
     honest row projections satisfy the product contract;
   - **Vendored released source:** accepted when reproducible/offline ownership
     is required and a suitable release/provenance can be verified; or
   - **Owned fork/vendor patch:** required when exact complete-row trimming or a
     proved missing read API is a product requirement.
5. For the pinned branch, document the weaker semantics and keep the lockfile
   pin plus compatibility gate. Do not claim that this branch owns unavailable
   row-trim behavior.
6. For a vendored branch, record upstream version/commit/license, configure the
   build to use the in-tree source, and prove a clean isolated build does not
   fetch parser source. Do not assume the currently pinned commit has a matching
   release tag.
7. For a fork/patch branch, expose only the proved missing capability through a
   narrow C/Rust API. Document rebase/update responsibility and keep the
   independent byte safety cap.
8. Correct local documentation and source comments to the measured byte unit in
   every branch. Where upstream docs remain wrong, link the compatibility test
   rather than copying the bad statement.
9. Record build-time and artifact changes as evidence. Any acceptance threshold
   must come from an owner-approved build/release contract, not intuition.

## Acceptance criteria

- The current parser provenance, build path, license, and known behavioral
  hazards are recorded in-tree.
- Compatibility tests fail on a regression in the terminal semantics Shipctl
  relies on, including the measured scrollback unit.
- An explicit owner decision selects pinned, vendored, or forked ownership and
  states the product semantics that require that branch. The decision is
  recorded in the README decision register with its approver, not only inside
  this document.
- The pinned branch is acceptable only with honest byte-bounded physical
  retention and no exact row-erasure claim.
- A vendored branch proves its upstream identity and parser-source
  reproducibility in a fresh isolated environment; a warm Cargo cache is not
  accepted as proof.
- A fork/patch branch is limited to a fixture-proven API gap and names its
  update/rebase owner.
- No validation command destroys unrelated workspace or cache state.
- A future parser update has a documented, repeatable gate and named approval
  boundary.

## How to validate

For every branch:

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::replay
cargo test --manifest-path core/backend/Cargo.toml terminal::runtime
./research/20260809-124553-fut-tty/vt-proof/run.sh
just test rust
just check all
git diff --check
```

If vendoring is selected, build in a newly created isolated Cargo/source cache
with network disabled after all non-parser dependencies required by the test
have been deliberately provisioned. Verify from build logs and source mapping
that the parser came from the recorded in-tree source. Do not use a warm global
cache or `git clean -xdf` as the proof.
