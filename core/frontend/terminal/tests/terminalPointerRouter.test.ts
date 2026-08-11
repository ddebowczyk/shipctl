/**
 * Who gets the pointer.
 *
 * Each trace records what the three destinations — the child, the host's
 * selection, and a link — received from one sequence of events. The traces
 * compare all three every time, because the fault worth catching is not a
 * missing action but the same action arriving twice: a click that both selects
 * and is reported to a child is how a terminal loses a selection the moment it
 * makes one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { TerminalCellModel, TerminalScreenModel } from "../terminalClientModel.ts";
import {
  createTerminalPointerRouter,
  type TerminalRouterPointerEvent,
  type TerminalWheelFacts,
} from "../terminalPointerRouter.ts";
import type { TerminalInput } from "../terminalSemanticInput.ts";
import type { TerminalSelectionRequest } from "../types.ts";

/** One cell wide, one cell high, so a point is its own coordinates. */
const METRICS = { cellWidth: 1, cellHeight: 1 };

const GEOMETRY = {
  screenWidth: 4,
  screenHeight: 2,
  cellWidth: 1,
  cellHeight: 1,
  paddingTop: 0,
  paddingBottom: 0,
  paddingLeft: 0,
  paddingRight: 0,
};

const LINK = "https://example.test/";

