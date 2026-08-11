/**
 * When a presentation paints, and how much of it.
 *
 * The frames are the host's own, through the fail-closed decoder and the client
 * model, so the damage these traces coalesce is damage the host reported. The
 * clock and the target are injected, so every rule is a trace rather than a
 * wait: which frames collapse into one, what a collapsed frame must still
 * repaint, what a hidden presentation does, and what survives disposal.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { TerminalClientModel, type TerminalScreenFrame } from "../terminalClientModel.ts";
import { decodeTerminalEvent } from "../terminalEventDecoder.ts";
import type { TerminalCellMetrics, TerminalPaintPlan } from "../terminalCellPaint.ts";
import type { TerminalPaintTarget, TerminalSurfacePalette } from "../terminalCellSurface.ts";
import { TerminalCellPresenter } from "../terminalCellPresenter.ts";

const METRICS: TerminalCellMetrics = { cellWidth: 9, cellHeight: 18 };

const PALETTE: TerminalSurfacePalette = {
  foreground: "chrome-fg",
  background: "chrome-bg",
  cursor: "chrome-cursor",
  selection: "chrome-selection",
};

const fixture = JSON.parse(
  readFileSync(new URL("../terminalScreenFixture.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

/** The host's frame, at a sequence, with the damage the caller names. */
function hostFrame(
  sequence: number,
  damage?: { scope: "clean" | "partial" | "full"; rows: number[] },
  scrollbackRows?: number,
  cursor?: { blinking?: boolean; column?: number },
): TerminalScreenFrame {
  const event = decodeTerminalEvent(structuredClone(fixture));
  if (event.event !== "screen") throw new Error("the fixture is a screen frame");
  const state = structuredClone(event.state) as Record<string, any>;
  if (damage) state.damage = damage;
  if (scrollbackRows !== undefined) state.scrollbackRows = scrollbackRows;
  if (cursor) Object.assign(state.cursor, cursor);
  return { sequence, revision: event.revision, state, effects: [] };
}

/**
 * A window of history rows, built from the host's own rows.
 *
 * The rows are the fixture's viewport rows, so they are shaped exactly as the
 * host writes them and pass the same decoder the screen does.
 */
function hostHistory(startRow: number, rows: number, historyRows: number): unknown {
  const event = decodeTerminalEvent(structuredClone(fixture));
  if (event.event !== "screen") throw new Error("the fixture is a screen frame");
  const viewport = (structuredClone(event.state) as Record<string, any>).viewport as unknown[];
  return {
    startRow,
    historyRows,
    rows: Array.from({ length: rows }, (_, index) => viewport[index % viewport.length]),
  };
}

interface Harness {
  readonly model: TerminalClientModel;
  /** The cell the presenter is told about, or null while the font is unmeasurable. */
  metrics: TerminalCellMetrics | null;
  readonly presenter: TerminalCellPresenter;
  /** Frames drawn, each as the rows it painted. */
  readonly frames: number[][];
  readonly scheduled: (() => void)[];
  /** Run every deferred frame, the way one animation frame would. */
  tick(): void;
  /** Waits started by the presenter's own clock, longest-lived first out. */
  readonly waits: { readonly delayMs: number; readonly task: () => void }[];
  /** Let every wall-clock wait elapse. */
  elapse(): void;
  /** What the last frame decided about the cursor. */
  lit(): boolean | undefined;
  cancels: number;
  fullFrameNeeded: boolean;
}

