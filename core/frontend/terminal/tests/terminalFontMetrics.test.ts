/**
 * The measurement itself, with no browser and no xterm.
 *
 * The context these inject stands where a real `CanvasRenderingContext2D`
 * stands in the browser binding. What is proved is what the surface depends on:
 * a cell is the font's advance and the font's line box, a font that cannot be
 * measured says so, and nothing here ever decides how many cells a grapheme
 * takes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cellsForBox,
  createFontMetricsProbe,
  measureTerminalCell,
  type TerminalFontRequest,
  type TerminalTextMetrics,
  type TerminalTextMetricsContext,
} from "../terminalFontMetrics.ts";
import { resolveTerminalSize, TERMINAL_FALLBACK_SIZE } from "../terminalMeasure.ts";

const FONT: TerminalFontRequest = { family: '"MesloLGS NF", monospace', sizePx: 14, lineHeight: 1 };

/** A context that answers fixed metrics and records the font it was set to. */
function context(
  metrics: Partial<TerminalTextMetrics>,
): TerminalTextMetricsContext & { fonts: string[]; measured: string[] } {
  const fonts: string[] = [];
  const measured: string[] = [];
  return {
    fonts,
    measured,
    set font(value: string) {
      fonts.push(value);
    },
    get font() {
      return fonts[fonts.length - 1] ?? "";
    },
    measureText(text: string) {
      measured.push(text);
      return {
        width: 8,
        fontBoundingBoxAscent: 11,
        fontBoundingBoxDescent: 3,
        ...metrics,
      };
    },
  };
}

test("a cell is the font's advance wide and its line box tall", () => {
  const ctx = context({});

  assert.deepEqual(measureTerminalCell(ctx, FONT), { cellWidth: 8, cellHeight: 14 });
  assert.deepEqual(
    ctx.fonts,
    ["14px \"MesloLGS NF\", monospace"],
    "the font is measured in the size and family it will be drawn in",
  );
  assert.equal(
    ctx.measured.length,
    1,
    "one advance is the whole answer for a monospace font; measuring a longer " +
      "string would invite the browser's shaping into the number",
  );
});

test("the line height multiplies the font's box, not the font's size", () => {
  // Ascent and descent are 11 and 3: a box of 14 for a 14px font, which is the
  // reason the size alone cannot stand in for it.
  const measured = measureTerminalCell(context({}), { ...FONT, lineHeight: 1.5 });

  assert.deepEqual(measured, { cellWidth: 8, cellHeight: 21 });
});

test("a font whose box the engine will not name is unmeasurable", () => {
  for (const broken of [
    { width: 0 },
    { width: Number.NaN },
    { fontBoundingBoxAscent: Number.NaN },
    { fontBoundingBoxAscent: 0, fontBoundingBoxDescent: 0 },
    { fontBoundingBoxAscent: undefined as unknown as number },
  ]) {
    assert.equal(
      measureTerminalCell(context(broken), FONT),
      null,
      `${JSON.stringify(broken)} answers null rather than a guessed cell`,
    );
  }
});

test("only whole cells are reported", () => {
  assert.deepEqual(
    cellsForBox({ width: 87, height: 44 }, { cellWidth: 8, cellHeight: 14 }),
    { cols: 10, rows: 3 },
    "a partial cell is not a column the child may write all of",
  );
});

test("a box smaller than one cell reports none, and the policy decides", () => {
  const metrics = { cellWidth: 8, cellHeight: 14 };

  assert.deepEqual(cellsForBox({ width: 4, height: 4 }, metrics), { cols: 0, rows: 0 });
  assert.deepEqual(
    resolveTerminalSize(4, 4, createFontMetricsProbe(() => metrics)),
    { cols: 2, rows: 2 },
    "the floor belongs to ../terminalMeasure.ts, which is where it is proved",
  );
});

test("an unmeasurable font falls back instead of sizing the child to nothing", () => {
  const size = resolveTerminalSize(800, 600, createFontMetricsProbe(() => null));

  assert.deepEqual(size, TERMINAL_FALLBACK_SIZE);
});

test("the probe measures on every call, so a font change is honoured", () => {
  let metrics = { cellWidth: 8, cellHeight: 14 };
  const probe = createFontMetricsProbe(() => metrics);

  assert.deepEqual(probe(800, 600), { cols: 100, rows: 42 });
  metrics = { cellWidth: 16, cellHeight: 28 };
  assert.deepEqual(
    probe(800, 600),
    { cols: 50, rows: 21 },
    "a cached cell would keep sizing the child to a font it no longer renders",
  );
});

test("a cell measured as nothing is refused by the probe as well", () => {
  const probe = createFontMetricsProbe(() => ({ cellWidth: 0, cellHeight: 14 }));

  assert.equal(probe(800, 600), null, "dividing by it would report an infinity of columns");
});
