# Ordered geometry and palette events

## Outcome

Give the protocol a way to express a state change. Add sequenced `Resized` and
`PaletteChanged` events with a renderer barrier, then delete the replay
publication from `resize()` and `set_theme()`.

## Context and purpose

This is the change the user feels.

`core/backend/src/terminal/runtime.rs:636` `resize()` publishes
`TerminalEvent::Replay` at `:679`. `set_theme()` at `:706` publishes it again at
`:715`. `TerminalView` responds by calling `term.reset()` in `installReplay`
(`core/frontend/terminal/TerminalView.tsx:350-372`) and writing the whole
history back. Dragging a window edge therefore runs the same path as recovery
from a lost connection.

The cost is visible: flicker, lost scroll position, lost selection, and input
encoded against renderer modes that are being torn down.

The host does this because it has no way to say "the geometry changed at
sequence N". Once the stream can carry that fact in order with the surrounding
bytes, replay on the routine path has no purpose.

The readiness set built the seam this needs: change 1 there moved the protocol
out of React into `terminalAttachmentController.ts`, and change 2 there made the
Rust event model exhaustive, so adding a variant fails compilation until every
adapter is updated.

## Depends on

Change 1, the VT authority decision. Whether `Resized` carries geometry alone or
geometry plus reflowed content depends on which side owns reflow.

## Affected areas

- `core/backend/src/terminal/types.rs`
- `core/backend/src/terminal/runtime.rs`
- `core/backend/src/terminal/protocol.rs`
- `core/backend/src/instance/protocol.rs`
- `core/backend/src/instance/control.rs`
- `core/frontend/terminal/types.ts`
- `core/frontend/terminal/terminalProtocol.ts`
- `core/frontend/terminal/terminalAttachmentController.ts`
- `core/frontend/terminal/TerminalView.tsx`
- `cli/src/terminals.rs`
- `modules/api/frontend/src/services.ts`

## Work to be done

1. Add `Resized` and `PaletteChanged` to the semantic event model in
   `types.rs`. Both carry a sequence like every other event. The readiness drift
   gate will fail compilation until the Tauri, control-socket, and TypeScript
   adapters cover them; that failure is the mechanism working.
2. Define the renderer barrier. The view must apply a geometry change at exactly
   the stream position where the host applied it, so bytes before and after the
   change are laid out against the correct geometry. State whether the barrier
   blocks the output queue or reorders within it, and prove the choice against
   sustained output.
3. Make resize acknowledgement explicit. The current `resize_authority`
   (`runtime.rs:294`, set at `:743`, cleared at `:852`, `:867`, `:874`) elects a
   single attachment to drive geometry. Decide whether that election survives,
   and state what a non-authority attachment observes when the geometry moves.
4. Delete the replay publication from `resize()` (`:679`) and `set_theme()`
   (`:715`). This is the point of the change. If either cannot be deleted, the
   ordered event is incomplete and the work is not done.
5. Handle the palette case fully. `TerminalView.tsx:292-293` defers theme
   changes while a terminal is hidden and re-applies them on becoming visible.
   With an ordered event the deferral becomes stream position, not a catch-up
   step. Remove the catch-up path or state why it survives.
6. Cover the control socket and CLI. `shipctl terminals attach` must observe the
   new events through the existing JSON adapter with its schema intact.
7. Re-measure resize latency with the method recorded during readiness. Compare
   against the checked-in baseline.

## Acceptance criteria

- `resize()` and `set_theme()` contain no `TerminalEvent::Replay` publication.
- `Resized` and `PaletteChanged` carry consecutive sequence numbers in the same
  stream as output, and a gap in either is detected like any other gap.
- Output emitted before a geometry change is laid out against the old geometry,
  and output after it against the new one. A test drives output across the
  boundary and asserts the result.
- Resize and theme change preserve scroll position and selection. A test or a
  recorded manual result shows this.
- No input is encoded from renderer modes that a geometry or palette change is
  in the middle of replacing.
- The readiness drift gate proves every adapter covers both new events.
- `shipctl terminals attach` observes both events with its declared schema
  unchanged.
- Resize latency is re-measured by the baseline method and the result is checked
  in beside the baseline. A regression is either fixed or accepted by a named
  owner.
- Recovery still works. Attach, gap, overflow, and renderer recreation continue
  to produce a correct screen.

## How to validate

```sh
cargo test --manifest-path core/backend/Cargo.toml terminal::runtime
cargo test --manifest-path core/backend/Cargo.toml terminal::protocol
cargo test --manifest-path core/backend/Cargo.toml instance::control
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalProtocol.test.ts
rg -n 'TerminalEvent::Replay' core/backend/src/terminal/runtime.rs
just check all
just test fast
just test rust
just build app
git diff --check
```

The `rg` result is the primary proof of this change. It must return no match
inside `resize()` or `set_theme()`.

Manual smoke: run a full-screen program, scroll back into history, select text,
then resize the window and change the theme. The screen must not flash, the
scroll position must hold, and the selection must survive or clear for a stated
reason.
