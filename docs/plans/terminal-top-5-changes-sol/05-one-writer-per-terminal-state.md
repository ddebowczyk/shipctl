# One writer per terminal state

## Outcome

Give descriptor membership and input eligibility one explicit writer each
before the full plan adds stricter ordering. A stale list result cannot
resurrect a closed terminal, and an exit-racing input is typed expected
unavailability rather than a timing-dependent notice.

## Context and purpose

`TerminalClientRuntime` currently has two descriptor-removal paths. The registry
`Removed` reducer records a removal observation used by `reconcile()`, while
`close()` deletes the descriptor directly without recording that observation.
An older in-flight list can therefore reinsert the terminal until the registry
event arrives.

Input also has two apparent authorities. `TerminalView` derives an
`inputEnabled` flag from descriptors, while `TerminalClientRuntime.write()`
checks lifecycle again. These are actually two facts:

- the attachment controller knows whether renderer/transport state is ready;
- the runtime knows whether the latest terminal lifecycle accepts a write.

The view should compose those results, not own either policy. During snapshot
installation or recovery, mode-sensitive keyboard, paste, and mouse bytes must
not be encoded from stale xterm modes and queued for later delivery.

This behavior change follows the pure controller extraction in change 1.

## Affected areas

- `core/frontend/terminal/terminalClientRuntime.ts`
- `core/frontend/terminal/terminalAttachmentController.ts`
- `core/frontend/terminal/TerminalView.tsx`
- `core/frontend/platform/tauri.ts`
- `core/backend/src/terminal/types.rs`
- `core/backend/src/terminal/service.rs`
- `core/backend/src/terminal/runtime.rs`
- `core/frontend/terminal/terminalSessions.ts`
- `modules/commands/frontend/src/runtime.ts`
- `modules/assistants/frontend/src/runtime.ts`
- terminal runtime/controller tests

The module boundary is in scope. Moving `closed` publication out of `close()`
and into the reducer changes *when* modules observe session death: today it
follows the `close()` call, afterwards it follows the host `Removed` event.
`publishTerminalClosed` (`terminalSessions.ts:162`) notifies the module
session port, and `modules/commands` subscribes at `runtime.ts:60`. Module
cleanup ordering is therefore part of this change, not a downstream
consequence of it.

## Work to be done

1. Make one registry reducer the only code that mutates frontend descriptor
   membership, removal observations, terminal-store membership, and semantic
   close publication.
2. Remove direct descriptor deletion and `closed` publication from `close()`.
   Before invoking the backend, register a waiter for the matching terminal
   removal/revision. Resolve successful `close()` only after both the command
   succeeds and the reducer observes that removal.
3. Keep delayed-delivery diagnostics observational only. A timeout cannot
   mutate membership, synthesize removal, or report close success.
4. Define the user-visible outcome when the removal is never observed, for
   example because the registry channel died. Step 2 makes `close()` wait on an
   event, and step 3 correctly forbids a timeout from changing state — which
   together leave the affordance waiting with no defined end. Specify a
   visible, non-mutating failure state and a recovery action. An indefinite
   spinner on the close control is not an acceptable resolution of this rule.
5. Preserve a single reconcile rule: list results cannot overwrite descriptor
   updates or removals observed after that list request began. Make duplicate
   and stale registry events idempotent by terminal ID/revision.
6. Prove the backend contract that successful close publishes one `Removed`
   event before returning. If that invariant fails, fix it before relying on the
   frontend waiter.
7. Preserve module-visible lifecycle ordering. Steps 1 and 2 move `closed`
   publication to the reducer, which re-times the
   `ModuleTerminalSessionLifecycleEvent` that `modules/commands` and
   `modules/assistants` consume. State the new ordering, confirm the module
   runtimes tolerate it, and treat any required module change as part of this
   work rather than as fallout.
