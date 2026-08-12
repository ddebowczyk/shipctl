import assert from "node:assert/strict";
import test from "node:test";

import { scheduleVisibleTerminalFocus } from "../src/focusVisibleTerminal.ts";

test("a newly visible thin terminal receives focus on the next frame", () => {
  let focusCount = 0;
  let scheduled: FrameRequestCallback | undefined;
  let cancelled: number | undefined;

  const cleanup = scheduleVisibleTerminalFocus(
    true,
    { focus: () => { focusCount += 1; } },
    (callback) => {
      scheduled = callback;
      return 17;
    },
    (handle) => { cancelled = handle; },
  );

  assert.equal(focusCount, 0);
  assert.ok(scheduled);
  scheduled(0);
  assert.equal(focusCount, 1);

  cleanup?.();
  assert.equal(cancelled, 17);
});

test("a hidden thin terminal does not take focus", () => {
  let scheduled = false;

  const cleanup = scheduleVisibleTerminalFocus(
    false,
    { focus: () => assert.fail("hidden terminal received focus") },
    () => {
      scheduled = true;
      return 1;
    },
    () => undefined,
  );

  assert.equal(cleanup, undefined);
  assert.equal(scheduled, false);
});
