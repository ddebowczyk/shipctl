/**
 * A frame, as a canvas receives it.
 *
 * The context is a recorder with the same shape a real one has, so the whole
 * binding runs here: the backing store's size, the one scale per frame, where
 * each glyph lands, and what a link decoration is. The falsification this file
 * carries is the same one the plan carries — a wide grapheme owns two columns
 * and gets one `fillText`, at the run's own x.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { decodeScreenState, type TerminalScreenModel } from "../terminalClientModel.ts";
import { planTerminalPaint, type TerminalCellMetrics } from "../terminalCellPaint.ts";
import { paintTerminalFrame, type TerminalSurfacePalette } from "../terminalCellSurface.ts";
import {
  createCanvasPaintTarget,
  type TerminalCanvasContext,
  type TerminalCanvasFont,
} from "../terminalCanvasTarget.ts";

const METRICS: TerminalCellMetrics = { cellWidth: 9, cellHeight: 18 };

const FONT: TerminalCanvasFont = {
  family: "TestMono",
  sizePx: 14,
  weightNormal: "400",
  weightBold: "700",
};

const PALETTE: TerminalSurfacePalette = {
  foreground: "chrome-fg",
  background: "chrome-bg",
  cursor: "chrome-cursor",
  selection: "chrome-selection",
};

const fixture = JSON.parse(
  readFileSync(new URL("../terminalScreenFixture.json", import.meta.url), "utf8"),
) as { state: unknown };

function hostScreen(change?: (state: Record<string, any>) => void): TerminalScreenModel {
  const state = structuredClone(fixture.state) as Record<string, any>;
  change?.(state);
  return decodeScreenState(state);
}

interface Call {
  readonly op: string;
  readonly args: readonly unknown[];
  readonly style?: string;
  readonly font?: string;
}

function recordingContext() {
  const calls: Call[] = [];
  const canvas = { width: 0, height: 0 };
  const context: TerminalCanvasContext = {
    canvas,
    fillStyle: "",
    font: "",
    textBaseline: "",
    save: () => calls.push({ op: "save", args: [] }),
    restore: () => calls.push({ op: "restore", args: [] }),
    scale: (x, y) => calls.push({ op: "scale", args: [x, y] }),
    clearRect: (...args) => calls.push({ op: "clearRect", args }),
    fillRect: (...args) =>
      calls.push({ op: "fillRect", args, style: String(context.fillStyle) }),
    fillText: (...args) =>
      calls.push({ op: "fillText", args, style: String(context.fillStyle), font: context.font }),
  };
  return { context, canvas, calls };
}

function frame(
  ratio: number,
  repaint: "damage" | "full" = "full",
  change?: (state: Record<string, any>) => void,
) {
  const recorder = recordingContext();
  const target = createCanvasPaintTarget(recorder.context, {
    font: FONT,
    devicePixelRatio: ratio,
  });
  const plan = planTerminalPaint(hostScreen(change), { metrics: METRICS, repaint });
  const full = target.requiresFullFrame(plan);
  paintTerminalFrame(target, plan, PALETTE);
  return { ...recorder, target, plan, full };
}

test("the backing store is sized in device pixels and the frame is scaled once", () => {
  const { canvas, calls, plan } = frame(2);

  assert.deepEqual([canvas.width, canvas.height], [plan.width * 2, plan.height * 2]);
  assert.deepEqual(
    calls.filter((call) => call.op === "scale").map((call) => call.args),
    [[2, 2]],
    "one scale per frame; everything after it is in the plan's own pixels",
  );
  assert.equal(calls.at(0)?.op, "save");
  assert.equal(calls.at(-1)?.op, "restore", "the transform is not left behind for the next caller");
});

test("a canvas whose pixels were cleared by a resize asks for a full frame", () => {
  const { target, plan } = frame(2);

  assert.equal(target.requiresFullFrame(plan), false, "the size it was just drawn at");
  assert.equal(
    target.requiresFullFrame({ width: plan.width + 9, height: plan.height }),
    true,
    "a size change clears the canvas, so the next frame cannot be a partial one",
  );
});

test("each host cell is drawn at its own advance, never as one string", () => {
  const { calls } = frame(1);
  const glyphs = calls.filter((call) => call.op === "fillText");

  const bold = glyphs.filter((call) => call.font?.startsWith("700 "));
  assert.deepEqual(
    bold.map((call) => [call.args[0], call.args[1]]),
    [
      ["b", 2 * 9],
      ["o", 3 * 9],
      ["l", 4 * 9],
      ["d", 5 * 9],
    ],
    "four cells, four draws, each at the plan's advance",
  );
  assert.equal(bold[0].style, "rgb(10, 20, 30)");
  for (const call of bold) assert.equal(call.args[2], 18 / 2, "centred in the host's cell box");
});

test("a wide grapheme is drawn once, at the run's own x", () => {
  const { calls, plan } = frame(1);
  const wide = plan.spans.find((span) => span.cellColumns === 2);
  assert.ok(wide, "the host's frame carries a wide grapheme");

  const drawn = calls.filter(
    (call) =>
      call.op === "fillText" && call.args[1] === wide.x && call.args[2] === wide.y + 18 / 2,
  );
  assert.equal(drawn.length, 1, "two columns, one glyph");
  assert.equal(drawn[0].args[0], wide.glyphs[0]);
});

test("a space costs no draw, and the row's background still does", () => {
  const { calls } = frame(1);
  assert.equal(
    calls.some((call) => call.op === "fillText" && call.args[0] === " "),
    false,
  );
  assert.ok(calls.some((call) => call.op === "clearRect"), "rows are cleared before they are filled");
});

test("a link is decorated with one device pixel at the bottom of its cells", () => {
  const { calls } = frame(2);
  const plan = planTerminalPaint(hostScreen(), { metrics: METRICS, repaint: "full" });
  const link = plan.spans.find((span) => span.hyperlink !== null);
  assert.ok(link);

  const underline = calls.find(
    (call) =>
      call.op === "fillRect"
      && call.args[0] === link.x
      && call.args[3] === 0.5,
  );
  assert.ok(underline, "a hairline is one device pixel, which is half a CSS pixel at ratio 2");
  assert.equal(underline.args[1], link.y + link.height - 0.5, "at the bottom of the cell");
  assert.equal(underline.args[2], link.width);
});

test("each cursor shape covers the part of the cell that shape names", () => {
  // The fixture's cursor sits at column 5, row 4, one cell wide.
  const x = 5 * METRICS.cellWidth;
  const y = 4 * METRICS.cellHeight;
  const cursorOf = (shape: string) =>
    frame(2, "full", (state) => {
      state.cursor.shape = shape;
    }).calls.filter((call) => call.op === "fillRect" && call.style === "chrome-cursor");

  assert.deepEqual(
    cursorOf("block").map((call) => call.args),
    [[x, y, METRICS.cellWidth, METRICS.cellHeight]],
    "a block is the whole cell",
  );
  assert.deepEqual(
    cursorOf("bar").map((call) => call.args),
    [[x, y, 0.5, METRICS.cellHeight]],
    "a bar is one device pixel down the leading edge",
  );
  assert.deepEqual(
    cursorOf("underline").map((call) => call.args),
    [[x, y + METRICS.cellHeight - 0.5, METRICS.cellWidth, 0.5]],
    "an underline is the same hairline a link gets, at the bottom of the cell",
  );
  assert.equal(
    cursorOf("block_hollow").length,
    4,
    "a hollow block is four edges, so the glyph under it stays readable",
  );
});

test("a partial frame touches only the rows the host named", () => {
  const { calls, plan } = frame(1, "damage", (state) => {
    state.damage = { scope: "partial", rows: [2, 1] };
  });

  assert.deepEqual(plan.paintedRows, [1, 2]);
  const cleared = calls.filter((call) => call.op === "clearRect").map((call) => call.args[1]);
  assert.deepEqual(
    [...new Set(cleared)].sort((left, right) => Number(left) - Number(right)),
    plan.paintedRows.map((row) => row * 18),
  );
});
