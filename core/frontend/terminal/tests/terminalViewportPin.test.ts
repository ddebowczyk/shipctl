import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TerminalViewportPin,
  type ViewportPinSurface,
} from "../terminalViewportPin.ts";

/** A buffer the test moves by hand, recording every scroll the pin asks for. */
class FakeSurface implements ViewportPinSurface {
  readonly trace: string[] = [];
  bottom = 0;
  base = 0;

  bottomOffset(): number {
    return this.bottom;
  }
  baseY(): number {
    return this.base;
  }
  scrollToBottom(): void {
    this.trace.push("bottom");
    this.bottom = 0;
  }
  scrollToLine(line: number): void {
    this.trace.push(`line:${line}`);
  }
}

class Harness {
  readonly surface = new FakeSurface();
  readonly pin: TerminalViewportPin;
  #tasks: (() => void)[] = [];

  constructor() {
    this.pin = new TerminalViewportPin(this.surface, (task) => {
      this.#tasks.push(task);
    });
  }

  /** Run the read-backs the pin deferred. */
  settle(): void {
    for (const task of this.#tasks.splice(0)) task();
  }
}

/* ── gestures ──────────────────────────────────────────── */

test("scrolling up stops following output", () => {
  const h = new Harness();

  h.pin.noteWheel(-1);

  assert.equal(h.pin.pinnedToBottom, false);
  assert.deepEqual(h.surface.trace, [], "a wheel gesture moves the buffer itself");
});

test("scrolling down follows output again only once the end is reached", () => {
  const h = new Harness();
  h.pin.noteWheel(-1);

  h.surface.bottom = 3;
  h.pin.noteWheel(1);
  assert.equal(h.pin.pinnedToBottom, false, "the gesture has not been applied yet");

  h.settle();
  assert.equal(h.pin.pinnedToBottom, false, "three lines short of the end");

  h.surface.bottom = 0;
  h.pin.noteWheel(1);
  h.settle();
  assert.equal(h.pin.pinnedToBottom, true);
});

test("a backward viewport key with no scrollback keeps following output", () => {
  const h = new Harness();

  // Shift+PageUp asks to move back, but an empty scrollback leaves the viewport
  // at the end — which the read-back, not the intent, is what settles.
  h.pin.noteKey({ shiftKey: true, key: "PageUp" });
  assert.equal(h.pin.pinnedToBottom, false);

  h.settle();
  assert.equal(h.pin.pinnedToBottom, true);
});

test("a backward viewport key with scrollback stops following output", () => {
  const h = new Harness();
  h.surface.bottom = 12;

  h.pin.noteKey({ shiftKey: true, key: "PageUp" });
  h.settle();

  assert.equal(h.pin.pinnedToBottom, false);
});

test("ordinary typing follows output before the terminal answers", () => {
  const h = new Harness();
  h.pin.noteWheel(-1);

  h.pin.noteKey({ shiftKey: false, key: "a" });

  assert.equal(h.pin.pinnedToBottom, true);
  assert.deepEqual(h.surface.trace, ["bottom"]);
});

test("accepted input follows output", () => {
  const h = new Harness();
  h.pin.noteWheel(-1);

  h.pin.noteInputAccepted();

  assert.equal(h.pin.pinnedToBottom, true);
  assert.deepEqual(h.surface.trace, ["bottom"]);
});

/* ── replay ────────────────────────────────────────────── */

test("a replay restores the position the user was reading at", () => {
  const h = new Harness();
  h.pin.noteWheel(-1);
  h.surface.bottom = 40;

  h.pin.noteReplayReset();
  assert.equal(h.pin.pendingBottomOffset, 40);

  // The replayed buffer is longer than the one it replaced.
  h.surface.base = 500;
  h.pin.noteOutputDrained();

  assert.deepEqual(h.surface.trace, ["line:460"]);
  assert.equal(h.pin.pendingBottomOffset, null, "the restore is spent");
});

test("a user at the end of the buffer remembers nothing and stays there", () => {
  const h = new Harness();

  h.pin.noteReplayReset();
  assert.equal(h.pin.pendingBottomOffset, null);

  h.surface.base = 500;
  h.pin.noteOutputDrained();
  assert.deepEqual(h.surface.trace, ["bottom"]);
});

test("a gesture during a replay supersedes the position it would restore", () => {
  const h = new Harness();
  h.pin.noteWheel(-1);
  h.surface.bottom = 40;
  h.pin.noteReplayReset();

  h.surface.bottom = 12;
  h.pin.noteWheel(-1);
  assert.equal(h.pin.pendingBottomOffset, null);

  h.surface.base = 500;
  h.pin.noteOutputDrained();
  assert.deepEqual(h.surface.trace, [], "the user's own position is left alone");
});

test("following output wins over a remembered position", () => {
  const h = new Harness();
  h.surface.bottom = 40;
  h.pin.noteReplayReset();

  // Typing while the replay drains: the user asked to be at the end.
  h.pin.noteInputAccepted();
  h.surface.base = 500;
  h.pin.noteOutputDrained();

  assert.deepEqual(h.surface.trace, ["bottom", "bottom"]);
  assert.equal(h.pin.pendingBottomOffset, null);
});

test("a second drain does not restore the position again", () => {
  const h = new Harness();
  h.pin.noteWheel(-1);
  h.surface.bottom = 40;
  h.pin.noteReplayReset();
  h.surface.base = 500;

  h.pin.noteOutputDrained();
  h.pin.noteOutputDrained();

  assert.deepEqual(h.surface.trace, ["line:460"]);
});

/* ── disposal ──────────────────────────────────────────── */

test("a disposed pin does not read a terminal that is gone", () => {
  const h = new Harness();
  h.pin.noteWheel(-1);
  h.pin.noteWheel(1);

  h.pin.dispose();
  h.surface.bottom = 0;
  h.settle();

  assert.equal(h.pin.pinnedToBottom, false, "the deferred read-back was abandoned");
});
