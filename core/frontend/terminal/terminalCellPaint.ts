/**
 * The webview half of area 04: host state turned into a paint plan.
 *
 * This module is the presentation decision, separated from whatever draws it.
 * Its whole input is the area-03 client model's screen state and the pixel size
 * of one cell; its whole output is where to put glyphs, colours, the cursor and
 * link decoration. It holds no state, keeps no cache, and touches no DOM, so
 * Canvas, WebGL and a plain DOM fallback can all consume the same plan and the
 * lane can test it with no browser at all.
 *
 * Two rules keep it presentation, and they are the same two the CLI painter
 * follows in `core/backend/src/terminal/painter.rs`:
 *
 * - **Column occupancy comes from the host cell and nothing else.** A span is
 *   two columns because the host said `wide`, never because a glyph measured
 *   wide. Nothing here calls `wcwidth`, a Unicode table, `Intl.Segmenter`, or
 *   `measureText`. Font measurement decides the *pixel size of a cell*, which
 *   this module multiplies; it never decides how many cells a grapheme takes.
 * - **Facts the child asked the host for stay in the model.** Modes, prompt
 *   marks, history and selection meaning are read, never decided.
 *
 * Unlike the CLI painter, a surface keeps its pixels between frames, so damage
 * is usable here: a partial frame repaints the rows the host named. A caller
 * whose pixels are gone — a hidden tab revealed, a renderer recreated, a theme
 * change — asks for a full repaint instead of trusting damage.
 */

import type {
  TerminalActiveScreen,
  TerminalCellModel,
  TerminalColorModel,
  TerminalCursorShape,
  TerminalScreenModel,
} from "./terminalClientModel.ts";

/** The pixel size of one cell, from font measurement. */
export interface TerminalCellMetrics {
  readonly cellWidth: number;
  readonly cellHeight: number;
}

