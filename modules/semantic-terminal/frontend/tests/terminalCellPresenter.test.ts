import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  TerminalCellPresenter,
  TerminalClientModel,
  type TerminalPaintPlan,
} from "../src/index.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/terminalScreenFixture.json", import.meta.url), "utf8"),
) as { sequence: number; revision: number; state: Record<string, unknown> };

test("cursor-only movement paints without waiting for visible cell damage", () => {
  const model = new TerminalClientModel();
  const scheduled: (() => void)[] = [];
  const frames: TerminalPaintPlan[] = [];
  const presenter = new TerminalCellPresenter({
    model,
    target: {
      beginFrame: () => {},
      clear: () => {},
      fill: () => {},
      drawRun: () => {},
      underline: () => {},
      cursor: () => {},
      endFrame: () => {},
    },
    metrics: () => ({ cellWidth: 9, cellHeight: 18 }),
    palette: () => ({
      foreground: "foreground",
      background: "background",
      cursor: "cursor",
      selection: "selection",
    }),
    schedule: (paint) => {
      scheduled.push(paint);
      return () => {};
    },
    defer: () => () => {},
    onFrame: (plan) => frames.push(plan),
  });
  presenter.start();

  assert.deepEqual(model.installBaseline(fixture), { status: "committed" });
  scheduled.shift()?.();
  assert.equal(frames.at(-1)?.cursor?.column, 5);

  const cursor = fixture.state.cursor as Record<string, unknown>;
  assert.deepEqual(model.applyScreen({
    sequence: fixture.sequence + 1,
    revision: fixture.revision + 1,
    state: {
      ...fixture.state,
      cursor: { ...cursor, column: 6 },
      damage: { scope: "clean", rows: [] },
    },
  }), { status: "committed" });
  scheduled.shift()?.();

  assert.equal(frames.length, 2);
  assert.deepEqual(frames[1]?.paintedRows, [4]);
  assert.equal(frames[1]?.cursor?.column, 6);
});

test("browser preference blinks a cursor whose host default is steady", () => {
  const model = new TerminalClientModel();
  const scheduled: (() => void)[] = [];
  const deferred: { task: () => void; delayMs: number }[] = [];
  const frames: TerminalPaintPlan[] = [];
  const presenter = new TerminalCellPresenter({
    model,
    target: {
      beginFrame: () => {},
      clear: () => {},
      fill: () => {},
      drawRun: () => {},
      underline: () => {},
      cursor: () => {},
      endFrame: () => {},
    },
    metrics: () => ({ cellWidth: 9, cellHeight: 18 }),
    palette: () => ({
      foreground: "foreground",
      background: "background",
      cursor: "cursor",
      selection: "selection",
    }),
    cursorBlink: () => true,
    schedule: (paint) => {
      scheduled.push(paint);
      return () => {};
    },
    defer: (task, delayMs) => {
      deferred.push({ task, delayMs });
      return () => {};
    },
    onFrame: (plan) => frames.push(plan),
  });
  presenter.start();

  assert.equal((fixture.state.cursor as { blinking: boolean }).blinking, false);
  assert.deepEqual(model.installBaseline(fixture), { status: "committed" });
  scheduled.shift()?.();

  assert.equal(frames.at(-1)?.cursor?.visible, true);
  assert.equal(deferred[0]?.delayMs, 600);

  deferred.shift()?.task();
  scheduled.shift()?.();

  assert.equal(frames.at(-1)?.cursor?.visible, false);
});
