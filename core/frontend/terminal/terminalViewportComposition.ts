/**
 * What is displayed, when the reader is not at the bottom.
 *
 * The host renders one thing: the active screen. Everything behind it is
 * retained history, which the host answers as rows when it is asked. So a
 * client that is scrolled back is displaying host rows from two reads, and
 * *which* rows are displayed is the one thing on this path the client decides —
 * area 03 gives it viewport intent for exactly that reason. What a row *is*
 * stays the host's: nothing here reads text, measures a cell, or reflows.
 *
 * Two rules keep the composition honest:
 *
 * - **A view that cannot be composed is not approximated.** The answer is null,
 *   the caller owes a frame, and the rows arrive on the read that follows.
 *   Falling back to the bottom would move the reader's eye for them.
 * - **Row numbers are positions, and this file only ever holds one read of
 *   them.** Two windows are never joined, and a window is never carried across
 *   a frame on the assumption that its numbers still name the same lines.
 *   Whether they do is not decidable from `historyRows`: while retention grows,
 *   numbers are stable and `historyRows` moves; at the retention limit,
 *   `historyRows` stands still and eviction renumbers every row. Holding a line
 *   across time is what the host's anchors are for, and
 *   `terminalReadingAnchor.ts` holds the reader's own; the model drops its
 *   window on every frame, so nothing here reads rows across one.
 */

import type { TerminalCellAddress } from "./terminalCellPaint.ts";
import type {
  TerminalHistoryWindowModel,
  TerminalScreenModel,
  TerminalViewportIntent,
} from "./terminalClientModel.ts";
import type { TerminalProjectedPoint } from "./types.ts";

/** A read of history: the first row wanted, and how many. */
export interface TerminalHistoryRequest {
  readonly startRow: number;
  readonly rows: number;
}

/**
 * The topmost history row displayed, held to what history actually retains.
 *
 * Null while the reader is following the bottom, which displays no history.
 */
function topRow(screen: TerminalScreenModel, intent: TerminalViewportIntent): number | null {
  if (intent.followBottom || intent.historyAnchor === null) return null;
  // An anchor below zero is a row eviction already removed; one past the end is
  // a row the active screen now holds. Both are answered with the nearest row
  // that exists, because the reader is still looking at the terminal.
  return Math.max(0, Math.min(intent.historyAnchor, screen.scrollbackRows));
}

/**
 * The history rows a display needs, or null when it needs none.
 *
 * `held` is the window the client already has, and one that covers the rows
 * wanted is not asked for again. Whether it still names the same lines is the
 * caller's question, not this one's: the caller re-reads as the screen advances.
 */
export function requiredHistoryWindow(
  screen: TerminalScreenModel,
  intent: TerminalViewportIntent,
  held: TerminalHistoryWindowModel | null,
): TerminalHistoryRequest | null {
  const top = topRow(screen, intent);
  if (top === null) return null;
  const rows = Math.min(screen.rows, screen.scrollbackRows - top);
  if (rows <= 0) return null;
  if (covers(held, top, rows)) return null;
  return { startRow: top, rows };
}

function covers(
  held: TerminalHistoryWindowModel | null,
  startRow: number,
  rows: number,
): held is TerminalHistoryWindowModel {
  if (!held) return false;
  return held.startRow <= startRow && held.startRow + held.rows.length >= startRow + rows;
}

/**
 * The screen as it is displayed: history above, the active screen below.
 *
 * The same shape the host's own screen has, so the paint plan, the hit test and
 * the selection space all keep reading one kind of value. Null means the rows
 * are not held yet.
 */
export function composeDisplayedScreen(
  screen: TerminalScreenModel,
  history: TerminalHistoryWindowModel | null,
  intent: TerminalViewportIntent,
): TerminalScreenModel | null {
  const top = topRow(screen, intent);
  if (top === null) return screen;

  const fromHistory = Math.min(screen.rows, screen.scrollbackRows - top);
  if (fromHistory <= 0) return screen;
  if (!covers(history, top, fromHistory)) return null;

  const offset = top - history.startRow;
  const rows = [
    ...history.rows.slice(offset, offset + fromHistory),
    ...screen.viewport.slice(0, screen.rows - fromHistory),
  ];

  return {
    ...screen,
    viewport: rows,
    cursor: {
      ...screen.cursor,
      // The cursor is on an active row, and an active row is displayed
      // `fromHistory` rows further down. A cursor pushed off the display is not
      // drawn: it is still where the host says, just not on screen.
      row: screen.cursor.row + fromHistory,
      visible: screen.cursor.visible && screen.cursor.row + fromHistory < screen.rows,
    },
    // Damage is stated against the active viewport, and these rows are not it.
    damage: { scope: "full", rows: [] },
  };
}

/**
 * Where a displayed cell is, in the host's own coordinates.
 *
 * The answer is always in `screen` space — history and the active area
 * together, oldest row first — because that is the one space a displayed row
 * can be in whichever half it came from. A drag that starts in history and ends
 * on the live screen is one range in it; named in viewport space, the same drag
 * would be two spaces and no request.
 *
 * The reader following the bottom is not a special case: the first displayed
 * row is then the first active row, which is row `scrollbackRows` of the same
 * space.
 */
export function displayedCellInScreenSpace(
  screen: TerminalScreenModel,
  intent: TerminalViewportIntent,
  cell: TerminalCellAddress,
): TerminalProjectedPoint {
  const top = topRow(screen, intent) ?? screen.scrollbackRows;
  return { column: cell.column, row: top + cell.row };
}

/**
 * The reading position after a scroll of `rows` lines, negative for older.
 *
 * Scrolling up from the bottom starts at the row the active screen begins on,
 * so the first line of history to appear is the newest one. Scrolling back down
 * past that row follows the bottom again, which is a state rather than a
 * position: a terminal that follows the newest output keeps following it as the
 * child writes.
 */
export function scrollViewportIntent(
  screen: TerminalScreenModel,
  intent: TerminalViewportIntent,
  rows: number,
): TerminalViewportIntent {
  if (rows === 0) return intent;
  const from = topRow(screen, intent) ?? screen.scrollbackRows;
  return viewportIntentAtRow(screen, from + rows);
}

/**
 * The reading position that displays a history row at the top.
 *
 * A row past the newest one history holds is the live screen, which is followed
 * rather than held: a terminal showing the newest output keeps showing it as
 * the child writes. A row older than history keeps is the oldest it does.
 */
export function viewportIntentAtRow(
  screen: TerminalScreenModel,
  row: number,
): TerminalViewportIntent {
  const held = Math.max(0, row);
  if (held >= screen.scrollbackRows) return { followBottom: true, historyAnchor: null };
  return { followBottom: false, historyAnchor: held };
}
