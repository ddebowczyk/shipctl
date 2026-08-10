import assert from "node:assert/strict";
import { test } from "node:test";
import type { Terminal } from "@xterm/xterm";

import {
  preserveTerminalViewport,
  resolveViewportDrainAction,
  resyncTerminalViewport,
  terminalBottomOffset,
} from "../terminalViewport.ts";

/** Records the scroll calls a real terminal would receive. The module reads
 *  `buffer.active` and calls three scroll methods, so a structural fake covers
 *  it exactly; xterm is an erased type import here and never loads. */
function fakeTerminal(buffer: { baseY: number; viewportY: number }) {
  const calls: string[] = [];
  const term = {
    buffer: { active: buffer },
    scrollToBottom: () => {
      calls.push("scrollToBottom");
    },
    scrollToLine: (line: number) => {
      calls.push(`scrollToLine:${line}`);
    },
  };
  return { term: term as unknown as Terminal, calls, buffer };
}

test("the bottom offset is the distance from the end of the scrollback", () => {
  assert.equal(terminalBottomOffset(fakeTerminal({ baseY: 500, viewportY: 500 }).term), 0);
  assert.equal(terminalBottomOffset(fakeTerminal({ baseY: 500, viewportY: 440 }).term), 60);
});

test("a viewport scrolled past the end reports zero rather than a negative offset", () => {
  // baseY shrinks when the buffer is trimmed, so viewportY can lead it.
  assert.equal(terminalBottomOffset(fakeTerminal({ baseY: 10, viewportY: 40 }).term), 0);
});

test("preserving a followed viewport returns it to the bottom", () => {
  const { term, calls } = fakeTerminal({ baseY: 500, viewportY: 500 });
  preserveTerminalViewport(term, () => {});
  assert.deepEqual(calls, ["scrollToBottom"]);
});

test("preserving a scrolled viewport restores the same distance from a moved end", () => {
  const fake = fakeTerminal({ baseY: 500, viewportY: 440 });
  // The update grows the scrollback, which is what makes an absolute line
  // number wrong and the offset right.
  preserveTerminalViewport(fake.term, () => {
    fake.buffer.baseY = 900;
  });
  // 60 lines from the end, measured against the end that now exists.
  assert.deepEqual(fake.calls, ["scrollToLine:840"]);
});

test("preserving runs the update before reading the resulting position", () => {
  const order: string[] = [];
  const fake = fakeTerminal({ baseY: 500, viewportY: 440 });
  preserveTerminalViewport(fake.term, () => {
    order.push("update");
  });
  order.push(...fake.calls);
  // This update leaves the buffer alone, so the restored line is the one the
  // viewport already held.
  assert.deepEqual(order, ["update", "scrollToLine:440"]);
});

test("preserving cannot ask for a line before the start of the buffer", () => {
  const fake = fakeTerminal({ baseY: 500, viewportY: 100 });
  preserveTerminalViewport(fake.term, () => {
    fake.buffer.baseY = 10;
  });
  assert.deepEqual(fake.calls, ["scrollToLine:0"]);
});

test("a resync with no scrollback does nothing", () => {
  const { term, calls } = fakeTerminal({ baseY: 0, viewportY: 0 });
  resyncTerminalViewport(term, 0);
  assert.deepEqual(calls, []);
});

test("a resync jumps away first so xterm cannot treat the request as a no-op", () => {
  // xterm ignores a scroll to the position it already holds, which would leave
  // the DOM viewport stuck where the browser zeroed it.
  const { term, calls } = fakeTerminal({ baseY: 500, viewportY: 440 });
  resyncTerminalViewport(term, 60);
  assert.deepEqual(calls, ["scrollToLine:0", "scrollToLine:440"]);
});

test("a resync to the bottom jumps to the far end first, not to line zero", () => {
  // The target is line 0 here, so jumping to 0 first would be the no-op the
  // first call exists to avoid.
  const { term, calls } = fakeTerminal({ baseY: 500, viewportY: 500 });
  resyncTerminalViewport(term, 500);
  assert.deepEqual(calls, ["scrollToLine:500", "scrollToLine:0"]);
});

test("a followed resync ends at the bottom rather than at a computed line", () => {
  const { term, calls } = fakeTerminal({ baseY: 500, viewportY: 500 });
  resyncTerminalViewport(term, 0);
  assert.deepEqual(calls, ["scrollToLine:0", "scrollToBottom"]);
});

test("a drain with nothing pending leaves the viewport alone", () => {
  // Ordinary live output for a user reading history must not move them.
  assert.deepEqual(
    resolveViewportDrainAction({
      pinnedToBottom: false,
      pendingBottomOffset: null,
      baseY: 900,
    }),
    { kind: "none" },
  );
});

test("a drain while following output goes to the bottom", () => {
  assert.deepEqual(
    resolveViewportDrainAction({
      pinnedToBottom: true,
      pendingBottomOffset: null,
      baseY: 900,
    }),
    { kind: "bottom" },
  );
});

test("a replay restores the distance from the end, against the rebuilt buffer", () => {
  // The user was 60 lines up. The replay rebuilt a buffer that now ends at
  // 900, so the same reading position is line 840 — not the 440 it was before
  // the reset.
  assert.deepEqual(
    resolveViewportDrainAction({
      pinnedToBottom: false,
      pendingBottomOffset: 60,
      baseY: 900,
    }),
    { kind: "line", line: 840 },
  );
});

test("a replay that retained less history than the user had scrolled back cannot scroll past the start", () => {
  assert.deepEqual(
    resolveViewportDrainAction({
      pinnedToBottom: false,
      pendingBottomOffset: 5000,
      baseY: 900,
    }),
    { kind: "line", line: 0 },
  );
});

test("following output wins over a remembered position", () => {
  // A user at the end asked to stay at the end, so a pending restore from an
  // earlier reset must not pull them back up.
  assert.deepEqual(
    resolveViewportDrainAction({
      pinnedToBottom: true,
      pendingBottomOffset: 60,
      baseY: 900,
    }),
    { kind: "bottom" },
  );
});
