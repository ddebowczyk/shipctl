# Attachment follows the terminal

## Outcome

Bind attachment lifetime to terminal existence rather than to surface
visibility. Hiding a tab must stop rendering, not stop the stream.

## Context and purpose

`TerminalView` returns early when the surface is hidden —
`core/frontend/terminal/TerminalView.tsx:238`, `if (!containerRef.current ||
!visible) return;` — and `visible` is in the effect dependency list at `:512`.
The cleanup detaches at `:502`. The container itself stays in the DOM and only
changes `display` at `:537`.

So switching tabs tears down the attachment and rebuilds it. Coming back runs
attach and full replay: recovery, caused by an ordinary click.

This is the largest remaining source of unnecessary recovery after change 2. It
also produces a second class of defect. The theme catch-up at `:292-306` exists
only because settings changed while the terminal was detached and had to be
re-applied by hand; `applyTerminalSettings` skips hidden terminals to avoid
corrupting xterm state. Every one of those catch-up paths is a chance to
diverge from the host, and each disappears once the stream is continuous.

The host already models this correctly. Attachments are identified separately
from terminals (`TerminalAttachmentId`), and the runtime already handles
multiple attachments and elects a resize authority. The frontend is the side
that conflates the two.

## Depends on

The readiness controller extraction, `docs/plans/terminal-top-5-changes-sol/`
`01-attachment-protocol-is-testable.md`. Attachment lifetime is a controller
state question, and it must be testable without React before it is changed.

## Affected areas

- `core/frontend/terminal/TerminalView.tsx`
- `core/frontend/terminal/terminalAttachmentController.ts`
- `core/frontend/terminal/terminalCache.ts`
- `core/frontend/terminal/terminalClientRuntime.ts`
- `core/frontend/terminal/terminalOutputQueue.ts`
- `core/backend/src/terminal/runtime.rs`
- `core/backend/src/terminal/service.rs`

## Work to be done

1. Separate three lifetimes that are currently one: the terminal, the
   attachment, and the rendering surface. State each one's start and end
   condition. Today only the surface has a clear one.
2. Keep the attachment open while the terminal exists and the app holds it.
   Visibility controls rendering and nothing else.
3. Decide the hidden-terminal output policy. A hidden terminal still receives
   bytes; they must go somewhere bounded. State whether they apply to xterm
   directly, buffer in the output queue, or accumulate in the host for a
   deferred bounded snapshot. Derive any bound from measurement, as change 3
   does.
4. Handle the resize authority for hidden terminals. A hidden surface has no
   meaningful geometry. State what the host uses, and make sure a hidden
   terminal cannot drive geometry for a visible one — `resize_authority` is
   elected at `runtime.rs:743` and cleared at `:852`, `:867`, and `:874`.
5. Remove the catch-up paths this makes unnecessary, starting with the theme and
   settings re-application at `TerminalView.tsx:292-306`. A catch-up path that
   survives must state why the stream cannot carry the fact.
6. Bound the total cost. Many hidden terminals attached at once must not consume
   unbounded memory or host work. Measure the cost per idle attachment and
   record it; take any cap from that measurement.
7. Define release. When the app closes a tab or the workspace unloads, the
   attachment must close exactly once, with the single-writer rules from
   readiness change 5.

## Acceptance criteria

- Hiding and showing a surface produces no attach, no detach, and no replay. A
  controller test asserts the empty trace.
- Sequence continuity holds across a hide and show cycle. The view observes no
  gap.
- A hidden terminal's output is retained under a stated, measured policy, and
  the screen is correct when the surface returns.
- A hidden terminal cannot become or remain the resize authority for a visible
  one.
- The theme and settings catch-up path in `TerminalView` is removed, or its
  survival is justified against the stream.
- Cost per idle attached terminal is measured and recorded. Any cap cites that
  measurement.
- Closing a tab detaches exactly once, under readiness change 5's rules.
- Time from clicking a background tab to a correct screen is measured against
  the pre-change path and improves or is accepted by a named owner.

## How to validate

```sh
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalClientRuntime.test.ts \
  core/frontend/terminal/tests/terminalOutputQueue.test.ts
cargo test --manifest-path core/backend/Cargo.toml terminal::runtime
cargo test --manifest-path core/backend/Cargo.toml terminal::service
rg -n 'visible' core/frontend/terminal/TerminalView.tsx
just check all
just test fast
just test rust
git diff --check
```

The `rg` result is the primary proof. Every remaining `visible` reference must
control rendering only. A `visible` reference in an effect dependency list that
governs attachment is the defect this change removes.

Manual smoke: start a long-running program, switch to another tab for a minute,
then return. The screen must be current, must not flash, and the program must
have kept running with its output intact under the stated policy.
