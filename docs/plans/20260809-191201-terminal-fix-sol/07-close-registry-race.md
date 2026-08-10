# Phase 07 — Make registry events the close bookkeeping authority

## Outcome

Closing a terminal can no longer be undone by a stale `listTerminals()` result.
All frontend descriptor removal and `closed` publication flows through the same
registry-event observation path.

## Context

`TerminalClientRuntime.close()` currently deletes its descriptor and publishes
`closed` directly. The normal registry `Removed` path additionally records a
`#removals` observation that `reconcile()` uses to reject stale list results.
If a list began before close but resolves after the manual deletion, it can
reinsert the closed descriptor until the host event arrives.

The backend already removes the record and publishes `Removed` before its close
command returns. The frontend should not maintain a weaker second removal path.

## Hypotheses to verify

### H7.1 — Backend event contract

The backend emits one `Removed` event for each successful close before
returning. Instrument close success/failure and event order. Falsifier: success
can return without publishing removal.

### H7.2 — Reconciliation order independence

Routing removal through the registry reducer makes final state independent of
event order after observed events drain. Permute list start/result, host close,
close result, and event delivery. Falsifier: any final order retains terminal.

### H7.3 — Duplicate removal

Duplicate `Removed` delivery is harmless. Deliver the same revision/event
twice. Falsifier: subscribers see duplicate semantic close or state corrupts.

## Tasks

1. Add a deferred `listTerminals()` test reproducing the current race exactly:
   start a list that includes terminal `T`, close `T`, complete close, resolve
   the stale list, then deliver/drain the host `Removed` event.
2. Make the registry-event observation/reducer the only code allowed to:
   - mutate `#descriptors` for added/updated/removed terminals;
   - update `#observations` and `#removals`; and
   - publish the corresponding runtime projection event.
3. Delete descriptor deletion and `closed` publication from `close()`. It should
   request host close, propagate a real close failure, and let the host registry
   event update the projection.
4. Preserve the existing reconciliation guard: a list result cannot overwrite
   an observation/removal newer than that list's start token.
5. Make duplicate and out-of-date registry events idempotent by terminal ID and
   revision. Publish one semantic `closed` notification only on the actual
   present-to-absent transition.
6. If UI latency between command resolution and event delivery is measurable,
   await the observed host removal with a bounded diagnostic path; do not add a
   synthetic mutation that bypasses the reducer.
7. Add close-failure coverage proving that a descriptor remains present and no
   removal observation is recorded when the backend rejects the close.

## Acceptance criteria

- `TerminalClientRuntime.close()` performs no direct descriptor mutation and
  publishes no `closed` event.
- After the host `Removed` event has been observed, no ordering of an older
  in-flight list result can resurrect the terminal.
- A successful close yields one present-to-absent transition and one semantic
  close notification, even if `Removed` is delivered twice.
- A failed close leaves the descriptor intact and emits no close notification.
- Reconciliation still admits terminals created after an older list began and
  preserves newer updates, not only removals.
- The backend test proves its event-before-return contract or this phase stops
  for a backend fix before frontend assumptions are changed.

## Validation

```sh
pnpm exec node --test \
  core/frontend/terminal/tests/terminalClientRuntime.test.ts
cargo test --manifest-path core/backend/Cargo.toml terminal::service
just test fast
just test rust
just check all
git diff --check
```

## Exit condition

Finish only when the race test passes under every explicitly permuted ordering.
Do not solve the symptom with a timeout or a second removal collection outside
the registry reducer.
