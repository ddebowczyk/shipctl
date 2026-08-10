# Attachment protocol is testable

## Context and purpose

The terminal attachment protocol lives inside one React effect body in
`core/frontend/terminal/TerminalView.tsx:237-512`. That body holds the
generation guard, the sequence-gap check, the replay install, the
overflow-triggered reattach, and the input gate. It uses ten refs to do it.

`ast-grep outline core/frontend/terminal/TerminalView.tsx` returns two
symbols: the props interface and the default-exported component. The file
exposes no named internal symbol. Every protocol fact is therefore reachable
only by mounting the component in a DOM.

`core/frontend/terminal/tests/` holds nine suites. None covers `TerminalView`
or `terminalClientRuntime.ts`. The code that both terminal plans change most
is the code no test can observe today.

Both candidate plans schedule this extraction before their behavior work, for
the same reason: their later phases need an assertion that fails before the
change. cmux keeps the equivalent client in a standalone crate
(`crates/cmux-terminal-client`); fut keeps it in `src/client/`. In Shipctl it
is trapped in a view.

Purpose: create the test seam. Change no behavior.

## Work to be done

1. Add `core/frontend/terminal/terminalAttachmentController.ts`. It owns the
   attach lifecycle: generation counter, previous-attachment detach,
   re-entrancy guard, sequence-gap classification, replay install, and the
   overflow callback.
2. Give the controller a narrow, DOM-free port. It needs `reset` and `resize`
   from the terminal, plus `registerTerminal`, `unregisterTerminal`, and
   `writeTerminalOutput` from `terminalOutputQueue.ts`. A test drives it with
   a fake. The xterm instance stays in `terminalCache.ts`.
3. Move these parts of `TerminalView.tsx` into the controller without editing
   their logic:
   - `attachRenderer` (`:374`) and its generation guard;
   - the channel handler (`:392-412`), including the gap check
     `event.sequence !== sequenceRef.current + 1`;
   - `installReplay` (`:350-372`);
   - `requestReattach` (`:341-349`).
4. Reduce `TerminalView.tsx` to presentation: xterm construction, fonts,
   theme, scroll pin, fit, and the container lifecycle. It calls the
   controller; it does not implement the protocol.
5. Write characterization tests against current behavior first. Run them
   green before the move and green after.
6. Register the new suite in `ops/test/justfile` in the same commit, with
   `--test-concurrency=1`, matching the existing terminal entries.

## Acceptance criteria

- `core/frontend/terminal/tests/terminalAttachmentController.test.ts` exists
  and is registered in `ops/test/justfile`.
- The suite asserts, without a DOM: one sequence gap causes exactly one
  reattach; an event from a stale generation after detach is ignored; a
  replay install calls reset before it writes; queue overflow causes one
  reattach, not one per chunk; detach runs before a new attach starts.
- `ast-grep outline core/frontend/terminal/TerminalView.tsx` shows the
  component and its props only. No attach, replay, or sequence logic remains
  in the file.
- The characterization tests pass against the pre-move code and against the
  post-move code, with no edit to the assertions between the two runs.
- No behavior changes. Defects found during extraction are recorded as
  separate items, not fixed inside this change. `one-writer-per-terminal-
  state.md` owns the two known ones.

## How to validate

```sh
just check all
just test fast
```

Run the characterization suite against the parent commit first:

```sh
git stash && pnpm exec node --test --test-concurrency=1 \
  core/frontend/terminal/tests/terminalAttachmentController.test.ts
git stash pop
```

The suite must pass in both states. A test that cannot pass against the
current code has found a defect, not a refactor target. Record it and leave
the behavior alone.

Manual check: open two terminals, switch tabs, resize the window, and confirm
output, input, and exit behave as they did before the change.
