/**
 * What a reader who scrolled back is shown.
 *
 * The screens below name each row by its text, so a composed view can be read
 * as a list of lines and compared whole. That is the fault worth catching: a
 * composition that is one row out shows the reader a screen that exists, made
 * of rows that are real, in an order the terminal never had.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  TerminalHistoryWindowModel,
  TerminalRowModel,
  TerminalScreenModel,
  TerminalViewportIntent,
} from "../terminalClientModel.ts";
import {
  composeDisplayedScreen,
  requiredHistoryWindow,
  scrollViewportIntent,
} from "../terminalViewportComposition.ts";

function row(text: string): TerminalRowModel {
  return {
    wrapped: false,
    continuation: false,
    prompt: "none",
    cells: [
      {
        text,
        width: "narrow",
        bold: false,
        foreground: null,
        background: null,
        selected: false,
        hyperlink: null,
      },
    ],
  };
}

/** The one cell of each row, which is how these rows are named. */
function lines(screen: TerminalScreenModel | null): readonly string[] {
  assert.ok(screen, "the view composed");
  return screen.viewport.map((line) => line.cells[0]?.text ?? "");
}

/** An active screen of three rows, with `scrollbackRows` behind it. */
function screenModel(scrollbackRows: number, cursorRow = 0): TerminalScreenModel {
  return {
    columns: 1,
    rows: 3,
    screen: "primary",
    scrollbackRows,
    cursor: { column: 0, row: cursorRow, visible: true, pendingWrap: false },
    modes: {
      wraparound: true,
      bracketedPaste: false,
      applicationCursorKeys: false,
      applicationKeypad: false,
      focusEvents: false,
      mouseTracking: false,
      insert: false,
      reverseVideo: false,
      origin: false,
    },
    colors: { foreground: null, background: null, palette: [] },
    damage: { scope: "partial", rows: [1] },
    viewport: [row("live-0"), row("live-1"), row("live-2")],
  };
}

/** A window of history rows, named by their history row number. */
function windowModel(
  startRow: number,
  count: number,
  historyRows: number,
): TerminalHistoryWindowModel {
  return {
    startRow,
    historyRows,
    rows: Array.from({ length: count }, (_, index) => row(`history-${startRow + index}`)),
  };
}

const FOLLOWING: TerminalViewportIntent = { followBottom: true, historyAnchor: null };
const at = (historyAnchor: number): TerminalViewportIntent => ({
  followBottom: false,
  historyAnchor,
});

test("a reader following the bottom is shown the host's own screen, unchanged", () => {
  const screen = screenModel(10);

  assert.equal(composeDisplayedScreen(screen, null, FOLLOWING), screen);
  assert.equal(requiredHistoryWindow(screen, FOLLOWING, null), null);
});

test("a view deep in history is history alone", () => {
  const screen = screenModel(10);

  assert.deepEqual(requiredHistoryWindow(screen, at(2), null), { startRow: 2, rows: 3 });
  const view = composeDisplayedScreen(screen, windowModel(2, 3, 10), at(2));
  assert.deepEqual(lines(view), ["history-2", "history-3", "history-4"]);
});

test("a view straddling the boundary is history above and the live screen below", () => {
  const screen = screenModel(10);

  assert.deepEqual(requiredHistoryWindow(screen, at(9), null), { startRow: 9, rows: 1 });
  const view = composeDisplayedScreen(screen, windowModel(9, 1, 10), at(9));
  assert.deepEqual(lines(view), ["history-9", "live-0", "live-1"]);
});

test("the cursor moves down with the live rows, and off the display with them", () => {
  const screen = screenModel(10, 1);

  const straddling = composeDisplayedScreen(screen, windowModel(9, 1, 10), at(9));
  assert.deepEqual(straddling?.cursor, {
    column: 0,
    row: 2,
    visible: true,
    pendingWrap: false,
  });

  const deeper = composeDisplayedScreen(screen, windowModel(7, 3, 10), at(7));
  assert.equal(deeper?.cursor.visible, false);
});

test("a composed view owes a full frame, because damage names the live viewport", () => {
  const screen = screenModel(10);

  const view = composeDisplayedScreen(screen, windowModel(2, 3, 10), at(2));
  assert.deepEqual(view?.damage, { scope: "full", rows: [] });
  // The live view keeps the host's own damage, which is what makes a partial
  // frame possible at the bottom.
  assert.deepEqual(composeDisplayedScreen(screen, null, FOLLOWING)?.damage, {
    scope: "partial",
    rows: [1],
  });
});

test("rows that are not held compose nothing rather than something", () => {
  const screen = screenModel(10);

  assert.equal(composeDisplayedScreen(screen, null, at(2)), null);
  assert.equal(composeDisplayedScreen(screen, windowModel(2, 2, 10), at(2)), null);
});

test("a window is composed by row number, whatever history held when it was read", () => {
  const screen = screenModel(10);
  // Read when history held nine rows. Whether those numbers still name these
  // lines is not answerable here — `historyRows` moves while retention grows
  // and stands still while it evicts — so this file uses the rows it was given
  // and the caller re-reads. See the note at the top of the module.
  const earlier = windowModel(2, 3, 9);

  assert.deepEqual(lines(composeDisplayedScreen(screen, earlier, at(2))), [
    "history-2",
    "history-3",
    "history-4",
  ]);
  assert.equal(requiredHistoryWindow(screen, at(2), earlier), null);
});

test("a wider window than the view needs is used rather than read again", () => {
  const screen = screenModel(10);

  assert.equal(requiredHistoryWindow(screen, at(3), windowModel(2, 6, 10)), null);
  assert.deepEqual(lines(composeDisplayedScreen(screen, windowModel(2, 6, 10), at(3))), [
    "history-3",
    "history-4",
    "history-5",
  ]);
});

test("an anchor eviction has passed is answered with the oldest row kept", () => {
  const screen = screenModel(10);

  assert.deepEqual(requiredHistoryWindow(screen, at(-4), null), { startRow: 0, rows: 3 });
});

test("an anchor past the end of history is the live screen", () => {
  const screen = screenModel(10);

  assert.equal(requiredHistoryWindow(screen, at(10), null), null);
  assert.deepEqual(lines(composeDisplayedScreen(screen, null, at(10))), [
    "live-0",
    "live-1",
    "live-2",
  ]);
});

test("a terminal with no history behind it cannot be scrolled back", () => {
  const screen = screenModel(0);

  assert.deepEqual(scrollViewportIntent(screen, FOLLOWING, -3), FOLLOWING);
  assert.equal(requiredHistoryWindow(screen, at(0), null), null);
});

test("scrolling up leaves the bottom, and scrolling back down returns to it", () => {
  const screen = screenModel(10);

  const up = scrollViewportIntent(screen, FOLLOWING, -1);
  assert.deepEqual(up, { followBottom: false, historyAnchor: 9 });

  const higher = scrollViewportIntent(screen, up, -4);
  assert.deepEqual(higher, { followBottom: false, historyAnchor: 5 });

  // Down past the newest history row is following the bottom again, which is a
  // state rather than a row: the child's next line keeps it there.
  assert.deepEqual(scrollViewportIntent(screen, higher, 5), FOLLOWING);
});

test("scrolling stops at the oldest row history holds", () => {
  const screen = screenModel(10);

  assert.deepEqual(scrollViewportIntent(screen, at(2), -9), {
    followBottom: false,
    historyAnchor: 0,
  });
});

test("a scroll of no lines changes nothing", () => {
  const screen = screenModel(10);

  assert.equal(scrollViewportIntent(screen, FOLLOWING, 0), FOLLOWING);
});