/** A run of adjacent cells that share everything a painter needs to draw. */
export interface TerminalPaintSpan {
  /** Viewport row, from the top of the screen. */
  readonly row: number;
  /** Host column of the first cell in the run. */
  readonly column: number;
  /** Host columns the run occupies. Supplied, never measured. */
  readonly columns: number;
  /**
   * Host columns each cell in the run occupies: 1, or 2 for a run of wide
   * graphemes. A run never mixes the two, so a painter places the nth glyph at
   * `x + n * cellColumns * cellWidth` and needs no width rule of its own.
   */
  readonly cellColumns: number;
  /**
   * One entry per host cell in the run, in order.
   *
   * A painter that places glyphs on the cell grid needs to know where one
   * cell's text ends and the next begins. Deriving that from {@link text}
   * would mean segmenting graphemes on the client — the occupancy authority
   * this module exists to keep on the host.
   */
  readonly glyphs: readonly string[];
  /** The run's cells joined, for a painter that draws a run as one string. */
  readonly text: string;
  readonly bold: boolean;
  readonly foreground: TerminalColorModel | null;
  readonly background: TerminalColorModel | null;
  readonly selected: boolean;
  readonly hyperlink: string | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where the cursor is, how wide the cell under it is, and how it is drawn. */
export interface TerminalCursorPaint {
  readonly row: number;
  readonly column: number;
  readonly columns: number;
  /**
   * Whether this frame draws it.
   *
   * The host's own visibility, and — for a cursor the host says blinks — the
   * phase the caller supplied. A frame is a moment, so a blink is answered
   * here rather than left to a surface to keep a clock for.
   */
  readonly visible: boolean;
  /** The host's shape, which decides the rectangle above and how it is filled. */
  readonly shape: TerminalCursorShape;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TerminalPaintPlan {
  readonly columns: number;
  readonly rows: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly width: number;
  readonly height: number;
  readonly screen: TerminalActiveScreen;
  /**
   * The colours the child chose for cells that name none. Null means the child
   * chose none either, and the application's own theme decides — a chrome
   * decision, not a terminal one.
   */
  readonly defaultForeground: TerminalColorModel | null;
  readonly defaultBackground: TerminalColorModel | null;
  readonly reverseVideo: boolean;
  /** Rows this plan covers, ascending. A painter clears exactly these. */
  readonly paintedRows: readonly number[];
  readonly spans: readonly TerminalPaintSpan[];
  readonly cursor: TerminalCursorPaint | null;
}

export interface TerminalPaintRequest {
  readonly metrics: TerminalCellMetrics;
  /**
   * `damage` paints what the host reported changed. `full` paints everything,
   * which is what a surface asks for when its pixels are not the ones the
   * previous frame left: revealed, recreated, resized, re-themed.
   */
  readonly repaint: "damage" | "full";
  /**
   * Rows to paint instead of the ones this state reports damaged.
   *
   * A surface that coalesces several host frames into one painted frame has to
   * supply this: each state carries only its own damage, so painting the last
   * one's would leave the rows the earlier ones changed unpainted. Rows outside
   * the viewport are ignored, because a caller accumulating across a resize can
   * hold one. Ignored entirely when `repaint` is `full`.
   */
  readonly rows?: readonly number[];
  /**
   * Whether a blinking cursor is lit in this frame. Defaults to lit.
   *
   * A blink is a clock, and a plan is one moment. The caller that owns the
   * clock says which moment this is; a cursor the host does not call blinking
   * ignores it.
   */
  readonly cursorLit?: boolean;
}

/** What a cell shows. An erased cell and a written space present the same
 *  picture, so both paint a space. */
function glyph(cell: TerminalCellModel): string {
  return cell.text === "" ? " " : cell.text;
}

/** Host columns this cell claims. The only occupancy rule that ships. */
function occupancy(cell: TerminalCellModel): number {
  return cell.width === "wide" ? 2 : 1;
}

function sameStyle(left: TerminalCellModel, right: TerminalCellModel): boolean {
  return (
    left.bold === right.bold
    && left.selected === right.selected
    && left.hyperlink === right.hyperlink
    && sameColor(left.foreground, right.foreground)
    && sameColor(left.background, right.background)
  );
}

function sameColor(left: TerminalColorModel | null, right: TerminalColorModel | null): boolean {
  if (left === null || right === null) return left === right;
  return left.r === right.r && left.g === right.g && left.b === right.b;
}

function rowsToPaint(
  state: TerminalScreenModel,
  repaint: "damage" | "full",
  supplied: readonly number[] | undefined,
): number[] {
  const all = () => Array.from({ length: state.viewport.length }, (_, row) => row);
  if (repaint === "full") return all();
  if (supplied) {
    return [...new Set(supplied)]
      .filter((row) => row >= 0 && row < state.viewport.length)
      .sort((left, right) => left - right);
  }
  if (state.damage.scope === "full") return all();
  if (state.damage.scope === "clean") return [];
  // The model already refused a damage row outside this viewport, so the only
  // work left is to make the order a painter's.
  return [...new Set(state.damage.rows)].sort((left, right) => left - right);
}

/**
 * Decide what to draw for one frame of host state.
 *
 * Runs break where style breaks. A `spacer_tail` never starts or joins a run:
 * the wide cell beside it already claimed that column, and drawing the tail
 * would put a second glyph in a span the host gave to one grapheme.
 */
export function planTerminalPaint(
  state: TerminalScreenModel,
  request: TerminalPaintRequest,
): TerminalPaintPlan {
  const { cellWidth, cellHeight } = request.metrics;
  const painted = rowsToPaint(state, request.repaint, request.rows);
  const spans: TerminalPaintSpan[] = [];

  for (const row of painted) {
    const cells = state.viewport[row]?.cells ?? [];
    let open:
      | {
          start: number;
          columns: number;
          cellColumns: number;
          glyphs: string[];
          style: TerminalCellModel;
        }
      | null = null;
    const close = () => {
      if (!open) return;
      spans.push({
        row,
        column: open.start,
        columns: open.columns,
        cellColumns: open.cellColumns,
        glyphs: open.glyphs,
        text: open.glyphs.join(""),
        bold: open.style.bold,
        foreground: open.style.foreground,
        background: open.style.background,
        selected: open.style.selected,
        hyperlink: open.style.hyperlink,
        x: open.start * cellWidth,
        y: row * cellHeight,
        width: open.columns * cellWidth,
        height: cellHeight,
      });
      open = null;
    };

    for (const [column, cell] of cells.entries()) {
      if (cell.width === "spacer_tail") continue;
      const cellColumns = occupancy(cell);
      const continues = open
        && sameStyle(open.style, cell)
        && open.cellColumns === cellColumns
        && open.start + open.columns === column;
      if (!continues) close();
      if (!open) open = { start: column, columns: 0, cellColumns, glyphs: [], style: cell };
      open.columns += cellColumns;
      open.glyphs.push(glyph(cell));
    }
    close();
  }

  return {
    columns: state.columns,
    rows: state.rows,
    cellWidth,
    cellHeight,
    width: state.columns * cellWidth,
    height: state.rows * cellHeight,
    screen: state.screen,
    defaultForeground: state.colors.foreground,
    defaultBackground: state.colors.background,
    reverseVideo: state.modes.reverseVideo,
    paintedRows: painted,
    spans,
      cursor: planCursor(state, request.metrics, request.cursorLit ?? true),
  };
}

function planCursor(
  state: TerminalScreenModel,
  metrics: TerminalCellMetrics,
  lit: boolean,
): TerminalCursorPaint | null {
  const { row, column } = state.cursor;
  if (row < 0 || row >= state.viewport.length) return null;
  const cell = state.viewport[row]?.cells[column];
  if (!cell) return null;
  // A cursor on the tail of a wide grapheme belongs to the grapheme, so it is
  // drawn over the whole span the host gave it.
  const head = cell.width === "spacer_tail" ? column - 1 : column;
  const columns = occupancy(state.viewport[row]?.cells[head] ?? cell);
  return {
    row,
    column: head,
    columns,
    visible: state.cursor.visible && (lit || !state.cursor.blinking),
    shape: state.cursor.shape,
    x: head * metrics.cellWidth,
    y: row * metrics.cellHeight,
    width: columns * metrics.cellWidth,
    height: metrics.cellHeight,
  };
}

/** A point on the surface, in the surface's own pixels. */
export interface TerminalSurfacePoint {
  readonly x: number;
  readonly y: number;
}

/** A cell the host can name. */
export interface TerminalCellAddress {
  readonly row: number;
  readonly column: number;
}

/**
 * Which host cell a pixel is over, or null when the pixel is off the grid.
 *
 * A point over the second column of a wide grapheme answers with the grapheme's
 * own column. The host gave those two columns to one cell, so a click, a
 * selection edge and a link hit all belong to that cell — the browser does not
 * get to split it.
 */
export function hitTestTerminalCell(
  point: TerminalSurfacePoint,
  state: TerminalScreenModel,
  metrics: TerminalCellMetrics,
): TerminalCellAddress | null {
  if (metrics.cellWidth <= 0 || metrics.cellHeight <= 0) return null;
  if (point.x < 0 || point.y < 0) return null;
  const row = Math.floor(point.y / metrics.cellHeight);
  const column = Math.floor(point.x / metrics.cellWidth);
  const cells = state.viewport[row]?.cells;
  if (!cells) return null;
  const cell = cells[column];
  if (!cell) return null;
  return { row, column: cell.width === "spacer_tail" ? column - 1 : column };
}
