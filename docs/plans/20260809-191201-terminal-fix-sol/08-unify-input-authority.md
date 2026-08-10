# Phase 08 — Separate input readiness from lifecycle authority

## Outcome

Input has one semantic lifecycle authority and one distinct transport-readiness
gate. A keystroke racing terminal exit becomes expected unavailability, while
real IPC/protocol failures still surface.

## Context

`TerminalView` currently derives `inputEnabledRef` from the descriptor in
several places, while `TerminalClientRuntime.write()` independently rejects a
non-running lifecycle. The same lifecycle fact is therefore copied into two
owners. Depending on race order, input is either silently dropped or reported
as a user-facing error.

The Phase 02 controller does need a readiness fact: input must not enter an
attachment while its snapshot is installing or its stream is recovering. That
is not terminal lifecycle and must not become another lifecycle authority.

## Authority rule

- `TerminalAttachmentController` owns **transport readiness**:
  `installing`, `live`, `reattaching`, `disposed`.
- `TerminalClientRuntime` owns **semantic write eligibility** from the latest
  registry descriptor and confirms it at the backend write boundary.
- The view owns neither. It forwards input only when the controller is ready;
  the runtime then returns `written` or typed `unavailable`.

## Hypotheses to verify

### H8.1 — Shared input path

All renderer-generated input can use the same readiness-plus-runtime call.
Cover key, paste, mouse, and programmatic input. Falsifier: any path still needs
a view-owned lifecycle flag.

### H8.2 — Typed unavailability

Lifecycle rejection can be distinguished from transport/protocol failure
across Tauri. Race backend exit with a raw write and inspect the adapter result.
Falsifier: Tauri collapses all failures into an indistinguishable string.

### H8.3 — Recovery input gate

Dropping input while installing/reattaching avoids an unknown terminal mode
without hiding real errors. Inject input in every controller state and force a
live transport failure. Falsifier: recovery input leaks or live errors vanish.

## Tasks

1. Enumerate keyboard, paste, mouse, and any command-driven writes; add a shared
   test matrix covering every controller state and terminal lifecycle.
2. Remove lifecycle-derived `inputEnabledRef` state and its repeated descriptor
   recomputation from `TerminalView`.
3. Expose a read-only controller readiness predicate based only on attachment
   state. It is false before snapshot completion, during recovery, after exit,
   and after disposal.
4. Give `TerminalClientRuntime.write()` a discriminated result:
   `written` or `unavailable`. It returns `unavailable` without IPC when its
   authoritative descriptor is not running.
5. Map a backend lifecycle race—terminal exits after the frontend check but
   before PTY write—to the same typed `unavailable` result. Preserve separate
   typed failures for malformed protocol, ownership/authority violation, and
   Tauri transport failure.
6. At the view boundary, ignore expected `unavailable`; report real failures
   through the existing error-notice path once. Do not turn arbitrary errors
   into silent drops.
7. Route paste and mouse through the exact same function as keyboard bytes.
   Keep xterm as the input encoder for this plan; structured key encoding by
   Ghostty belongs only to a future cell-renderer architecture.
8. Verify exit/reattach generation changes cannot re-enable an old input
   callback. Disposal must permanently close that generation's write path.

## Acceptance criteria

- `TerminalView` contains no lifecycle-based input flag or descriptor-to-input
  policy calculation.
- The controller gates only transport readiness; it does not decide whether a
  terminal lifecycle is writable.
- `TerminalClientRuntime` is the sole frontend lifecycle authority and the
  backend enforces the same fact at the PTY boundary.
- Key, paste, and mouse input are blocked during attach/replay/recovery and
  accepted only when live.
- A keystroke racing normal exit yields `unavailable` and no error notice.
- Malformed frames, ownership failures, and real IPC/write failures remain
  distinguishable and visible.
- No stale generation can write after terminal replacement or view disposal.

## Validation

```sh
pnpm exec node --test \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalClientRuntime.test.ts
cargo test --manifest-path core/backend/Cargo.toml terminal
just test fast
just test rust
just check all
git diff --check
```

## Exit condition

Do not call two checks of different facts “duplicate authority.” Finish when
readiness and lifecycle are separately named, separately tested, and composed
at one input call site.
