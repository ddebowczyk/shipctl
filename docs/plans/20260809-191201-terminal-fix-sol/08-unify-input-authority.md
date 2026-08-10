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

The Phase 02 controller does need a readiness fact while its snapshot installs
or stream recovers. The PTY itself does not depend on renderer parse state; the
risk is mode-sensitive encoding. xterm may still believe normal cursor, mouse,
or paste modes while the host/child expects the snapshot's application modes.
That is not terminal lifecycle and must not become another lifecycle authority.

The current xterm `onData` seam delivers bytes after mode-sensitive encoding.
Holding those bytes during recovery does not make later delivery correct. A
true defer-and-encode design must capture structured keyboard, paste, and mouse
intent before encoding and use a supported xterm 6 encoding seam after snapshot
installation.

Herdr proves the stronger single-parser design: semantic key/mouse/paste events
cross the client boundary and Ghostty encodes them from current host modes. Use
that as the escalation target, not as evidence that Shipctl's pinned binding or
xterm integration already exposes the required seam.

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

No mode-sensitive bytes are encoded or transmitted from stale renderer modes.
Inject input in every controller state and force a live transport failure.
Falsifier: recovery input leaks, is silently queued after encoding, or live
errors vanish.

### H8.4 — Deferred intent feasibility

Pinned xterm 6 exposes a supported public seam to retain bounded structured key,
paste, and mouse intents and encode them only after the snapshot restores modes.
Falsifier: only already encoded `onData` bytes or private APIs are available.

## Tasks

1. Enumerate keyboard, paste, mouse, and any command-driven writes; add a shared
   test matrix covering every controller state and terminal lifecycle.
2. Remove lifecycle-derived `inputEnabledRef` state and its repeated descriptor
   recomputation from `TerminalView`.
3. Expose a read-only controller readiness predicate based only on attachment
   state. It is false before snapshot completion, during recovery, after exit,
   and after disposal. Surface the short `installing`/`recovering` state at the
   input boundary instead of silently pretending the PTY is unavailable.
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
7. Resolve H8.4 before choosing recovery behavior:
   - if a supported structured-intent seam exists, bound the intent queue,
     encode only after snapshot installation, preserve event order, and define
     overflow/cancellation behavior; or
   - otherwise prevent keyboard/paste/mouse encoding while recovering, show the
     readiness state, and resume when live.
   Never queue already encoded mode-sensitive bytes or depend on xterm private
   APIs. If neither public xterm deferred encoding nor the pinned Ghostty
   binding exposes a complete supported encoder, suppress before encoding. A
   Herdr-style structured-input/host-encoding migration belongs to the
   conditional single-parser program and must cover keys, paste, mouse, focus,
   application cursor/keypad, kitty keyboard, and bracketed paste together.
8. Route paste and mouse through the same readiness-plus-runtime path as
   keyboard input and cover application-cursor, mouse, and bracketed-paste
   mode transitions around recovery.
9. Verify exit/reattach generation changes cannot re-enable an old input
   callback. Disposal must permanently close that generation's write path.

## Acceptance criteria

- `TerminalView` contains no lifecycle-based input flag or descriptor-to-input
  policy calculation.
- The controller gates only transport readiness; it does not decide whether a
  terminal lifecycle is writable.
- `TerminalClientRuntime` is the sole frontend lifecycle authority and the
  backend enforces the same fact at the PTY boundary.
- No keyboard, paste, or mouse bytes are encoded from stale renderer modes. If
  public deferred encoding is supported, bounded structured intents are encoded
  after recovery; otherwise the UI exposes recovery and suppresses input before
  encoding until live.
- Already encoded mode-sensitive bytes are never queued for post-recovery
  delivery, and no xterm private encoding API becomes a production dependency.
- A keystroke racing normal exit yields `unavailable` and no error notice.
- Malformed frames, ownership failures, and real IPC/write failures remain
  distinguishable and visible.
- No stale generation can write after terminal replacement or view disposal.

## Validation

```sh
pnpm exec node --test --test-concurrency=1 \
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
