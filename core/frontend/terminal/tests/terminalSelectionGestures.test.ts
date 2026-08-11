/**
 * What a pointer asks the host to select.
 *
 * Every trace here compares the whole request, because the host reads the whole
 * request: a `space` written as `"active"` rather than `"screen"` selects real
 * cells, just not the ones under the pointer, and a field-by-field check written
 * from the same misreading would pass.
 *
 * The cells are in the host's screen space — history and the active area
 * together — because that is what the caller projects a displayed cell into.
 * See `displayedCellInScreenSpace`.
 *
 * The gesture holds one thing — the anchor of a drag — so most traces are about
 * what it does *not* hold: no selection, no text, no idea which cells a word
 * covers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { TerminalModesModel } from "../terminalClientModel.ts";
import {
  TerminalSelectionGesture,
  terminalPointerAudience,
  type TerminalGesturePointerFacts,
} from "../terminalSelectionGestures.ts";

/** A pointer event, with the platform's own defaults for what is not stated. */
function pointer(
  type: string,
  facts: Partial<TerminalGesturePointerFacts> = {},
): TerminalGesturePointerFacts {
  return {
    type,
    button: 0,
    // The platform's count for a press that is not part of a multiple click.
    detail: 1,
    shiftKey: false,
    altKey: false,
    ...facts,
  };
}

function cell(row: number, column: number) {
  return { row, column };
}

function modes(overrides: Partial<TerminalModesModel> = {}): TerminalModesModel {
  return {
    wraparound: true,
    bracketedPaste: false,
    applicationCursorKeys: false,
    applicationKeypad: false,
    focusEvents: false,
    mouseTracking: false,
    insert: false,
    reverseVideo: false,
    origin: false,
    ...overrides,
  };
}

test("a press clears what was selected, and the drag that follows names the range", () => {
  const gesture = new TerminalSelectionGesture();

  assert.deepEqual(gesture.observe(pointer("pointerdown"), cell(4, 2)), { kind: "clear" });
  assert.deepEqual(gesture.observe(pointer("pointermove"), cell(6, 9)), {
    kind: "range",
    space: "screen",
    from: { column: 2, row: 4 },
    to: { column: 9, row: 6 },
    rectangle: false,
  });
});

test("a drag asks once per cell, not once per pixel", () => {
  const gesture = new TerminalSelectionGesture();
  gesture.observe(pointer("pointerdown"), cell(0, 0));

  assert.ok(gesture.observe(pointer("pointermove"), cell(1, 1)));
  assert.equal(gesture.observe(pointer("pointermove"), cell(1, 1)), null);
  assert.ok(gesture.observe(pointer("pointermove"), cell(1, 2)));
});

test("a move with no press behind it asks for nothing", () => {
  const gesture = new TerminalSelectionGesture();

  assert.equal(gesture.observe(pointer("pointermove"), cell(3, 3)), null);
});

test("a release ends the drag, and later movement is not part of it", () => {
  const gesture = new TerminalSelectionGesture();
  gesture.observe(pointer("pointerdown"), cell(0, 0));
  gesture.observe(pointer("pointermove"), cell(0, 5));

  assert.equal(gesture.observe(pointer("pointerup"), cell(0, 5)), null);
  assert.equal(gesture.observe(pointer("pointermove"), cell(9, 9)), null);
});

test("the platform's click count decides a word and a line", () => {
  const gesture = new TerminalSelectionGesture();

  assert.deepEqual(gesture.observe(pointer("pointerdown", { detail: 2 }), cell(2, 7)), {
    kind: "word",
    space: "screen",
    at: { row: 2, column: 7 },
  });
  assert.deepEqual(gesture.observe(pointer("pointerdown", { detail: 3 }), cell(2, 7)), {
    kind: "line",
    space: "screen",
    at: { row: 2, column: 7 },
  });
  // Nothing is asked for above a line, so a fourth click repeats the third
  // rather than answering nothing.
  assert.deepEqual(gesture.observe(pointer("pointerdown", { detail: 4 }), cell(2, 7)), {
    kind: "line",
    space: "screen",
    at: { row: 2, column: 7 },
  });
});

test("a word is not dragged into a wider word, because the host has no such request", () => {
  const gesture = new TerminalSelectionGesture();
  gesture.observe(pointer("pointerdown", { detail: 2 }), cell(2, 7));

  assert.equal(gesture.observe(pointer("pointermove"), cell(2, 20)), null);
});

test("shift moves the far edge and keeps the near one", () => {
  const gesture = new TerminalSelectionGesture();
  gesture.observe(pointer("pointerdown"), cell(1, 1));
  gesture.observe(pointer("pointerup"), cell(1, 1));

  assert.deepEqual(gesture.observe(pointer("pointerdown", { shiftKey: true }), cell(5, 5)), {
    kind: "range",
    space: "screen",
    from: { column: 1, row: 1 },
    to: { column: 5, row: 5 },
    rectangle: false,
  });
});

test("a shift press with nothing selected starts a selection rather than extending none", () => {
  const gesture = new TerminalSelectionGesture();

  assert.deepEqual(gesture.observe(pointer("pointerdown", { shiftKey: true }), cell(5, 5)), {
    kind: "clear",
  });
});

test("alt asks for a rectangle, and answers the key as it is held", () => {
  const gesture = new TerminalSelectionGesture();
  gesture.observe(pointer("pointerdown"), cell(0, 0));

  const held = gesture.observe(pointer("pointermove", { altKey: true }), cell(3, 3));
  assert.deepEqual(held, {
    kind: "range",
    space: "screen",
    from: { column: 0, row: 0 },
    to: { column: 3, row: 3 },
    rectangle: true,
  });
  const released = gesture.observe(pointer("pointermove"), cell(4, 4));
  assert.deepEqual(released, {
    kind: "range",
    space: "screen",
    from: { column: 0, row: 0 },
    to: { column: 4, row: 4 },
    rectangle: false,
  });
});

test("a pointer off the grid asks for nothing rather than for an edge", () => {
  const gesture = new TerminalSelectionGesture();

  assert.equal(gesture.observe(pointer("pointerdown"), null), null);
  gesture.observe(pointer("pointerdown"), cell(1, 1));
  assert.equal(gesture.observe(pointer("pointermove"), null), null);
});

test("a button that is not the primary one is not a selection", () => {
  const gesture = new TerminalSelectionGesture();

  assert.equal(gesture.observe(pointer("pointerdown", { button: 2 }), cell(1, 1)), null);
  assert.equal(gesture.observe(pointer("pointermove"), cell(2, 2)), null);
});

test("reset forgets the gesture without asking the host to clear anything", () => {
  const gesture = new TerminalSelectionGesture();
  gesture.observe(pointer("pointerdown"), cell(1, 1));

  gesture.reset();
  assert.equal(gesture.observe(pointer("pointermove"), cell(2, 2)), null);
  // The anchor went with it, so a shift press starts over rather than extending
  // from a cell the user last touched in another session.
  assert.deepEqual(gesture.observe(pointer("pointerdown", { shiftKey: true }), cell(3, 3)), {
    kind: "clear",
  });
});

test("a child that asked for the mouse gets it, and shift takes it back", () => {
  assert.equal(terminalPointerAudience(modes(), { shiftKey: false }), "selection");
  assert.equal(
    terminalPointerAudience(modes({ mouseTracking: true }), { shiftKey: false }),
    "child",
  );
  assert.equal(
    terminalPointerAudience(modes({ mouseTracking: true }), { shiftKey: true }),
    "selection",
  );
});
