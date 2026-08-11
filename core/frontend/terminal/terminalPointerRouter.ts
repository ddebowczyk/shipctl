/**
 * Where one pointer event goes.
 *
 * Three destinations share the pointer, and which one gets an event is decided
 * from host facts rather than from a client's idea of a terminal:
 *
 * - **The child**, when it asked for the mouse (`modes.mouseTracking`) and
 *   shift is not held. It gets the event as meaning, through
 *   `semanticMouseInput`.
 * - **A link**, when a click begins and ends on one cell that the host marked
 *   with an OSC 8 hyperlink. The legacy surface opened those on a click, and
 *   this keeps that.
 * - **The host's selection**, for everything else, through
 *   `TerminalSelectionGesture`.
 *
 * The router holds no selection and no link state beyond the press it is in the
 * middle of, because a press that has not been released is the only thing that
 * spans two events. A drag held past the edge of the display is the one place
 * where that press does something on its own: it keeps moving the reading
 * position and asks the host to extend, once per row, until it is released.
 */

import {
  hitTestTerminalCell,
  type TerminalCellAddress,
  type TerminalCellMetrics,
  type TerminalSurfacePoint,
} from "./terminalCellPaint.ts";
import type { TerminalScreenModel } from "./terminalClientModel.ts";
import { terminalLinkAt } from "./terminalLinkTargets.ts";
import {
  TerminalSelectionGesture,
  terminalPointerAudience,
  type TerminalGesturePointerFacts,
} from "./terminalSelectionGestures.ts";
import {
  semanticMouseInput,
  semanticWheelInput,
  type TerminalInput,
  type TerminalModifierFacts,
  type TerminalPointerEventFacts,
  type TerminalSurfaceGeometry,
  type TerminalWheelDirection,
} from "./terminalSemanticInput.ts";
import type {
  TerminalProjectedPoint,
  TerminalSelectionMove,
  TerminalSelectionRequest,
} from "./types.ts";

/** A pointer event, as both the child's encoder and the gesture read it. */
export type TerminalRouterPointerEvent = TerminalPointerEventFacts & TerminalGesturePointerFacts;

export interface TerminalPointerRouterPorts {
  /** The host's current screen, or null before the first frame. */
  screen(): TerminalScreenModel | null;
  /**
   * What is displayed — history above the live screen when the reader scrolled
   * back — or null while those rows are not held.
   *
   * The pointer addresses this and not the host's own viewport. A reader
   * scrolled back is pointing at the rows in front of them, and a hit test
   * against the live screen would answer with the cell that happens to be at
   * the same distance down a screen they are not looking at.
   */
  displayed(): TerminalScreenModel | null;
  /**
   * A displayed cell, in the host's screen space. `displayedCellInScreenSpace`
   * is the answer; it is a port so the router holds no viewport intent.
   */
  project(cell: TerminalCellAddress): TerminalProjectedPoint;
  /** The pixel size of one cell, or null while the font cannot be measured. */
  metrics(): TerminalCellMetrics | null;
  /** How this client drew the terminal, for the child's own mouse reports. */
  geometry(): TerminalSurfaceGeometry | null;
  /** Send meaning to the child. */
  reportInput(input: TerminalInput): void;
  /** Ask the host to select. The answer is the host's to publish. */
  select(request: TerminalSelectionRequest): void;
  /** Open what a hyperlink names. */
  openLink(uri: string): void;
  /** Move the reading position by whole rows, negative for older output. */
  scroll(rows: number): void;
  /**
   * Run `step` once, the next time this client draws. Answers with a cancel.
   *
   * A drag held past the edge of the display keeps moving the reading position
   * while nothing else happens, and that needs a clock this router does not
   * have. The caller's clock is the surface's own paint cadence, which is the
   * rate the rows would appear at in any case.
   */
  schedule(step: () => void): () => void;
}

/**
 * The part of a wheel event this router reads.
 *
 * `deltaMode` is the platform's own unit for the deltas, and it is read rather
 * than assumed: a system that reports lines is reporting the user's line, and
 * one that reports pixels is reporting pixels of the surface those lines are
 * drawn on. The modifiers are here because a wheel the child receives carries
 * them, and because shift is what a person holds to reach past the child.
 */
export interface TerminalWheelFacts extends TerminalModifierFacts {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
}

/** `WheelEvent.DOM_DELTA_*`, which are the units `deltaMode` names. */
const DELTA_PIXEL = 0;
const DELTA_LINE = 1;
const DELTA_PAGE = 2;

export interface TerminalPointerRouter {
  /** Route one event. `point` is in the surface's own pixels. */
  handle(event: TerminalRouterPointerEvent, point: TerminalSurfacePoint): void;
  /**
   * Route one wheel event. `point` is in the surface's own pixels.
   *
   * A child that asked for the mouse receives it as the wheel buttons, one
   * press per step. Everything else moves this client's reading position.
   */
  wheel(event: TerminalWheelFacts, point: TerminalSurfacePoint): void;
  /** Forget the press in progress. The host's selection is untouched. */
  reset(): void;
}

