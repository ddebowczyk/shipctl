/**
 * What a cell opens, and what a link covers.
 *
 * The screens below are built from the client model's own row and cell shapes,
 * so a renamed field fails here. Each trace is one thing a hover or a click has
 * to get right, and the run is compared whole: a run one cell short underlines
 * text that is part of the link, and a run one cell long underlines text that
 * is not.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  TerminalCellModel,
  TerminalRowModel,
  TerminalScreenModel,
} from "../terminalClientModel.ts";
import { terminalLinkAt } from "../terminalLinkTargets.ts";

function cell(text: string, hyperlink: string | null = null): TerminalCellModel {
  return {
    text,
    width: "narrow",
    bold: false,
    foreground: null,
    background: null,
    selected: false,
    hyperlink,
  };
}

/** One row: text, and the URI on each column, blank for none. */
function row(
  text: string,
  links: readonly (string | null)[],
  flags: { wrapped?: boolean; continuation?: boolean } = {},
): TerminalRowModel {
  return {
    wrapped: flags.wrapped ?? false,
    continuation: flags.continuation ?? false,
    prompt: "none",
    cells: [...text].map((character, column) => cell(character, links[column] ?? null)),
  };
}

function screen(rows: readonly TerminalRowModel[]): TerminalScreenModel {
  return {
    columns: rows[0]?.cells.length ?? 0,
    rows: rows.length,
    viewport: rows,
    cursor: { column: 0, row: 0, visible: true, pendingWrap: false },
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
    damage: { scope: "full", rows: [] },
    screen: "primary",
    scrollbackRows: 0,
  };
}

const HOME = "https://example.test/";
const OTHER = "https://example.test/other";

test("a cell with no hyperlink opens nothing", () => {
  const state = screen([row("plain", [])]);

  assert.equal(terminalLinkAt(state, { row: 0, column: 2 }), null);
});

test("a link answers its URI and every cell of its run", () => {
  const state = screen([row("go here", [null, null, null, HOME, HOME, HOME, HOME])]);

  assert.deepEqual(terminalLinkAt(state, { row: 0, column: 5 }), {
    uri: HOME,
    cells: [
      { row: 0, column: 3 },
      { row: 0, column: 4 },
      { row: 0, column: 5 },
      { row: 0, column: 6 },
    ],
  });
});

test("two links to different places, side by side, stay two links", () => {
  const state = screen([row("ab", [HOME, OTHER])]);

  assert.deepEqual(terminalLinkAt(state, { row: 0, column: 0 }), {
    uri: HOME,
    cells: [{ row: 0, column: 0 }],
  });
  assert.deepEqual(terminalLinkAt(state, { row: 0, column: 1 }), {
    uri: OTHER,
    cells: [{ row: 0, column: 1 }],
  });
});

test("a link that wrapped is one link, because the host says the row wrapped", () => {
  const state = screen([
    row("ab", [HOME, HOME], { wrapped: true }),
    row("cd", [HOME, null], { continuation: true }),
  ]);

  assert.deepEqual(terminalLinkAt(state, { row: 1, column: 0 }), {
    uri: HOME,
    cells: [
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 1, column: 0 },
    ],
  });
});

test("the same address on two unwrapped rows is two links", () => {
  const state = screen([row("ab", [HOME, HOME]), row("cd", [HOME, HOME])]);

  assert.deepEqual(terminalLinkAt(state, { row: 0, column: 1 }), {
    uri: HOME,
    cells: [
      { row: 0, column: 0 },
      { row: 0, column: 1 },
    ],
  });
});

test("a run stops at the edge of the viewport rather than reading past it", () => {
  const state = screen([row("ab", [HOME, HOME], { wrapped: true })]);

  assert.deepEqual(terminalLinkAt(state, { row: 0, column: 1 }), {
    uri: HOME,
    cells: [
      { row: 0, column: 0 },
      { row: 0, column: 1 },
    ],
  });
});

test("a cell that is not on the screen opens nothing", () => {
  const state = screen([row("ab", [HOME, HOME])]);

  assert.equal(terminalLinkAt(state, { row: 9, column: 0 }), null);
  assert.equal(terminalLinkAt(state, { row: 0, column: 9 }), null);
});

test("a URL written as plain text is not a link, because the host marked no cell", () => {
  const state = screen([row("https://example.test/", [])]);

  assert.equal(terminalLinkAt(state, { row: 0, column: 4 }), null);
});
