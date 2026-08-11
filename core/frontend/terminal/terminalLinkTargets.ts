/**
 * The link under a cell, and the cells that link covers.
 *
 * A link here is an OSC 8 hyperlink, which is a fact the host projects onto
 * every cell it covers (`TerminalCellModel.hyperlink`). This module does not
 * find links; it reads the ones the host already found, and answers the two
 * questions a surface has: what does this cell open, and which cells should be
 * shown as part of it.
 *
 * The run is grown by comparing URIs on neighbouring cells, and across a wrap
 * because the host says where a row wraps. It is not grown across a real
 * newline: two separate links to the same address are two links, and joining
 * them would underline text the writer never marked.
 *
 * A URL written in plain output — the kind the legacy surface found with a
 * pattern of its own — is not a link here. The host marks no cell for it, and a
 * pattern invented in this file would be the client deciding what is a link.
 */

import type { TerminalCellAddress } from "./terminalCellPaint.ts";
import type { TerminalRowModel, TerminalScreenModel } from "./terminalClientModel.ts";

/** A hyperlink, and the cells it covers. */
export interface TerminalLinkTarget {
  readonly uri: string;
  /** The run's cells, first to last, in viewport coordinates. */
  readonly cells: readonly TerminalCellAddress[];
}

/** The URI on a cell, or null when the cell has none or does not exist. */
function uriAt(row: TerminalRowModel | undefined, column: number): string | null {
  return row?.cells[column]?.hyperlink ?? null;
}

/**
 * The link on a cell, with every cell of its run.
 *
 * Null when the cell carries no hyperlink. The address is in the viewport's own
 * coordinates, which is what `hitTestTerminalCell` answers.
 */
export function terminalLinkAt(
  screen: TerminalScreenModel,
  at: TerminalCellAddress,
): TerminalLinkTarget | null {
  const uri = uriAt(screen.viewport[at.row], at.column);
  if (uri === null) return null;

  const before: TerminalCellAddress[] = [];
  let cursor = step(screen, at, -1);
  while (cursor && uriAt(screen.viewport[cursor.row], cursor.column) === uri) {
    before.push(cursor);
    cursor = step(screen, cursor, -1);
  }

  const after: TerminalCellAddress[] = [];
  cursor = step(screen, at, 1);
  while (cursor && uriAt(screen.viewport[cursor.row], cursor.column) === uri) {
    after.push(cursor);
    cursor = step(screen, cursor, 1);
  }

  before.reverse();
  return { uri, cells: [...before, at, ...after] };
}

/**
 * The next cell in reading order, or null at the end of the run's reach.
 *
 * Leaving a row is only allowed where the host says the text continues: past
 * the end of a wrapped row, and before the start of a continuation row.
 */
function step(
  screen: TerminalScreenModel,
  from: TerminalCellAddress,
  direction: 1 | -1,
): TerminalCellAddress | null {
  const row = screen.viewport[from.row];
  if (!row) return null;
  const column = from.column + direction;
  if (column >= 0 && column < row.cells.length) return { row: from.row, column };

  if (direction === 1) {
    if (!row.wrapped) return null;
    const next = screen.viewport[from.row + 1];
    if (!next || next.cells.length === 0) return null;
    return { row: from.row + 1, column: 0 };
  }

  if (!row.continuation) return null;
  const previous = screen.viewport[from.row - 1];
  if (!previous || previous.cells.length === 0) return null;
  return { row: from.row - 1, column: previous.cells.length - 1 };
}
