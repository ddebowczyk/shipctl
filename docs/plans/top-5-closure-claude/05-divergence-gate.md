# Continuous divergence gate

## Outcome

Prove host and view agreement on every change instead of assuming it. Turn the
one-off `vt-proof` experiment into a fixture set and a merge gate.

## Context and purpose

If change 1 keeps two parsers, their agreement is a standing requirement, not a
fact established once. Parsers move: libghostty-vt is pinned to a third-party
commit (`core/backend/Cargo.toml:23`), and xterm.js updates on its own schedule.
Either side can drift, and nothing today would notice.

The existing evidence is a research artifact:
`research/20260809-124553-fut-tty/vt-proof/run.sh`. It answered one question at
one moment. It is not wired into any gate, so the divergence it found can widen
without anyone learning.

Without this change, the VT authority decision from change 1 decays. The
boundary stays true in the document and stops being true in the code, and the
next person finds the same class of defect from a different direction.

## Applies only if

Change 1 keeps two parsers. If change 1 removes one, close this change as not
applicable and record the reason in the register in `end-state.md`. Do not build
a gate for a disagreement that cannot happen.

## Depends on

Change 1. The gate tests the boundary that change 1 defines. Building it first
means testing a boundary that may move.

## Affected areas

- `research/20260809-124553-fut-tty/vt-proof`
- a durable home for the fixtures, promoted out of `research/` per the
  documentation placement rule in `CLAUDE.md`
- `ops/test/justfile`
- `docs/ops/`
- `core/backend/src/terminal/replay.rs`

## Work to be done

1. Promote the harness out of `research/`. Dated working notes stay there;
   a merge gate is durable tooling and belongs with the ops capability that runs
   it.
2. Build the fixture corpus from the divergence surface measured in change 1,
   not from the single known case. Cover reflow at wrap boundaries, alternate
   screen entry and exit, cursor save and restore, wide characters, combining
   marks, mode changes, and colors.
3. Assert only against the boundary change 1 defined. A fixture that asserts
   agreement on a fact one side no longer owns is noise and will be silenced,
   which defeats the gate.
4. Record the accepted divergence. Where the two parsers disagree and the
   product accepts it, state the case, the reason, and the approver. An accepted
   divergence is a decision; an unrecorded one is a defect waiting.
5. Register the gate in `ops/test/justfile` alongside the terminal suites,
   which readiness change 1 consolidates into one serial entry.
6. Make it gate dependency updates. The libghostty-vt compatibility fixtures
   from the readiness dependency change and this gate must run on the same
   trigger. A parser bump that passes one and fails the other must not merge.
7. Document the procedure: how to run it, how to read a failure, how to accept a
   new divergence, and who approves that.

## Acceptance criteria

- The harness has a durable home outside `research/` and runs from `just`.
- The fixture corpus covers every case in the change 1 divergence measurement.
- The gate fails when either parser changes behavior inside the owned boundary.
  This is proved by deliberately perturbing one side and observing the failure.
- The gate does not fail on facts outside the boundary. A false positive is
  treated as a defect in the gate.
- Accepted divergences are listed with reason and approver.
- A libghostty-vt version bump runs this gate and the readiness compatibility
  fixtures together.
- The failure output names the diverging case and shows both screens. A red
  result that requires re-deriving the cause by hand is not finished work.
- The procedure is documented under `docs/ops/`.

## How to validate

```sh
just test vt-divergence
cargo test --manifest-path core/backend/Cargo.toml terminal::replay
just check all
just test full
git diff --check
```

Prove the gate works by breaking it on purpose: change one parser's handling of
a covered case, confirm the gate fails and names that case, then revert. A gate
never observed failing has not been shown to work.