function cell(text: string, hyperlink: string | null): TerminalCellModel {
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

/**
 * Two rows of four columns. The second column of the first row is a link, so a
 * click that lands on it and a click that misses it are one cell apart.
 */
function screenModel(mouseTracking: boolean): TerminalScreenModel {
  const linked = ["a", "b", "c", "d"].map((text, column) =>
    cell(text, column === 1 ? LINK : null),
  );
  const plain = ["e", "f", "g", "h"].map((text) => cell(text, null));
  return {
    columns: 4,
    rows: 2,
    screen: "primary",
    scrollbackRows: 0,
    cursor: { column: 0, row: 0, visible: true, pendingWrap: false },
    modes: {
      wraparound: true,
      bracketedPaste: false,
      applicationCursorKeys: false,
      applicationKeypad: false,
      focusEvents: false,
      mouseTracking,
      insert: false,
      reverseVideo: false,
      origin: false,
    },
    colors: { foreground: null, background: null, palette: [] },
    damage: { scope: "full", rows: [] },
    viewport: [
      { wrapped: false, continuation: false, prompt: "none", cells: linked },
      { wrapped: false, continuation: false, prompt: "none", cells: plain },
    ],
  };
}

function event(
  type: string,
  facts: Partial<TerminalRouterPointerEvent> = {},
): TerminalRouterPointerEvent {
  return {
    type,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    detail: 1,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    getModifierState: () => false,
    ...facts,
  };
}

function router(
  options: {
    mouseTracking?: boolean;
    screen?: boolean;
    measurable?: boolean;
    /**
     * The first displayed row, in the host's screen space. Zero is a reader at
     * the bottom of a terminal with no history; a larger number is a reader
     * looking at rows the host knows by other numbers than the display does.
     */
    top?: number;
  } = {},
) {
  const inputs: TerminalInput[] = [];
  const selections: TerminalSelectionRequest[] = [];
  const opened: string[] = [];
  const scrolled: number[] = [];
  const state = options.screen === false ? null : screenModel(options.mouseTracking ?? false);
  /** Whether the display can be composed now, as history rows arriving change. */
  let composable = true;
  /** The step the router is waiting a frame for, if any. */
  let pending: (() => void) | null = null;
  return {
    inputs,
    selections,
    opened,
    scrolled,
    /** Draw one frame, which is what a held drag is waiting for. */
    frame() {
      const step = pending;
      pending = null;
      step?.();
    },
    /** Whether a frame is still owed, which is whether autoscroll is running. */
    waiting: () => pending !== null,
    /** Take the display away, as unheld history rows do, and give it back. */
    setComposable: (value: boolean) => {
      composable = value;
    },
    router: createTerminalPointerRouter({
      screen: () => state,
      // What is displayed. This harness paints the rows it has, so the two are
      // the same screen; what differs is the number the host knows a row by.
      displayed: () => (composable ? state : null),
      project: (cell) => ({ column: cell.column, row: (options.top ?? 0) + cell.row }),
      metrics: () => (options.measurable === false ? null : METRICS),
      geometry: () => GEOMETRY,
      reportInput: (input) => inputs.push(input),
      select: (request) => selections.push(request),
      openLink: (uri) => opened.push(uri),
      scroll: (rows) => scrolled.push(rows),
      schedule: (step) => {
        pending = step;
        return () => {
          if (pending === step) pending = null;
        };
      },
    }),
  };
}

/** A point past the bottom of the two-row display, by `rows` rows. */
function belowBy(rows: number) {
  return { x: 0.5, y: 2 + rows };
}

/** `WheelEvent.DOM_DELTA_*`, as the platform numbers them. */
const PIXELS = 0;
const LINES = 1;
const PAGES = 2;

/** A wheel event, with both axes and the modifiers a real one carries. */
function wheelEvent(facts: Partial<TerminalWheelFacts> = {}): TerminalWheelFacts {
  return {
    deltaX: 0,
    deltaY: 0,
    deltaMode: PIXELS,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    getModifierState: () => false,
    ...facts,
  };
}

/** Where the wheel turned. A child that asked for the mouse is told. */
const WHEEL_POINT = { x: 2.5, y: 0.5 };

/** The middle of the cell at this address, in surface pixels. */
function pointAt(row: number, column: number) {
  return { x: column + 0.5, y: row + 0.5 };
}

test("a child that asked for the mouse gets the pointer, and the host is not asked to select", () => {
  const { router: route, inputs, selections, opened } = router({ mouseTracking: true });

  route.handle(event("pointerdown"), pointAt(0, 1));
  route.handle(event("pointerup"), pointAt(0, 1));

  assert.deepEqual(inputs.map((input) => input.kind), ["mouse", "mouse"]);
  assert.deepEqual(selections, []);
  // Not even the link under the click: the child asked for that button.
  assert.deepEqual(opened, []);
});

test("shift takes the pointer back from the child", () => {
  const { router: route, inputs, selections } = router({ mouseTracking: true });

  route.handle(event("pointerdown", { shiftKey: true }), pointAt(0, 0));

  assert.deepEqual(inputs, []);
  assert.deepEqual(selections, [{ kind: "clear" }]);
});

test("a drag asks the host to select, and the child hears nothing", () => {
  const { router: route, inputs, selections } = router();

  route.handle(event("pointerdown"), pointAt(0, 0));
  route.handle(event("pointermove"), pointAt(1, 3));
  route.handle(event("pointerup"), pointAt(1, 3));

  assert.deepEqual(inputs, []);
  assert.deepEqual(selections, [
    { kind: "clear" },
    {
      kind: "range",
      space: "screen",
      from: { column: 0, row: 0 },
      to: { column: 3, row: 1 },
      rectangle: false,
    },
  ]);
});

test("a drag by a reader scrolled back names the rows the host knows", () => {
  // The reader is looking at history: what they see as row zero is row twelve
  // of the terminal as a whole. The host is told about the rows they touched,
  // not about the distance down a screen they are not looking at.
  const { router: route, selections } = router({ top: 12 });

  route.handle(event("pointerdown"), pointAt(0, 0));
  route.handle(event("pointermove"), pointAt(1, 3));
  route.handle(event("pointerup"), pointAt(1, 3));

  assert.deepEqual(selections, [
    { kind: "clear" },
    {
      kind: "range",
      space: "screen",
      from: { column: 0, row: 12 },
      to: { column: 3, row: 13 },
      rectangle: false,
    },
  ]);
});

test("a drag held past the bottom keeps reading, one row per frame it earned", () => {
  const drag = router();

  drag.router.handle(event("pointerdown"), pointAt(0, 0));
  drag.router.handle(event("pointermove"), belowBy(1.5));

  // Nothing moves on the event itself: the pointer is held, and how long it is
  // held is what decides how far the reading goes.
  assert.deepEqual(drag.scrolled, []);

  drag.frame();
  // One and a half rows earned, one spent, and the half is kept — so the second
  // frame spends two. A pointer twice as far past the edge reads twice as fast,
  // which is the whole of the rate rule.
  assert.deepEqual(drag.scrolled, [1]);
  drag.frame();
  assert.deepEqual(drag.scrolled, [1, 2]);

  assert.deepEqual(drag.selections, [
    { kind: "clear" },
    { kind: "extend", movement: "down" },
    { kind: "extend", movement: "down" },
    { kind: "extend", movement: "down" },
  ]);
});

test("a drag held past the top reads older output", () => {
  const drag = router();

  drag.router.handle(event("pointerdown"), pointAt(1, 0));
  drag.router.handle(event("pointermove"), { x: 0.5, y: -1 });
  drag.frame();

  assert.deepEqual(drag.scrolled, [-1]);
  assert.deepEqual(drag.selections, [{ kind: "clear" }, { kind: "extend", movement: "up" }]);
});

test("a drag that comes back inside stops reading and names cells again", () => {
  const drag = router();

  drag.router.handle(event("pointerdown"), pointAt(0, 0));
  drag.router.handle(event("pointermove"), belowBy(1));
  drag.frame();
  drag.router.handle(event("pointermove"), pointAt(1, 2));

  assert.equal(drag.waiting(), false);
  assert.deepEqual(drag.scrolled, [1]);
  assert.deepEqual(drag.selections.at(-1), {
    kind: "range",
    space: "screen",
    from: { column: 0, row: 0 },
    to: { column: 2, row: 1 },
    rectangle: false,
  });
});

test("releasing the drag stops reading, and a later frame reads nothing", () => {
  const drag = router();

  drag.router.handle(event("pointerdown"), pointAt(0, 0));
  drag.router.handle(event("pointermove"), belowBy(1));
  drag.router.handle(event("pointerup"), belowBy(1));

  assert.equal(drag.waiting(), false);
  drag.frame();
  assert.deepEqual(drag.scrolled, []);
});

test("a display that cannot be composed yet is waited for, not treated as the end", () => {
  // The rows the last scroll needs have not arrived. The pointer has not moved,
  // so ending here would leave a held drag stopped with nothing to restart it.
  const drag = router();

  drag.router.handle(event("pointerdown"), pointAt(0, 0));
  drag.router.handle(event("pointermove"), belowBy(1));
  drag.frame();
  assert.deepEqual(drag.scrolled, [1]);

  drag.setComposable(false);
  drag.frame();
  assert.deepEqual(drag.scrolled, [1]);
  assert.equal(drag.waiting(), true);

  drag.setComposable(true);
  drag.frame();
  assert.deepEqual(drag.scrolled, [1, 1]);
});

test("a word press dragged past the edge extends nothing", () => {
  // A double click asked for a word, and the host holds one. Reading on would
  // extend a selection this gesture never claimed.
  const drag = router();

  drag.router.handle(event("pointerdown", { detail: 2 }), pointAt(0, 0));
  drag.router.handle(event("pointermove"), belowBy(1));

  assert.equal(drag.waiting(), false);
  assert.deepEqual(drag.scrolled, []);
  assert.deepEqual(drag.selections, [{ kind: "word", space: "screen", at: { column: 0, row: 0 } }]);
});

test("a click on a linked cell opens it", () => {
  const { router: route, opened } = router();

  route.handle(event("pointerdown"), pointAt(0, 1));
  route.handle(event("pointerup"), pointAt(0, 1));

  assert.deepEqual(opened, [LINK]);
});

test("a click beside the link opens nothing", () => {
  const { router: route, opened } = router();

  route.handle(event("pointerdown"), pointAt(0, 2));
  route.handle(event("pointerup"), pointAt(0, 2));

  assert.deepEqual(opened, []);
});

test("a drag that ends where it started is still a drag, and opens nothing", () => {
  const { router: route, opened, selections } = router();

  route.handle(event("pointerdown"), pointAt(0, 1));
  route.handle(event("pointermove"), pointAt(1, 3));
  route.handle(event("pointermove"), pointAt(0, 1));
  route.handle(event("pointerup"), pointAt(0, 1));

  assert.deepEqual(opened, []);
  assert.equal(selections.length, 3);
});

test("a release on a different cell than the press opens nothing", () => {
  const { router: route, opened } = router();

  route.handle(event("pointerdown"), pointAt(0, 1));
  route.handle(event("pointerup"), pointAt(0, 3));

  assert.deepEqual(opened, []);
});

test("a pointer before the first frame reaches nobody", () => {
  const { router: route, inputs, selections, opened } = router({ screen: false });

  route.handle(event("pointerdown"), pointAt(0, 1));
  route.handle(event("pointerup"), pointAt(0, 1));

  assert.deepEqual(inputs, []);
  assert.deepEqual(selections, []);
  assert.deepEqual(opened, []);
});

test("a wheel is read in the unit the platform reported", () => {
  const lines = router();
  lines.router.wheel(wheelEvent({ deltaY: -3, deltaMode: LINES }), WHEEL_POINT);
  assert.deepEqual(lines.scrolled, [-3]);

  // One cell is one pixel high in this harness, so pixels are rows.
  const pixels = router();
  pixels.router.wheel(wheelEvent({ deltaY: 4, deltaMode: PIXELS }), WHEEL_POINT);
  assert.deepEqual(pixels.scrolled, [4]);

  // Two rows of screen, so a page is two rows.
  const pages = router();
  pages.router.wheel(wheelEvent({ deltaY: -1, deltaMode: PAGES }), WHEEL_POINT);
  assert.deepEqual(pages.scrolled, [-2]);
});

test("a fraction of a row is kept until it is a row", () => {
  const { router: route, scrolled } = router();
  const metrics = wheelEvent({ deltaY: 0.4, deltaMode: PIXELS });

  route.wheel(metrics, WHEEL_POINT);
  route.wheel(metrics, WHEEL_POINT);
  assert.deepEqual(scrolled, [], "under a row is not a scroll");

  route.wheel(metrics, WHEEL_POINT);
  assert.deepEqual(scrolled, [1], "and the fourth tenth of a row is not lost");
});

test("a wheel over a child that asked for the mouse reaches the child", () => {
  const { router: route, scrolled, inputs } = router({ mouseTracking: true });

  route.wheel(wheelEvent({ deltaY: -3, deltaMode: LINES }), WHEEL_POINT);

  assert.deepEqual(scrolled, [], "the child's own view is not this client's to move");
  // Three steps up, at the cell the pointer was over, with nothing held.
  assert.equal(inputs.length, 3);
  assert.deepEqual(inputs[0], {
    kind: "mouse",
    action: "press",
    button: "four",
    mods: {
      shift: false,
      alt: false,
      ctrl: false,
      meta: false,
      capsLock: false,
      numLock: false,
    },
    x: WHEEL_POINT.x,
    y: WHEEL_POINT.y,
    surface: GEOMETRY,
    anyButtonPressed: false,
  });
  assert.deepEqual(
    inputs.map((input) => (input.kind === "mouse" ? input.button : null)),
    ["four", "four", "four"],
    "one press per step, because a child counting them counts the turn",
  );
});

test("the wheel a child receives is turned down as well as up, and sideways", () => {
  const { router: route, inputs } = router({ mouseTracking: true });

  route.wheel(wheelEvent({ deltaY: 1, deltaMode: LINES }), WHEEL_POINT);
  route.wheel(wheelEvent({ deltaX: 1, deltaMode: LINES }), WHEEL_POINT);
  route.wheel(wheelEvent({ deltaX: -1, deltaMode: LINES }), WHEEL_POINT);

  assert.deepEqual(
    inputs.map((input) => (input.kind === "mouse" ? input.button : null)),
    ["five", "seven", "six"],
    "down, right, left — the buttons the host's encoder names",
  );
});

test("shift reaches past a child that asked for the mouse, as it does for a selection", () => {
  const { router: route, scrolled, inputs } = router({ mouseTracking: true });

  route.wheel(wheelEvent({ deltaY: -2, deltaMode: LINES, shiftKey: true }), WHEEL_POINT);

  assert.deepEqual(scrolled, [-2], "a person can always read what scrolled past");
  assert.deepEqual(inputs, []);
});

test("a fraction of a step is kept for the child too", () => {
  const { router: route, inputs } = router({ mouseTracking: true });
  // One cell is one pixel high here, so four tenths of a pixel is four tenths
  // of a step.
  const slow = wheelEvent({ deltaY: 0.4, deltaMode: PIXELS });

  route.wheel(slow, WHEEL_POINT);
  route.wheel(slow, WHEEL_POINT);
  assert.deepEqual(inputs, [], "a trackpad under a step reports nothing yet");

  route.wheel(slow, WHEEL_POINT);
  assert.equal(inputs.length, 1, "and the step it adds up to is not lost");
});

test("a wheel the child cannot be told about is not turned into a scroll instead", () => {
  // No measured cell, so pixels have no answer. The child asked for the wheel,
  // so moving this client's own view instead would be answering a different
  // question.
  const { router: route, scrolled, inputs } = router({ mouseTracking: true, measurable: false });

  route.wheel(wheelEvent({ deltaY: -40, deltaMode: PIXELS }), WHEEL_POINT);

  assert.deepEqual(inputs, []);
  assert.deepEqual(scrolled, []);
});

test("a wheel in pixels with an unmeasurable font scrolls nothing", () => {
  const { router: route, scrolled } = router({ measurable: false });

  route.wheel(wheelEvent({ deltaY: -40, deltaMode: PIXELS }), WHEEL_POINT);

  assert.deepEqual(scrolled, []);
});

test("a wheel in a unit this client does not know is not guessed at", () => {
  const { router: route, scrolled } = router();

  route.wheel(wheelEvent({ deltaY: -3, deltaMode: 99 }), WHEEL_POINT);

  assert.deepEqual(scrolled, []);
});

test("reset forgets the press, so the release that follows opens nothing", () => {
  const { router: route, opened } = router();

  route.handle(event("pointerdown"), pointAt(0, 1));
  route.reset();
  route.handle(event("pointerup"), pointAt(0, 1));

  assert.deepEqual(opened, []);
});
