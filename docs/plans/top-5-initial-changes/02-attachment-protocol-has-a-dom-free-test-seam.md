# Attachment protocol has a DOM-free test seam

## Outcome

Extract the current attach, sequence, replay, recovery, and detach state machine
from `TerminalView` into a plain TypeScript `TerminalAttachmentController` with
injected transport and output ports and deterministic trace tests.

This is a behavior-preserving extraction. The controller becomes the seam used
by the future semantic client model; this change does not implement that model
or alter current resize, theme, visibility, or replay behavior.

## Context and purpose

`TerminalView.tsx` currently combines two different responsibilities:

- xterm construction, addons, DOM mounting, font and geometry measurement,
  renderer selection, focus, scroll intent, and theme application; and
- attachment generation, buffered activation, expected sequence, replay
  installation, queue-overflow recovery, reattach coalescing, stale-generation
  rejection, input readiness, and detach cleanup.

The second responsibility lives inside one visibility-dependent React effect
and is represented by mutable refs. Its hardest traces cannot be exercised
without a DOM and xterm. The single-VT target needs the same sequencing and
recovery behavior around a renderer-independent client cell model, so leaving
it in the component would copy DOM assumptions into the replacement.

The extraction must first preserve observable behavior. Hidden-tab lifetime,
reset plus ANSI replay, local xterm output draining, and optimistic local resize
remain transitional behavior until their owning closure areas replace them.

## Affected areas

- `core/frontend/terminal/TerminalView.tsx`
- a new focused `core/frontend/terminal/terminalAttachmentController.ts`
- `core/frontend/terminal/terminalClientRuntime.ts`
- `core/frontend/terminal/terminalOutputQueue.ts`
- `core/frontend/platform/tauri.ts`
- `core/frontend/terminal/tests/terminalAttachmentController.test.ts`
- `ops/test/justfile`

## Work to be done

1. Capture current protocol traces before extraction:
   - channel events buffered before the attach invoke resolves and released by
     `activate()` only after the snapshot replay is installed;
   - initial snapshot boundary followed by consecutive live events;
   - output, replay, exit, resync-required, and detached events;
   - sequence gaps and local output-queue overflow;
   - repeated recovery requests while attach or detach is in flight;
   - stale callbacks from an earlier generation;
   - attach failure, dispose during attach, terminal identity change, and
     cleanup with an active attachment.
   Capture them through temporary instrumentation or a separate temporary
   worktree; do not use destructive cleanup or stash unrelated work.
2. Define a DOM-free controller state with explicit attachment generation,
   expected sequence, current handle, attach/recovery state, pending recovery,
   disposed state, and current input-readiness fact.
3. Inject narrow ports for attach, activate, detach, descriptor observation,
   replay installation, output delivery, lifecycle delivery, and error
   reporting. The controller must not import React, Zustand, xterm, browser DOM
   types, terminal cache objects, or renderer addons.
4. Move generation guards, expected-sequence validation, reattach exclusion and
   coalescing, snapshot installation order, activation, and detach cleanup into
   the controller.
5. Make recovery idempotent for one untrusted baseline. Multiple gap, detached,
   or queue-overflow signals while recovery is active schedule one subsequent
   recovery decision rather than concurrent attachment loops.
6. Keep the current xterm operations behind the injected adapter:
   `term.reset()`, replay geometry, output-queue registration/drain, scroll-pin
   restoration, and queue-overflow notification remain view/output concerns.
7. Reduce `TerminalView` to constructing the controller, binding its ports to
   xterm and the runtime, and starting or disposing it from the existing
   imperative integration effect. No protocol branch or generation mutation
   remains in the component.
8. Preserve the existing visibility-triggered attach/detach lifetime in this
   extraction. The closure plan later makes visibility presentation-only after
   the semantic client model can stay current without painting.
9. Register the DOM-free test suite in the repository terminal test lane. Use
   fakes and explicitly controlled promise completion rather than a browser or
   timing sleeps.

## Acceptance criteria

- `TerminalAttachmentController` has no React, DOM, xterm, renderer, terminal
  cache, or Zustand dependency.
- Attachment generation, sequence validation, bootstrap activation, recovery
  coalescing, stale callback rejection, and detach cleanup have one owner in
  the controller.
- The trace suite proves snapshot-before-buffered-event ordering and every
  recovery/disposal race listed above without mounting `TerminalView`.
- The same checked-in trace fixtures and assertions pass against the
  pre-extraction and post-extraction behavior; their expectations are not
  rewritten during the move.
- `TerminalView` contains no attachment generation counter, expected sequence,
  reattach guard, pending-reattach flag, or event protocol switch.
- Existing xterm output, replay, resize, theme, visibility, scroll-pin, focus,
  and error behavior is observably unchanged.
- Controller sequencing and recovery depend only on decoded domain-event and
  output ports, not React, xterm, or DOM types. The future semantic schema and
  client model remain closure work.
- Structural outline evidence is used to navigate the extraction, but passing
  behavior traces are the proof that nested protocol logic actually moved.

## How to validate

Run the new DOM-free trace suite with the existing output-queue, scroll-pin,
theme, and renderer characterization tests. Verify the production component
still binds xterm only through injected controller ports.

```sh
pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts \
  core/frontend/terminal/tests/terminalOutputQueue.test.ts \
  core/frontend/terminal/tests/terminalScrollPin.test.ts \
  core/frontend/terminal/tests/terminalTheme.test.ts \
  core/frontend/terminal/tests/terminalRenderer.test.ts
ast-grep outline core/frontend/terminal/TerminalView.tsx
ast-grep outline core/frontend/terminal/terminalAttachmentController.ts
rg -n 'TerminalEvent|TerminalReplay|sequenceRef|reattach|attach\(|detach\(' \
  core/frontend/terminal/TerminalView.tsx
just test fast
just check all
just modularity boundaries
git diff --check
```