8. Remove descriptor-derived lifecycle policy from `TerminalView`.
   `TerminalAttachmentController` exposes transport readiness from its state;
   it does not decide terminal lifecycle.
9. Give `TerminalClientRuntime.write()` a discriminated `written` or
   `unavailable` result. It checks the latest descriptor before IPC; the backend
   maps a lifecycle race at the PTY boundary to the same typed unavailable
   result. Re-read the authority after every await on the path to the host, not
   only on entry. A gate checked once and then awaited still races, which is
   the defect this change exists to close. herdr checks its single write gate
   twice for this reason: before parking on a channel permit, and again before
   the send.
10. Preserve separate typed failures for malformed requests, ownership/authority
    violations, protocol errors, and real Tauri transport failures. The view
    ignores expected unavailability and reports real failures once.
11. Enumerate keyboard, paste, mouse, and programmatic writes. Route all through
    the same readiness-plus-runtime seam.
12. Resolve recovery input before choosing a queue:
    - if pinned xterm exposes a supported structured-intent/deferred-encoding
      seam, retain bounded intents and encode them only after modes are restored;
    - otherwise suppress input before xterm encodes it while installing or
      recovering, expose that short readiness state, and resume when live.

    Never queue already encoded mode-sensitive `onData` bytes or depend on
    xterm private APIs.
13. Add deterministic completion-order tests for stale list, command response,
    registry removal, duplicate removal, close failure, exit, recovery,
    disposal, lost registry channel, and real transport failure.

## Acceptance criteria

- One reducer mutates descriptor membership and removal observations. `close()`
  contains no parallel descriptor deletion or close publication.
- Successful `close()` completes only after the command succeeds and the
  matching host removal has been observed by the reducer.
- After removal observation, no older in-flight list ordering can resurrect the
  terminal, even transiently after `close()` has completed.
- Duplicate removal produces one present-to-absent transition and one semantic
  close notification. Failed close leaves the descriptor present.
- `TerminalView` contains no lifecycle-derived input policy.
- The controller owns transport readiness only; `TerminalClientRuntime` owns
  frontend lifecycle eligibility; the backend remains the final write
  authority.
- An input racing normal exit returns `unavailable` and produces no error
  notice. Transport, protocol, and authority failures remain visible and
  distinguishable.
- No keyboard, paste, or mouse bytes are encoded from stale renderer modes or
  queued after encoding for post-recovery delivery.
- A stale controller generation cannot write after replacement, exit, or
  disposal.
- The write authority is re-read after every await on the path to the host. A
  test drives an exit that lands during that await and asserts the typed
  unavailable result.
- A close whose removal is never observed reaches a defined, visible,
  non-mutating state with a recovery action. No affordance waits indefinitely.
- Module-visible session lifecycle ordering is stated and covered.
  `modules/commands/frontend/tests/commandsCharacterization.test.ts` and
  `modules/assistants/frontend/tests/assistantsCharacterization.test.ts` pass,
  or a deliberate ordering change is recorded with the module owner.

## How to validate

Use deferred list, close, registry, and transport promises to permute every
relevant completion order. Assert both final state and the point at which the
public `close()` promise resolves.

```sh
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalClientRuntime.test.ts
pnpm exec node --test --test-concurrency=1 \
  modules/commands/frontend/tests/commandsCharacterization.test.ts \
  modules/assistants/frontend/tests/assistantsCharacterization.test.ts
cargo test --manifest-path core/backend/Cargo.toml terminal::service
cargo test --manifest-path core/backend/Cargo.toml terminal::runtime
rg -n 'inputEnabled|removeTerminalDescriptor|publishTerminalClosed' \
  core/frontend/terminal/TerminalView.tsx \
  core/frontend/terminal/terminalClientRuntime.ts
just check all
just test fast
just test rust
git diff --check
```

Manual smoke: close a running terminal while typing and while a registry
reconcile is deliberately delayed. The tab closes once, produces no expected-
exit error notice, and never reappears.
