# Bounded, cheap recovery

## Outcome

Replace unbounded replay with a newest-suffix snapshot that carries a declared,
measured bound. Make recovery cheap enough that the design stops avoiding it.

## Context and purpose

Recovery today sends the whole retained history. `replay()`
(`core/backend/src/terminal/runtime.rs:692`) produces a `TerminalReplay` whose
`bytes: Arc<[u8]>` the view installs after `term.reset()`.

While recovery is expensive, every decision bends around avoiding it. That is
the deeper reason resize took the replay path only reluctantly and why the queue
overflow path exists in the shape it does. Make recovery cheap and gap handling
stops being a hazard; it becomes an ordinary transition.

The bound must be a measured, owner-approved policy, not a number chosen for
looking reasonable. The readiness set already found what happens when a limit is
carried without evidence: `MAX_SCROLLBACK_LINES` in
`core/backend/src/terminal/replay.rs:21` is named as lines and enforced by
Ghostty as bytes, so the retained history was roughly a kilobyte. That change
established the retention policy on `TerminalService` and its measurement
method. This change spends that measurement.

## Depends on

The readiness retention change, `docs/plans/terminal-top-5-changes-sol/`
`03-scrollback-service-authority.md`. The snapshot bound and the retention
policy must be the same authority, expressed once.

## Affected areas

- `core/backend/src/terminal/replay.rs`
- `core/backend/src/terminal/runtime.rs`
- `core/backend/src/terminal/types.rs`
- `core/backend/src/terminal/service.rs`
- `core/frontend/terminal/terminalAttachmentController.ts`
- `core/frontend/terminal/terminalOutputQueue.ts`
- `core/backend/src/instance/protocol.rs`

## Work to be done

1. Define the snapshot as a newest suffix with an explicit bound and an explicit
   statement of what was omitted. A consumer must be able to tell a complete
   history from a truncated one; it must not have to guess.
2. Take the bound from the retention policy already owned by `TerminalService`,
   at the same revision. Two numbers that must agree are one number.
3. Derive the bound from measurement: snapshot size, encode time, decode time,
   and time to a correct screen, across the terminal corpus checked in during
   readiness change 2. Record the derivation. An undocumented bound is not
   admissible under the project rule on invented limits.
4. Report omission to the user where it matters. If a recovery drops history the
   user was looking at, that must be visible in the terminal, not silent.
5. Reuse the snapshot for first attach. Attach and recovery are the same
   operation at different times; they must not be two code paths that drift.
6. Re-time the overflow path. `requestReattach`
   (`core/frontend/terminal/TerminalView.tsx:341-349` before readiness change 1)
   wires queue overflow into a full reattach. With a bounded snapshot, decide
   whether overflow still needs a reattach at all.
7. Carry the snapshot through the instance control protocol. `TerminalReplayFrame`
   (`core/backend/src/instance/protocol.rs:318-324`) must express the bound and
   the omission, or the CLI observes a different truth from the app.
8. Add retention and snapshot statistics: retained rows and bytes, physical host
   eviction, and snapshot-selection omission, kept distinct. Losing history to
   the retention cap and losing it to the snapshot bound are different defects
   and must not report as one.

## Acceptance criteria

- Recovery sends a bounded newest suffix, and the frame states both the bound
  and whether content was omitted.
- The snapshot bound and the retention policy come from one authority at one
  revision. No second constant exists.
- The bound is derived from checked-in measurements over the terminal corpus,
  and the derivation is recorded with the numbers.
- First attach and recovery use the same snapshot production path.
- Omitted history is visible to the user when it affects what they were reading.
  It is never dropped silently.
- Retention statistics distinguish host eviction from snapshot omission.
- The instance control protocol carries the bound and the omission with its
  declared schema intact.
- Time to a correct screen after a gap is measured and recorded. A regression
  against the pre-change replay path is either fixed or accepted by a named
  owner.

## How to validate

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::replay
cargo test --manifest-path core/backend/Cargo.toml terminal::runtime
cargo test --manifest-path core/backend/Cargo.toml terminal::service
cargo test --manifest-path core/backend/Cargo.toml instance::control
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalOutputQueue.test.ts
rg -n 'MAX_SCROLLBACK|snapshot_bound|byte_limit' core/backend/src
just check all
just test fast
just test rust
git diff --check
```

Use corpus content with different byte-to-row expansion, so a test cannot pass
under both the byte and the row reading of the bound.

Manual smoke: produce sustained output, force a gap, and confirm the screen
returns correctly and quickly, with any dropped history stated rather than
silently missing.
