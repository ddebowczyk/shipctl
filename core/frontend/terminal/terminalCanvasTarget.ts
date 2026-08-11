/**
 * The seven drawing operations, on a Canvas 2D context.
 *
 * This is the browser half of area 04's presentation surface, and it is
 * deliberately the thinnest half. What a frame shows is decided by
 * `terminalCellPaint.ts`; in what order and in what colour it is drawn is
 * decided by `terminalCellSurface.ts`. What is left here is turning those
 * decisions into canvas calls, and it is written so that even that much is
 * provable: the context is named structurally, so the suite records a frame
 * with no browser and no DOM emulator, and a real `CanvasRenderingContext2D`
 * satisfies the same shape.
 *
 * The one terminal rule this file must not break is occupancy. It never draws
 * a run as a string: it draws the run's cells, one per host cell, each at the
 * advance the plan supplied. A `fillText` of the whole run would let the
 * browser's own shaping decide where the second glyph starts, which is the
 * measurement authority this design removes from the client.
 */

import type {
  TerminalPaintRect,
  TerminalPaintRun,
  TerminalPaintTarget,
} from "./terminalCellSurface.ts";
import type { TerminalCursorShape } from "./terminalClientModel.ts";

/**
 * The part of a 2D context this binding uses.
 *
 * Loose where the browser's own types are wider than this file needs — a fill
 * style is not only a string, and a text baseline is a fixed set of names —
 * so that a real context satisfies it without this module importing the DOM.
 */
export interface TerminalCanvasContext {
  readonly canvas: { width: number; height: number };
  fillStyle: string | object;
  font: string;
  textBaseline: string;
  save(): void;
  restore(): void;
  scale(x: number, y: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
}

/**
 * A real 2D context satisfies the shape above.
 *
 * The check is a type, so it costs nothing at runtime and this module still
 * loads in bare node. It fails the build if the structural shape and the
 * browser's own drift apart.
 */
export type TerminalCanvasContextIsReal =
  CanvasRenderingContext2D extends TerminalCanvasContext ? true : never;

/**
 * The check, made to fail the build.
 *
 * A conditional type on its own proves nothing: if it resolved to `never`,
 * nothing would read it. Assigning `true` to it is what turns a drift between
 * this shape and the browser's own into a compile error.
 */
export const CANVAS_CONTEXT_MATCHES_THE_BROWSER: TerminalCanvasContextIsReal = true;

/**
 * The font a frame is drawn in.
 *
 * The size is the caller's, and so is the cell size in the paint plan. This
 * module never measures text: how many cells a grapheme occupies came from the
 * host, and how many pixels a cell occupies came from whoever measured the
 * font.
 */
export interface TerminalCanvasFont {
  readonly family: string;
  readonly sizePx: number;
  readonly weightNormal: string;
  readonly weightBold: string;
}

export interface TerminalCanvasOptions {
  readonly font: TerminalCanvasFont;
  /** Device pixels per CSS pixel. The backing store is sized in device pixels. */
  readonly devicePixelRatio: number;
}

/**
 * A paint target that also says when its pixels are gone.
 *
 * Resizing a canvas clears it, so the frame after a size change cannot be a
 * partial one. The caller asks before it plans, because the plan is where
 * `damage` or `full` is chosen.
 */
export interface TerminalCanvasPaintTarget extends TerminalPaintTarget {
  requiresFullFrame(size: { readonly width: number; readonly height: number }): boolean;
}

/** Device pixels, rounded, for a CSS-pixel length. */
function devicePixels(length: number, ratio: number): number {
  return Math.round(length * ratio);
}

export function createCanvasPaintTarget(
  context: TerminalCanvasContext,
  options: TerminalCanvasOptions,
): TerminalCanvasPaintTarget {
  const { font, devicePixelRatio: ratio } = options;
  // The thinnest line the display can draw. It is derived from the device
  // rather than chosen: a fraction of a cell would be this module inventing a
  // proportion, and the alternative — a whole CSS pixel — is thicker than a
  // hairline needs to be on a display that can do better.
  const hairline = 1 / ratio;

  function fits(size: { readonly width: number; readonly height: number }): boolean {
    return (
      context.canvas.width === devicePixels(size.width, ratio)
      && context.canvas.height === devicePixels(size.height, ratio)
    );
  }

  return {
    requiresFullFrame(size) {
      return !fits(size);
    },

    beginFrame(size) {
      if (!fits(size)) {
        // Assigning either dimension clears the canvas. That is why
        // `requiresFullFrame` exists, and why it is asked before the plan is
        // made rather than reported afterwards.
        context.canvas.width = devicePixels(size.width, ratio);
        context.canvas.height = devicePixels(size.height, ratio);
      }
      // Everything below is in CSS pixels, which is what the plan holds.
      context.save();
      context.scale(ratio, ratio);
      // Glyphs are centred in the host's cell box. The alternative is a
      // baseline computed from font metrics, which would make this module
      // measure the font it was told the size of.
      context.textBaseline = "middle";
    },

    clear(rect: TerminalPaintRect) {
      context.clearRect(rect.x, rect.y, rect.width, rect.height);
    },

    fill(rect: TerminalPaintRect, color: string) {
      context.fillStyle = color;
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
    },

    drawRun(run: TerminalPaintRun) {
      context.font = `${run.bold ? font.weightBold : font.weightNormal} ${font.sizePx}px ${font.family}`;
      context.fillStyle = run.color;
      const middle = run.y + run.height / 2;
      for (const [index, glyph] of run.glyphs.entries()) {
        // A blank cell has already had its background drawn, and its glyph
        // would paint nothing.
        if (glyph === " ") continue;
        context.fillText(glyph, run.x + index * run.advance, middle);
      }
    },

    underline(rect: TerminalPaintRect, color: string) {
      context.fillStyle = color;
      context.fillRect(rect.x, rect.y + rect.height - hairline, rect.width, hairline);
    },

    cursor(rect: TerminalPaintRect, shape: TerminalCursorShape, color: string) {
      context.fillStyle = color;
      // Every shape but the block is a stroke, and the stroke is the same
      // hairline the link decoration uses — the display's own thinnest line,
      // not a proportion of a cell chosen here.
      if (shape === "bar") {
        context.fillRect(rect.x, rect.y, hairline, rect.height);
        return;
      }
      if (shape === "underline") {
        context.fillRect(rect.x, rect.y + rect.height - hairline, rect.width, hairline);
        return;
      }
      if (shape === "block_hollow") {
        context.fillRect(rect.x, rect.y, rect.width, hairline);
        context.fillRect(rect.x, rect.y + rect.height - hairline, rect.width, hairline);
        context.fillRect(rect.x, rect.y, hairline, rect.height);
        context.fillRect(rect.x + rect.width - hairline, rect.y, hairline, rect.height);
        return;
      }
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
    },

    endFrame() {
      context.restore();
    },
  };
}
