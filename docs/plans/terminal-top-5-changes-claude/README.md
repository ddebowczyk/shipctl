# Terminal readiness — five changes

## Purpose

These five changes prepare the terminal capability for either candidate plan:
`20260809-191201-terminal-fix-sol` or `20260809-191027-terminal-fix-opus`.
Both plans converge on the same target architecture — one ordered event
stream, with reset and replay reserved for recovery boundaries instead of
routine presentation changes. They differ only in sequencing.

Nothing here decides between the two plans. Each change is worth doing on its
own, and each removes a foundation problem that both plans would otherwise
build on top of.

## The five changes

1. [The attachment protocol is testable](attachment-protocol-is-testable.md)
   — move the attach, replay, and resync state machine out of a React effect
   so later phases have an assertion that fails before the change.
2. [One terminal protocol, one encoding](one-terminal-protocol-one-encoding.md)
   — collapse three hand-maintained copies of the event protocol into one,
   and remove JSON number arrays from the hot path.
3. [Scrollback has one authority](scrollback-has-one-authority.md)
   — connect the user setting to the parser, validate it in one place, and
   measure the unit the parser actually enforces.
4. [The VT dependency is owned](vt-dependency-is-owned.md)
   — stop resting a product guarantee on a third-party commit whose
   documentation is wrong on the field that guarantee depends on.
5. [One writer per terminal state](one-writer-per-terminal-state.md)
   — give descriptor removal and input eligibility one owner each, so the
   ordering work has stable state underneath it.

## Sequencing

```text
1 ──┐
    ├── gate everything that follows
2 ──┘

3 ── independent, ships alone
4 ── independent, ships alone   (3 and 4 can run in parallel)

5 ── after 1; before any ordering phase of either plan
```

Changes 1 and 2 gate the plan work. Change 1 creates the test seam; change 2
fixes the type surface that both plans extend with new event kinds. Changes 3
and 4 touch nothing the others touch and can proceed in parallel. Change 5 is
small and must land before the first ordering phase.

## Scope boundary

These changes fix foundations. They do not change terminal behavior, with two
exceptions, both stated in their own documents: change 3 alters how much
history the host retains, and change 5 alters how an exit-racing keystroke is
reported.

Deciding the ordering contract — what happens on resize, theme change, and
tab visibility — belongs to the chosen plan, not here.

## Validation

Every change lists its own commands. The common set:

```sh
just check all     # tsc --noEmit and the ops checks
just test fast     # node --test suites
just test rust     # cargo test --workspace
just test full     # both, plus the modularity gate
```

New frontend tests belong in `core/frontend/terminal/tests/` and must be
registered in `ops/test/justfile` in the same commit. New backend tests
belong in `#[cfg(test)] mod tests` blocks inside the module under test,
matching `core/backend/src/terminal/types.rs:373` and `service.rs:470`.
