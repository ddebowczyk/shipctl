# One writer per terminal state

## Context and purpose

Two pieces of terminal state have two writers each. Both candidate plans add
strict ordering guarantees on top of this state. An ordering guarantee over
state with two writers does not hold, so fix the ownership first.

**Descriptor add and remove has two writers.**
`terminalClientRuntime.ts:89-93` handles the host's registry `Removed` event:
it records the removal in `#removals` with an observation counter, deletes the
descriptor, updates the store, and publishes closed.
`terminalClientRuntime.ts:223-229` does almost the same work for `close()` —
but it never records the `#removals` observation.

That difference is a defect. `reconcile()` (`:96-145`) captures a request
boundary, awaits `listTerminals()`, then re-inserts any descriptor observed
during the await (`:114-122`) and drops any removal observed during the await
(`:123-130`). A `close()` that resolves while a `list()` is in flight is
invisible to both guards. The closed terminal returns to the store as a live
tab until the host's `Removed` event arrives and removes it a second time.

**Input eligibility has two writers.**
The view keeps `inputEnabledRef` and gates `onData` and the keybinding
handler on it (`TerminalView.tsx:109`, `:146`). It recomputes the flag from
the descriptor in three places (`:361`, `:367`, `:409`).
`terminalClientRuntime.write()` (`:204-210`) independently throws when the
lifecycle is not running.

A keystroke that races an exit therefore either disappears silently or raises
a user-facing error notice, depending on which check runs first. The two are
also different facts wearing one name: whether the transport is ready, and
whether the terminal lifecycle accepts input. Merging them is the wrong fix;
giving each one owner is the right one.

Both plans keep this work separate from the controller extraction, so that
the extraction can keep its "nothing changes" contract. Keep that separation.

## Work to be done

1. **Make the registry event the only writer for descriptor add and remove.**
   Route every mutation through one reducer. `close()` awaits the host and
   performs no bookkeeping of its own; the host already publishes `Removed`
   on close. If a synchronous local removal is required for responsiveness,
   it must record the same observation the event path records, through the
   same function.
2. **Give `reconcile()` one merge rule.** A list result that predates a
   removal can never resurrect the removed terminal, whichever path observed
   the removal.
3. **Separate the two input facts.** The attachment controller owns transport
   readiness. `TerminalClientRuntime` stays the semantic authority for
   whether the lifecycle accepts input. The view asks; it does not decide.
4. **Re-read the authority after every await.** A single gate checked once
   before an await still races. Check it before parking and again before the
   send. This follows herdr's write gate, which is checked twice for this
   reason.
5. **Classify the exit race as expected.** An exit that races a keystroke is
   normal terminal unavailability, not a transport failure. It must not raise
   an error notice. Real transport failures must stay visible.

## Acceptance criteria

- One function mutates the descriptor map for add and remove. `close()` does
  not duplicate it.
- A test drives this sequence and asserts the terminal stays removed:
  start `reconcile()`, hold the `listTerminals()` result, call `close()`,
  release the list result, then deliver the host `Removed` event.
- No path recomputes input eligibility from a descriptor outside the runtime.
  `rg 'inputEnabled' core/frontend/terminal` shows reads, not policy.
- Typing into a terminal at the moment it exits produces no error notice. A
  genuine write failure still produces one. Both are covered by tests.
- The write gate is re-read after any await on the path to the host.
- The controller extraction commit contains none of these changes.

## How to validate

```sh
just check all
just test fast
```

Frontend tests in `core/frontend/terminal/tests/`, registered in
`ops/test/justfile` with `--test-concurrency=1`:

- `close()` racing an in-flight `reconcile()` leaves no resurrected terminal;
- a `Removed` event arriving after `close()` is idempotent;
- a write during `exited` resolves as unavailable and pushes no notice;
- a write that fails in transport pushes exactly one notice;
- the write gate is re-read after the await.

By hand: open a terminal, run `exit`, and type immediately as it closes. The
tab must close cleanly with no error banner and must not reappear.