function harness(options: { visible?: boolean } = {}): Harness {
  const model = new TerminalClientModel();
  const frames: number[][] = [];
  const scheduled: (() => void)[] = [];
  const waits: { delayMs: number; task: () => void }[] = [];
  const cursors: (boolean | undefined)[] = [];
  const target: TerminalPaintTarget & {
    requiresFullFrame(size: { width: number; height: number }): boolean;
  } = {
    beginFrame: () => {},
    clear: () => {},
    fill: () => {},
    drawRun: () => {},
    underline: () => {},
    cursor: () => {},
    endFrame: () => {},
    requiresFullFrame: () => state.fullFrameNeeded,
  };

  const state = {
    model,
    frames,
    scheduled,
    cancels: 0,
    metrics: METRICS as TerminalCellMetrics | null,
    fullFrameNeeded: false,
    tick() {
      const due = [...scheduled];
      scheduled.length = 0;
      for (const task of due) task();
    },
    waits,
    elapse() {
      const due = [...waits];
      waits.length = 0;
      for (const wait of due) wait.task();
    },
    lit: () => cursors.at(-1),
  } as unknown as Harness & { fullFrameNeeded: boolean; cancels: number };

  const presenter = new TerminalCellPresenter({
    model,
    target,
    metrics: () => state.metrics,
    palette: () => PALETTE,
    schedule: (paint) => {
      scheduled.push(paint);
      return () => {
        state.cancels += 1;
        const index = scheduled.indexOf(paint);
        if (index >= 0) scheduled.splice(index, 1);
      };
    },
    defer: (task, delayMs) => {
      const wait = { task, delayMs };
      waits.push(wait);
      return () => {
        const index = waits.indexOf(wait);
        if (index >= 0) waits.splice(index, 1);
      };
    },
    onFrame: (plan: TerminalPaintPlan) => {
      frames.push([...plan.paintedRows]);
      cursors.push(plan.cursor?.visible);
    },
  });
  Object.assign(state, { presenter });
  if (options.visible === false) presenter.setVisible(false);
  presenter.start();
  return state;
}

const ALL_ROWS = [0, 1, 2, 3, 4, 5, 6, 7];

test("a presentation that has painted nothing paints everything", () => {
  const h = harness();
  h.model.applyScreen(hostFrame(10, { scope: "partial", rows: [3] }));
  h.tick();

  assert.deepEqual(h.frames, [ALL_ROWS], "whatever the host's damage said");
});

test("frames coalesce, and the rows every one of them changed are still painted", () => {
  const h = harness();
  h.model.applyScreen(hostFrame(10));
  h.tick();
  h.frames.length = 0;

  // Three host frames between two paints. The last one's damage names row 5
  // only; painting that alone would leave rows 1 and 2 stale.
  h.model.applyScreen(hostFrame(11, { scope: "partial", rows: [1] }));
  h.model.applyScreen(hostFrame(12, { scope: "partial", rows: [2] }));
  h.model.applyScreen(hostFrame(13, { scope: "partial", rows: [5] }));
  assert.deepEqual(h.frames, [], "nothing is painted until the clock says so");

  h.tick();
  assert.deepEqual(h.frames, [[1, 2, 5]], "one frame, every row the batch changed");
});

test("a batch that carries one full repaint paints everything once", () => {
  const h = harness();
  h.model.applyScreen(hostFrame(10));
  h.tick();
  h.frames.length = 0;

  h.model.applyScreen(hostFrame(11, { scope: "partial", rows: [1] }));
  h.model.applyScreen(hostFrame(12, { scope: "full", rows: [] }));
  h.tick();

  assert.deepEqual(h.frames, [ALL_ROWS]);
});

test("a frame owed nothing is not drawn", () => {
  const h = harness();
  h.model.applyScreen(hostFrame(10));
  h.tick();
  h.frames.length = 0;

  h.model.applyScreen(hostFrame(11, { scope: "clean", rows: [] }));
  h.tick();
  assert.deepEqual(h.frames, [], "an empty repaint would still clear rows a reader can see");
});

test("a target whose pixels are gone gets a full frame it did not ask for twice", () => {
  const h = harness();
  h.model.applyScreen(hostFrame(10));
  h.tick();
  h.frames.length = 0;

  h.fullFrameNeeded = true;
  h.model.applyScreen(hostFrame(11, { scope: "partial", rows: [1] }));
  h.tick();
  assert.deepEqual(h.frames, [ALL_ROWS], "the canvas was resized under it");

  h.fullFrameNeeded = false;
  h.frames.length = 0;
  h.model.applyScreen(hostFrame(12, { scope: "partial", rows: [4] }));
  h.tick();
  assert.deepEqual(h.frames, [[4]], "and the frame after it is partial again");
});

test("invalidate makes the next frame full, and does not paint by itself", () => {
  const h = harness();
  h.model.applyScreen(hostFrame(10));
  h.tick();
  h.frames.length = 0;

  h.presenter.invalidate();
  assert.deepEqual(h.frames, [], "the clock still decides when");
  h.tick();
  assert.deepEqual(h.frames, [ALL_ROWS]);
});

