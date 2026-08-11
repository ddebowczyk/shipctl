/**
 * Pointer gestures, as selection requests.
 *
 * Selection is a host query, not client state. `terminalSemanticInput.ts`
 * carries a pointer to the *child* when the child asked for it; this carries a
 * pointer to the *host's selection*, which is a different path with a different
 * answer — the host decides which cells a request covers and hands back the
 * text with it.
 *
 * So nothing here holds a selection, extends one, or joins one to a screen. It
 * holds one thing: the cell a drag started on, because a drag is the only
 * gesture whose meaning spans more than one event.
 *
 * Two rules keep this a gesture reader rather than a second selection model:
 *
 * - **What a click *is* comes from the platform.** A double or triple click is
 *   `MouseEvent.detail`, which the platform increments by its own interval and
 *   its own movement tolerance. A timer here would be this module inventing
 *   what the user's system already defines.
 * - **Which cell a pixel is over comes from the plan.** The caller hit-tests
 *   with `hitTestTerminalCell` against what is displayed, projects the answer
 *   into the host's screen space, and passes that. A wide grapheme's two
 *   columns stay one cell here as everywhere else, and a row the reader
 *   scrolled back to is the row the host knows it as.
 */

import type { TerminalModesModel } from "./terminalClientModel.ts";
import type { TerminalProjectedPoint, TerminalSelectionRequest } from "./types.ts";

/** The part of a pointer event a gesture reads. */
export interface TerminalGesturePointerFacts {
  readonly type: string;
  /** W3C `button`: the button whose state changed, and -1 for none. */
  readonly button: number;
  /**
   * The platform's own click count for this press: 1, 2, 3 and upward. It is
   * what makes a double click a double click on the user's system.
   */
  readonly detail: number;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/**
 * Who a pointer belongs to.
 *
 * A child that asked for mouse tracking gets the pointer, because that is what
 * it asked for. Shift takes it back, which is the convention every terminal
 * follows and the only way to select text inside a full-screen program.
 */
export function terminalPointerAudience(
  modes: TerminalModesModel,
  event: { readonly shiftKey: boolean },
): "child" | "selection" {
  return modes.mouseTracking && !event.shiftKey ? "child" : "selection";
}

/** The primary button, as W3C numbers it. */
const PRIMARY_BUTTON = 0;

/**
 * The space every request below names.
 *
 * History and the active area together, oldest row first. It is the only space
 * that can hold a drag which starts behind the screen and ends on it, and it is
 * what the caller projects a displayed cell into.
 */
const SCREEN_SPACE = "screen" as const;

export class TerminalSelectionGesture {
  /** Where the current selection started, or null while none has started. */
  #anchor: TerminalProjectedPoint | null = null;
  /** The cell the last request named, so a drag asks once per cell, not per pixel. */
  #last: TerminalProjectedPoint | null = null;
  #dragging = false;

  /**
   * True while a press is extending a selection by moving.
   *
   * A caller needs this to answer a drag that left the display: extending is
   * meaningful only for the gesture that is already extending, and a word press
   * or a secondary button is not it. Asking here keeps the rule in one place.
   */
  get dragging(): boolean {
    return this.#dragging;
  }

  /**
   * Read one pointer event, and answer with the request it asks for.
   *
   * `cell` is what the pointer is over, or null when it is off the grid. Null
   * answers nothing: a gesture that left the painted area has not asked for a
   * different selection, and guessing which edge it meant would be this module
   * deciding where a selection ends.
   */
  observe(
    event: TerminalGesturePointerFacts,
    cell: TerminalProjectedPoint | null,
  ): TerminalSelectionRequest | null {
    if (event.type === "pointerup" || event.type === "mouseup") {
      this.#dragging = false;
      return null;
    }

    if (event.type === "pointerdown" || event.type === "mousedown") {
      if (event.button !== PRIMARY_BUTTON) return null;
      if (!cell) return null;
      return this.#press(event, cell);
    }

    if (event.type !== "pointermove" && event.type !== "mousemove") return null;
    if (!this.#dragging || !this.#anchor || !cell) return null;
    if (this.#last && this.#last.row === cell.row && this.#last.column === cell.column) {
      return null;
    }
    this.#last = cell;
    return this.#range(this.#anchor, cell, event.altKey);
  }

  /** Forget the gesture. The host's selection, if any, is untouched. */
  reset(): void {
    this.#anchor = null;
    this.#last = null;
    this.#dragging = false;
  }

  #press(
    event: TerminalGesturePointerFacts,
    cell: TerminalProjectedPoint,
  ): TerminalSelectionRequest {
    // A third click and beyond is a line. There is nothing above a line to ask
    // for, so a fourth click means the same thing rather than nothing.
    if (event.detail >= 3) {
      this.#anchor = cell;
      this.#last = cell;
      this.#dragging = false;
      return { kind: "line", space: SCREEN_SPACE, at: cell };
    }
    if (event.detail === 2) {
      this.#anchor = cell;
      this.#last = cell;
      // A drag from a word does not extend by words: the host's range is
      // character-wise, and pretending otherwise would move the edge somewhere
      // the host was never asked to put it.
      this.#dragging = false;
      return { kind: "word", space: SCREEN_SPACE, at: cell };
    }
    // Shift moves the far edge of what is already selected, so the near edge —
    // the anchor — is kept rather than replaced.
    if (event.shiftKey && this.#anchor) {
      this.#last = cell;
      this.#dragging = true;
      return this.#range(this.#anchor, cell, event.altKey);
    }
    this.#anchor = cell;
    this.#last = cell;
    this.#dragging = true;
    // A press starts a new selection, so whatever the host holds is no longer
    // what the user is pointing at. The drag that follows replaces this.
    return { kind: "clear" };
  }

  #range(
    from: TerminalProjectedPoint,
    to: TerminalProjectedPoint,
    rectangle: boolean,
  ): TerminalSelectionRequest {
    return {
      kind: "range",
      space: SCREEN_SPACE,
      from: { column: from.column, row: from.row },
      to: { column: to.column, row: to.row },
      // Held now, not at the press: the host recomputes the whole range for
      // every request, so releasing the key mid-drag reshapes the selection,
      // which is what holding it asked for in the first place.
      rectangle,
    };
  }
}