export function createTerminalPointerRouter(
  ports: TerminalPointerRouterPorts,
): TerminalPointerRouter {
  const gesture = new TerminalSelectionGesture();
  /** The cell a press went down on, while it is still down. */
  let pressed: TerminalCellAddress | null = null;
  /** True once a press has moved off its own cell, which makes it a drag. */
  let dragged = false;
  /** The fraction of a row a wheel has reported and not yet spent. */
  let residue = 0;
  /** The same, for the wheel the child receives, in rows and in columns. */
  let childRows = 0;
  let childColumns = 0;
  /** Where a held pointer is now, in surface pixels, while a drag is held. */
  let heldAt: TerminalSurfacePoint | null = null;
  /** Cancel the frame autoscroll waits for, or null while it is not running. */
  let stopAutoscroll: (() => void) | null = null;
  /** The fraction of a row the overshoot has earned and not yet spent. */
  let overshoot = 0;

  const cellUnder = (point: TerminalSurfacePoint): TerminalCellAddress | null => {
    const displayed = ports.displayed();
    const metrics = ports.metrics();
    if (!displayed || !metrics) return null;
    return hitTestTerminalCell(point, displayed, metrics);
  };

  const toChild = (event: TerminalRouterPointerEvent, point: TerminalSurfacePoint): void => {
    const geometry = ports.geometry();
    if (!geometry) return;
    const input = semanticMouseInput(event, point, geometry);
    if (input) ports.reportInput(input);
  };

  const openIfLink = (cell: TerminalCellAddress): void => {
    // The row the reader clicked, which is the row they can see. A history row
    // carries its own OSC 8 links, and they are the ones under the pointer.
    const displayed = ports.displayed();
    if (!displayed) return;
    const link = terminalLinkAt(displayed, cell);
    if (link) ports.openLink(link.uri);
  };

  /**
   * How far past the display a pointer is, in rows, negative above it.
   *
   * Zero is a pointer on the display. Null is a display that cannot be read —
   * no frame, no held history rows, an unmeasurable font — which is not the
   * same answer: a drag over it has not come back inside, it is waiting.
   *
   * The rate comes from here and is not chosen: a pointer one cell past the
   * edge is one row past it, and the rows are spent at the caller's frame. A
   * number of rows per second would be this file inventing a speed.
   */
  const overshootRows = (point: TerminalSurfacePoint): number | null => {
    const displayed = ports.displayed();
    const metrics = ports.metrics();
    if (!displayed || !metrics || metrics.cellHeight <= 0) return null;
    if (point.y < 0) return point.y / metrics.cellHeight;
    const bottom = displayed.rows * metrics.cellHeight;
    if (point.y > bottom) return (point.y - bottom) / metrics.cellHeight;
    return 0;
  };

  const endAutoscroll = (): void => {
    stopAutoscroll?.();
    stopAutoscroll = null;
    heldAt = null;
    overshoot = 0;
  };

  const autoscrollStep = (): void => {
    stopAutoscroll = null;
    if (!heldAt) return;
    const rows = overshootRows(heldAt);
    // The display cannot be read this frame — most often the history rows the
    // last scroll needs have not arrived. The drag has not ended, so the next
    // frame is waited for rather than treated as a pointer back inside.
    if (rows !== null) {
      if (rows === 0) {
        endAutoscroll();
        return;
      }
      overshoot += rows;
      const whole = Math.trunc(overshoot);
      overshoot -= whole;
      if (whole !== 0) {
        ports.scroll(whole);
        // The far edge follows the rows that arrive, one row at a time. The
        // request names no cell because there is no cell under a pointer that
        // left the display, and where the edge lands is the host's answer.
        const movement: TerminalSelectionMove = whole < 0 ? "up" : "down";
        for (let step = 0; step < Math.abs(whole); step += 1) {
          ports.select({ kind: "extend", movement });
        }
      }
    }
    stopAutoscroll = ports.schedule(autoscrollStep);
  };

  /** Start, continue or end the autoscroll a held drag asks for. */
  const followEdge = (point: TerminalSurfacePoint): void => {
    const rows = overshootRows(point);
    if (rows === null || rows === 0) {
      endAutoscroll();
      return;
    }
    heldAt = point;
    if (!stopAutoscroll) stopAutoscroll = ports.schedule(autoscrollStep);
  };

  return {
    handle(event, point) {
      const screen = ports.screen();
      // Before the first frame there is no screen, so there is no cell under
      // the pointer and nothing the host could be asked about.
      if (!screen) return;

      if (terminalPointerAudience(screen.modes, event) === "child") {
        gesture.reset();
        pressed = null;
        dragged = false;
        endAutoscroll();
        toChild(event, point);
        return;
      }

      const cell = cellUnder(point);

      if (event.type === "pointerdown" || event.type === "mousedown") {
        pressed = cell;
        dragged = false;
      } else if (
        pressed
        && cell
        && (event.type === "pointermove" || event.type === "mousemove")
        && (cell.row !== pressed.row || cell.column !== pressed.column)
      ) {
        dragged = true;
      }

      // The gesture speaks the host's coordinates, so what it holds across a
      // drag stays valid as the reader scrolls: a row named in screen space is
      // the same row whether it is displayed or not.
      const request = gesture.observe(event, cell ? ports.project(cell) : null);
      if (request) ports.select(request);

      // A drag held past the edge keeps reading. Only a drag: a word press or a
      // secondary button has no edge to move, which is what the gesture's own
      // answer says.
      if (gesture.dragging && (event.type === "pointermove" || event.type === "mousemove")) {
        followEdge(point);
      } else if (!gesture.dragging) {
        endAutoscroll();
      }

      if (event.type === "pointerup" || event.type === "mouseup") {
        // A click, not a drag: the press and the release are the same cell and
        // nothing in between left it. A drag that ends on its own cell is still
        // a drag, which is why the move is recorded rather than inferred here.
        if (!dragged && pressed && cell && cell.row === pressed.row && cell.column === pressed.column) {
          openIfLink(cell);
        }
        pressed = null;
        dragged = false;
      }
    },

    wheel(event, point) {
      const screen = ports.screen();
      if (!screen) return;
      // The child asked for the mouse, and the wheel is part of what it asked
      // for. Shift is how a person reaches past it, the same way it reaches
      // past mouse tracking for a selection.
      if (screen.modes.mouseTracking && !event.shiftKey) {
        wheelToChild(event, point, screen);
        return;
      }

      const rows = wheelSteps(event.deltaY, event, screen.rows, ports.metrics()?.cellHeight);
      if (rows === null) return;
      // A device that reports fractions of a row — a trackpad, most often —
      // keeps the fraction until it becomes a row, so a slow scroll moves the
      // view rather than being rounded away.
      residue += rows;
      const whole = Math.trunc(residue);
      residue -= whole;
      if (whole !== 0) ports.scroll(whole);
    },

    reset() {
      gesture.reset();
      pressed = null;
      dragged = false;
      endAutoscroll();
      residue = 0;
      childRows = 0;
      childColumns = 0;
    },
  };

  /**
   * The wheel, as the child asked to receive it.
   *
   * One press per step, in the order the steps happened, because a child
   * counting them is counting how far the wheel turned. A device that reports
   * fractions keeps the fraction, so a slow trackpad scroll reaches the child
   * as whole steps rather than as nothing.
   */
  function wheelToChild(
    event: TerminalWheelFacts,
    point: TerminalSurfacePoint,
    screen: TerminalScreenModel,
  ): void {
    const geometry = ports.geometry();
    if (!geometry) return;
    const metrics = ports.metrics();

    const down = wheelSteps(event.deltaY, event, screen.rows, metrics?.cellHeight);
    if (down !== null) {
      childRows += down;
      const whole = Math.trunc(childRows);
      childRows -= whole;
      report(whole > 0 ? "down" : "up", Math.abs(whole), event, point, geometry);
    }

    const right = wheelSteps(event.deltaX, event, screen.columns, metrics?.cellWidth);
    if (right !== null) {
      childColumns += right;
      const whole = Math.trunc(childColumns);
      childColumns -= whole;
      report(whole > 0 ? "right" : "left", Math.abs(whole), event, point, geometry);
    }
  }

  function report(
    direction: TerminalWheelDirection,
    steps: number,
    event: TerminalModifierFacts,
    point: TerminalSurfacePoint,
    geometry: TerminalSurfaceGeometry,
  ): void {
    for (let step = 0; step < steps; step += 1) {
      ports.reportInput(semanticWheelInput(direction, event, point, geometry));
    }
  }
}

/**
 * One wheel delta as whole cells and a fraction, or null when it cannot be
 * read.
 *
 * Pixels need a measured cell to become cells; a font that cannot be measured
 * has no answer, and a scroll of an invented distance is worse than none. A
 * page is however many cells the screen shows along that axis.
 */
function wheelSteps(
  delta: number,
  event: TerminalWheelFacts,
  screenCells: number,
  cellSize: number | undefined,
): number | null {
  switch (event.deltaMode) {
    case DELTA_LINE:
      return delta;
    case DELTA_PAGE:
      return delta * screenCells;
    case DELTA_PIXEL:
      if (cellSize === undefined || cellSize <= 0) return null;
      return delta / cellSize;
    default:
      // A unit this client does not know is not guessed at.
      return null;
  }
}