test("a hidden presentation keeps watching and paints nothing until it is shown", () => {
  const h = harness();
  h.model.applyScreen(hostFrame(10));
  h.tick();
  h.frames.length = 0;

  h.presenter.setVisible(false);
  h.model.applyScreen(hostFrame(11, { scope: "partial", rows: [1] }));
  h.tick();
  assert.deepEqual(h.frames, [], "nothing is drawn into pixels nobody is looking at");
  assert.deepEqual(h.scheduled, [], "and no frame is left queued behind it");

  // Showing it again cannot trust the pixels it left, so the catch-up is
  // everything rather than the one row that changed while it was away.
  h.presenter.setVisible(true);
  h.tick();
  assert.deepEqual(h.frames, [ALL_ROWS]);
});

test("a disposed presentation cancels its frame and never paints again", () => {
  const h = harness();
  h.model.applyScreen(hostFrame(10));
  h.tick();
  h.frames.length = 0;

  h.model.applyScreen(hostFrame(11, { scope: "partial", rows: [1] }));
  h.presenter.dispose();
  assert.equal(h.cancels, 1, "the frame it had queued is taken back");

  h.tick();
  h.model.applyScreen(hostFrame(12, { scope: "partial", rows: [2] }));
  h.tick();
  assert.deepEqual(h.frames, []);
  assert.ok(h.model.state, "the model, and the terminal, are untouched");
  assert.equal(h.model.state?.sequence, 12);
});

test("a presentation started against a live model shows what is already there", () => {
  const h = harness();
  h.model.applyScreen(hostFrame(10));
  h.tick();
  h.frames.length = 0;

  // A second presentation of the same terminal: a recreated renderer, or a
  // second view of one terminal. It has painted nothing, so it paints all.
  const second: number[][] = [];
  const presenter = new TerminalCellPresenter({
    model: h.model,
    target: {
      beginFrame: () => {},
      clear: () => {},
      fill: () => {},
      drawRun: () => {},
      underline: () => {},
    cursor: () => {},
      endFrame: () => {},
    },
    metrics: () => METRICS,
    palette: () => PALETTE,
    schedule: (paint) => {
      paint();
      return () => {};
    },
    onFrame: (plan) => second.push([...plan.paintedRows]),
  });
  presenter.start();

  assert.deepEqual(second, [ALL_ROWS]);
  assert.deepEqual(h.frames, [], "the first presentation is not repainted for it");
});

test("a font that cannot be measured owes a frame instead of drawing one", () => {
  const h = harness();
  h.metrics = null;

  h.model.applyScreen(hostFrame(10));
  h.tick();
  assert.deepEqual(
    h.frames,
    [],
    "a cell size that was not measured would be the presenter inventing how " +
      "large the terminal is",
  );

  // The webfont landed. What was owed is still owed, and it is everything:
  // nothing has ever been painted into these pixels.
  h.metrics = METRICS;
  h.presenter.invalidate();
  h.tick();
  assert.deepEqual(h.frames, [ALL_ROWS]);
});

test("damage accumulated while the font was unmeasurable is not lost", () => {
  const h = harness();
  h.model.applyScreen(hostFrame(10));
  h.tick();
  h.frames.length = 0;

  h.metrics = null;
  h.model.applyScreen(hostFrame(11, { scope: "partial", rows: [1] }));
  h.tick();
  h.model.applyScreen(hostFrame(12, { scope: "partial", rows: [4] }));
  h.tick();
  assert.deepEqual(h.frames, []);

  h.metrics = METRICS;
  h.model.applyScreen(hostFrame(13, { scope: "partial", rows: [6] }));
  h.tick();
  assert.deepEqual(h.frames, [[1, 4, 6]], "every row that changed while it could not be drawn");
});

