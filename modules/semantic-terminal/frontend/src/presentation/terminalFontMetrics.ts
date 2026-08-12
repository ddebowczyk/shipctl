/**
 * The pixel size of one cell, measured from the font itself.
 *
 * `terminalMeasure.ts` decides what to do with a measurement; this decides what
 * the measurement *is*. Together they replace the old offscreen renderer,
 * which built a whole terminal — renderer, addons and
 * a detached DOM subtree — on every resize to learn two numbers.
 *
 * Nothing here decides how many cells a grapheme occupies. That is the host's
 * answer and arrives in the client model; this module only says how many pixels
 * one cell is, which is the number `terminalCellPaint.ts` multiplies. The two
 * authorities are kept apart on purpose: a client that measured occupancy would
 * be a second VT, however small.
 *
 * The measurement is a port, so the lane proves the arithmetic with no browser
 * and no DOM emulator, and a real `CanvasRenderingContext2D` satisfies the same
 * shape.
 */

import type { TerminalCellMetrics } from "./terminalCellPaint.ts";
import type { TerminalSizeProbe } from "./terminalMeasure.ts";

/** The font a terminal is rendered in, as the settings describe it. */
export interface TerminalFontRequest {
  /** A CSS font family list, already built from the user's setting. */
  readonly family: string;
  readonly sizePx: number;
  /** The multiplier applied to the font's own line box. */
  readonly lineHeight: number;
}

/**
 * What one text measurement answers.
 *
 * The bounding box is the font's, not the string's: it is the same for every
 * string in a given font, which is what makes it the line box of a cell rather
 * than the extent of whatever was passed in.
 */
export interface TerminalTextMetrics {
  readonly width: number;
  readonly fontBoundingBoxAscent: number;
  readonly fontBoundingBoxDescent: number;
}

/** The part of a 2D context this module uses, and nothing more. */
export interface TerminalTextMetricsContext {
  font: string;
  measureText(text: string): TerminalTextMetrics;
}

/**
 * A real 2D context satisfies the shape above.
 *
 * The check is a type, so it costs nothing at runtime and this module still
 * loads in bare node. Assigning `true` to it is what turns a drift between this
 * shape and the browser's own into a compile error.
 */
export type TerminalTextMetricsContextIsReal =
  CanvasRenderingContext2D extends TerminalTextMetricsContext ? true : never;

export const TEXT_METRICS_CONTEXT_MATCHES_THE_BROWSER: TerminalTextMetricsContextIsReal = true;

/**
 * The character the cell width is taken from.
 *
 * A terminal font is monospace, so every cell is one advance wide and one
 * character says what that advance is. Measuring a longer string would average
 * the same number, and would invite the browser's own shaping — kerning,
 * ligatures — into a number that must stay the font's advance.
 */
const CELL_WIDTH_SAMPLE = "M";

/**
 * Measure one cell, or answer `null` when the font cannot be measured.
 *
 * `null` is a real answer, not a failure to report: a font that has not loaded,
 * a canvas with no metrics, or an engine that does not expose the font's line
 * box leaves the caller to fall back rather than to guess a size and send it to
 * a child process.
 */
export function measureTerminalCell(
  context: TerminalTextMetricsContext,
  font: TerminalFontRequest,
): TerminalCellMetrics | null {
  context.font = `${font.sizePx}px ${font.family}`;
  const metrics = context.measureText(CELL_WIDTH_SAMPLE);

  const cellWidth = metrics.width;
  // The font's own line box, which is what the glyphs need vertically. The
  // font size alone is smaller than that box and would fit rows the renderer
  // then clips.
  const lineBox = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
  const cellHeight = lineBox * font.lineHeight;

  if (!usable(cellWidth) || !usable(cellHeight)) return null;
  return { cellWidth, cellHeight };
}

function usable(length: number): boolean {
  return Number.isFinite(length) && length > 0;
}

/**
 * How many whole cells fit in a box.
 *
 * A partial cell is not a cell: the child is told about columns it can write
 * all of. What is done about a box that holds fewer than a terminal's minimum
 * is `terminalMeasure.ts`'s decision, not this one.
 */
export function cellsForBox(
  box: { readonly width: number; readonly height: number },
  metrics: TerminalCellMetrics,
): { cols: number; rows: number } | null {
  if (!usable(metrics.cellWidth) || !usable(metrics.cellHeight)) return null;
  return {
    cols: Math.floor(box.width / metrics.cellWidth),
    rows: Math.floor(box.height / metrics.cellHeight),
  };
}

/**
 * A size probe that measures the font instead of building a terminal.
 *
 * The cell is measured on every probe rather than cached, because the font and
 * its size are settings a person changes while the terminal is open, and a
 * cached cell would keep sizing the child to the font it no longer renders.
 */
export function createFontMetricsProbe(
  measure: () => TerminalCellMetrics | null,
): TerminalSizeProbe {
  return (containerWidth, containerHeight) => {
    const metrics = measure();
    if (!metrics) return null;
    return cellsForBox({ width: containerWidth, height: containerHeight }, metrics);
  };
}
