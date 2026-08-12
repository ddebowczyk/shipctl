/**
 * Drawing a paint plan, apart from the thing that owns the pixels.
 *
 * `terminalCellPaint.ts` decides *what* a frame shows. This module decides *in
 * what order* it is drawn and *which colour* each part takes, and it issues
 * those decisions to a [`TerminalPaintTarget`] — a port with six operations and
 * no knowledge of terminals. A Canvas 2D context, a WebGL painter and a plain
 * DOM fallback can each implement it, and the lane can record it.
 *
 * The split is the point. Everything a reader could disagree with — order,
 * colour resolution, what a selection looks like, what happens under reverse
 * video — is here, in a module that loads in bare node. What is left for the
 * browser-only binding is turning six calls into pixels.
 *
 * This module computes no geometry. Every rectangle it passes on comes from the
 * plan, which took it from the host's columns and the measured size of one
 * cell.
 */

import type {
  TerminalColorModel,
  TerminalCursorShape,
} from "./terminalClientModel.ts";
import type { TerminalPaintPlan } from "./terminalCellPaint.ts";

export interface TerminalPaintRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TerminalPaintRun extends TerminalPaintRect {
  /**
   * One entry per host cell, in order. A painter that puts glyphs on the cell
   * grid draws the nth entry at `x + n * advance`; splitting {@link text}
   * itself would mean deciding grapheme boundaries on the client.
   */
  readonly glyphs: readonly string[];
  /** The same cells joined, for a painter that draws a run as one string. */
  readonly text: string;
  /** Pixels one cell of this run occupies. A painter advances by it per glyph. */
  readonly advance: number;
  readonly bold: boolean;
  readonly color: string;
  /** The link this run carries, for decoration and hit feedback. */
  readonly hyperlink: string | null;
}

/** What a surface must be able to do. Seven operations, no terminal facts. */
export interface TerminalPaintTarget {
  /** A frame is about to be drawn. The plan's full pixel size is given so a
   *  target can size or scale its own buffer. */
  beginFrame(size: { readonly width: number; readonly height: number }): void;
  clear(rect: TerminalPaintRect): void;
  fill(rect: TerminalPaintRect, color: string): void;
  drawRun(run: TerminalPaintRun): void;
  /** Underline for a link. Kept apart from `drawRun` so a target may skip it. */
  underline(rect: TerminalPaintRect, color: string): void;
  /**
   * The cursor, in the cell the plan measured for it.
   *
   * Its own operation because only a target knows how thin a thin line may be:
   * a bar, an underline and a hollow block are all a stroke, and a fraction of
   * a cell chosen here would be this module deciding a thickness for every
   * display. The rectangle is the whole cell; the shape says what of it to
   * cover.
   */
  cursor(rect: TerminalPaintRect, shape: TerminalCursorShape, color: string): void;
  endFrame(): void;
}

/**
 * The colours the application supplies for what the child left unsaid.
 *
 * The child names foreground and background when it wants them; when it does
 * not, the chrome decides, and that decision is the application's rather than
 * the terminal's. Cursor and selection are always the chrome's.
 */
export interface TerminalSurfacePalette {
  readonly foreground: string;
  readonly background: string;
  readonly cursor: string;
  readonly selection: string;
}

export function cssColor(color: TerminalColorModel): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

function resolve(color: TerminalColorModel | null, fallback: string): string {
  return color === null ? fallback : cssColor(color);
}

/**
 * Draw one frame.
 *
 * Order is fixed and shallow: the rows the plan names are cleared to the
 * background, then every run's own background, then the cursor, then the
 * glyphs, then link decoration. A target that draws these in the order given
 * needs no z-ordering of its own.
 *
 * The cursor is drawn under the glyphs on purpose. A block cursor painted over
 * them would hide the character it is sitting on, and re-drawing that one
 * character afterwards would mean this module deciding which glyph the cursor
 * covers — a cell lookup it has no reason to own.
 *
 * Only the rows the plan named are touched. Everything else on the surface is
 * the previous frame's, which is what makes a partial frame cheap and what
 * makes `repaint: "full"` the answer whenever those pixels cannot be trusted.
 */
export function paintTerminalFrame(
  target: TerminalPaintTarget,
  plan: TerminalPaintPlan,
  palette: TerminalSurfacePalette,
): void {
  // Reverse video is the child asking for the whole screen inverted. It is a
  // presentation swap of the two defaults, and it changes no cell.
  const defaultForeground = plan.reverseVideo
    ? resolve(plan.defaultBackground, palette.background)
    : resolve(plan.defaultForeground, palette.foreground);
  const defaultBackground = plan.reverseVideo
    ? resolve(plan.defaultForeground, palette.foreground)
    : resolve(plan.defaultBackground, palette.background);

  target.beginFrame({ width: plan.width, height: plan.height });

  for (const row of plan.paintedRows) {
    const rect = { x: 0, y: row * plan.cellHeight, width: plan.width, height: plan.cellHeight };
    target.clear(rect);
    target.fill(rect, defaultBackground);
  }

  for (const span of plan.spans) {
    const background = span.selected
      ? palette.selection
      : span.background === null
        ? null
        : cssColor(span.background);
    if (background !== null) target.fill(rectOf(span), background);
  }

  const { cursor } = plan;
  if (cursor && cursor.visible && plan.paintedRows.includes(cursor.row)) {
    target.cursor(rectOf(cursor), cursor.shape, palette.cursor);
  }

  for (const span of plan.spans) {
    // A run of blanks has nothing to draw; its background is already painted.
    if (span.text.trim() === "") continue;
    target.drawRun({
      ...rectOf(span),
      glyphs: span.glyphs,
      text: span.text,
      advance: span.cellColumns * plan.cellWidth,
      bold: span.bold,
      color: resolve(span.foreground, defaultForeground),
      hyperlink: span.hyperlink,
    });
  }

  for (const span of plan.spans) {
    if (span.hyperlink === null) continue;
    target.underline(rectOf(span), resolve(span.foreground, defaultForeground));
  }

  target.endFrame();
}

function rectOf(rect: TerminalPaintRect): TerminalPaintRect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}