test("a reader scrolled back to rows the client does not hold owes a frame", () => {
  const h = harness();
  h.model.applyScreen(hostFrame(10, undefined, 10));
  h.tick();
  h.frames.length = 0;

  // Two rows of history above the live screen, and neither has been read.
  h.model.setViewportIntent({ followBottom: false, historyAnchor: 8 });
  h.tick();
  assert.deepEqual(
    h.frames,
    [],
    "painting the bottom instead would move the reader's eye for them",
  );

  h.model.applyHistory(hostHistory(8, 2, 10));
  h.tick();
  assert.deepEqual(h.frames, [ALL_ROWS], "and the whole display is owed, not the host's damage");
});

test("a live frame under a scrolled-back reader waits for the rows to be read again", () => {
  const h = harness();
  h.model.applyScreen(hostFrame(10, undefined, 10));
  h.model.applyHistory(hostHistory(8, 2, 10));
  h.model.setViewportIntent({ followBottom: false, historyAnchor: 8 });
  h.tick();
  h.frames.length = 0;

  // The child wrote one row of the live screen. Whatever pushed that row on may
  // have evicted history, and eviction renumbers it, so the two rows held are
  // filed under numbers that may name other lines now.
  h.model.applyScreen(hostFrame(11, { scope: "partial", rows: [1] }, 10));
  h.tick();
  assert.deepEqual(h.frames, [], "rows that may have moved are not painted as if they had not");

  // The reader is looking at history, so the row the host damaged is not where
  // it said it was and the frame is full.
  h.model.applyHistory(hostHistory(8, 2, 10));
  h.tick();
  assert.deepEqual(h.frames, [ALL_ROWS]);
});

test("returning to the bottom paints the host's own screen again", () => {
  const h = harness();
  h.model.applyScreen(hostFrame(10, undefined, 10));
  h.model.applyHistory(hostHistory(8, 2, 10));
  h.model.setViewportIntent({ followBottom: false, historyAnchor: 8 });
  h.tick();

  h.model.setViewportIntent({ followBottom: true, historyAnchor: null });
  h.tick();
  h.frames.length = 0;

  h.model.applyScreen(hostFrame(11, { scope: "partial", rows: [1] }, 10));
  h.tick();
  assert.deepEqual(h.frames, [[1]], "the host's damage is enough again");
});

test("a cursor the host says blinks is drawn on its own clock, and typing lights it", () => {
  const h = harness();
  h.model.applyScreen(hostFrame(10, undefined, undefined, { blinking: true }));
  h.tick();
  assert.equal(h.lit(), true, "a cursor is lit when it appears");
  assert.equal(h.waits.length, 1, "one wait, for the other half of the blink");
  assert.equal(h.waits[0].delayMs, 600, "the rate the product blinks at today");

  // The wait elapsing owes a frame for the cursor's row and nothing else: this
  // is the client's clock, and the host reported no change at all.
  h.frames.length = 0;
  h.elapse();
  h.tick();
  assert.deepEqual(h.frames, [[4]], "the row the cursor is on");
  assert.equal(h.lit(), false);

  h.frames.length = 0;
  h.elapse();
  h.tick();
  assert.equal(h.lit(), true, "and back");

  // A cursor that moved is a person typing. It is lit and the wait starts over,
  // so the character being typed is never under a dark cursor.
  h.elapse();
  h.tick();
  assert.equal(h.lit(), false);
  h.model.applyScreen(hostFrame(11, undefined, undefined, { blinking: true, column: 6 }));
  h.tick();
  assert.equal(h.lit(), true);
  assert.equal(h.waits.length, 1, "one clock, restarted rather than doubled");
});

test("a cursor the host does not call blinking keeps no clock at all", () => {
  const h = harness();
  h.model.applyScreen(hostFrame(10));
  h.tick();

  assert.equal(h.lit(), true);
  assert.deepEqual(h.waits, [], "nothing to wait for, so no repaint anyone asked for");
});

test("a hidden presentation stops its blink, and a disposed one drops it", () => {
  const h = harness();
  h.model.applyScreen(hostFrame(10, undefined, undefined, { blinking: true }));
  h.tick();
  assert.equal(h.waits.length, 1);

  h.presenter.setVisible(false);
  assert.deepEqual(h.waits, [], "nobody is looking at the cursor");

  h.presenter.setVisible(true);
  h.tick();
  assert.equal(h.waits.length, 1);
  h.presenter.dispose();
  assert.deepEqual(h.waits, []);
});
