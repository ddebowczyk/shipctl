/**
 * One presentation of one client model.
 *
 * The model is the terminal's continuity and outlives every surface. This is
 * the thing that turns its changes into frames: it watches the model, decides
 * when to paint and how much, and drives the plan and the draw sequence. It
 * holds no terminal state of its own — nothing here can answer a question about
 * the terminal that the model could not — so a surface that is disposed and
 * built again loses pixels and nothing else.
 *
 * Three rules, and each is why a frame looks the way it does:
 *
 * - **Frames coalesce; damage does not.** Several host frames may arrive
 *   between two paints. Each state carries only its own damage, so painting the
 *   last one's would leave the rows the earlier ones changed stale. The rows
 *   are accumulated across the whole coalesced batch and supplied to the plan.
 * - **A surface that lost its pixels asks for everything.** Revealed, resized,
 *   re-themed, or drawn on a canvas that was just resized: the next frame is
 *   full. {@link TerminalCellPresenter.invalidate} is the one way to say so,
 *   and the target may say so for itself.
 * - **A reader who scrolled back is painted the rows they scrolled to.** What
 *   those are is `terminalViewportComposition.ts`'s answer, built from the
 *   host's own screen and history rows; a view whose rows are not held yet owes
 *   a frame rather than showing the bottom.
 * - **Painting is the only thing suspended when hidden.** A hidden presenter
 *   keeps watching the model and keeps accumulating damage, because the
 *   attachment never left and the state kept changing. What it does not do is
 *   draw into pixels nobody is looking at.
 */

import {
  planTerminalPaint,
  type TerminalCellMetrics,
  type TerminalPaintPlan,
} from "./terminalCellPaint.ts";
import {
  paintTerminalFrame,
  type TerminalPaintTarget,
  type TerminalSurfacePalette,
} from "./terminalCellSurface.ts";
import type {
  TerminalClientModel,
  TerminalCursorModel,
  TerminalDamageModel,
} from "./terminalClientModel.ts";
import { composeDisplayedScreen } from "./terminalViewportComposition.ts";

/**
 * A paint target that can say its pixels are gone.
 *
 * Optional because it is a property of the binding, not of the port: a canvas
 * loses its pixels when it is resized, and a target painting into something
 * that does not have that property simply never says so.
 */
export interface TerminalPresentableTarget extends TerminalPaintTarget {
  requiresFullFrame?(size: { readonly width: number; readonly height: number }): boolean;
}

export interface TerminalCellPresenterPorts {
  readonly model: TerminalClientModel;
  readonly target: TerminalPresentableTarget;
  /**
   * Pixels one cell occupies, from whoever measured the font, or null while the
   * font cannot be measured.
   *
   * Null owes a frame rather than drawing one: a plan needs a cell size, and a
   * cell size that was not measured would be this module inventing how large
   * the terminal is.
   */
  metrics(): TerminalCellMetrics | null;
  /** The colours the chrome supplies for what the child left unsaid. */
  palette(): TerminalSurfacePalette;
  /** Browser cursor-blink preference, when the host supplies one. */
  cursorBlink?(): boolean;
  /**
   * Defer one frame and return its cancel.
   *
   * `requestAnimationFrame` in a browser. Injected so every rule above is
   * provable without waiting on a real frame clock.
   */
  schedule(paint: () => void): () => void;
  /**
   * Run a task after a delay and return its cancel.
   *
   * `setTimeout` in a browser. Separate from {@link schedule} because a blink
   * is a wall-clock interval and a frame is not, and injected for the same
   * reason: so the blink is provable without waiting for one.
   */
  defer(task: () => void, delayMs: number): () => void;
  /** Called after each painted frame, for a caller that tracks what is shown. */
  onFrame?(plan: TerminalPaintPlan): void;
  /** Record planning and drawing for one complete frame. */
  observePaint?(milliseconds: number): void;
  /** Recover a paint-target failure without treating it as terminal state. */
  onFailure?(error: unknown): void;
}

/**
 * Half a blink, in milliseconds.
 *
 * The rate the product blinks at today is 600 ms. Product parity is the
 * authority — nothing here chose a rate, and the host says only whether a
 * cursor blinks, never when.
 */
const CURSOR_BLINK_MS = 600;

export class TerminalCellPresenter {
  readonly #ports: TerminalCellPresenterPorts;

  #unsubscribe: (() => void) | null = null;
  #cancelFrame: (() => void) | null = null;
  /** Rows changed since the last painted frame. */
  #rows = new Set<number>();
  /** Nothing has been painted yet, so the first frame is everything. */
  #full = true;
  #pending = false;
  #visible = true;
  #disposed = false;
  /** Whether a blinking cursor is drawn in the next frame. */
  #cursorLit = true;
  /** Cancels the wait for the next blink, while one is running. */
  #stopBlink: (() => void) | null = null;
  /** Where the cursor was in the last painted frame, to see it move. */
  #cursorAt: string | null = null;
  /** The visible host cursor observed in the last committed model state. */
  #observedCursor: { readonly signature: string; readonly row: number | null } | null = null;

  constructor(ports: TerminalCellPresenterPorts) {
    this.#ports = ports;
  }

  /**
   * Watch the model.
   *
   * The model hands a new listener its current state and tells it to repaint
   * all of it, so a presenter that starts against a live terminal shows what is
   * on screen without asking for anything.
   */
  start(): void {
    if (this.#disposed || this.#unsubscribe) return;
    this.#unsubscribe = this.#ports.model.subscribe((state, damage) => {
      this.#accumulateCursor(state.screen.cursor);
      this.#accumulate(damage);
      this.#request();
    });
  }

  /** The next frame paints everything: these pixels are not the last frame's. */
  invalidate(): void {
    if (this.#disposed) return;
    this.#full = true;
    this.#request();
  }

  /**
   * Show or hide the presentation.
   *
   * Becoming visible invalidates, because the pixels behind a hidden surface
   * are the ones it had when it was hidden and the model has moved on.
   */
  setVisible(visible: boolean): void {
    if (this.#disposed || visible === this.#visible) return;
    this.#visible = visible;
    if (!visible) {
      this.#cancelFrame?.();
      this.#cancelFrame = null;
      this.#pending = false;
      // Nothing is looking at the cursor either.
      this.#stopBlink?.();
      this.#stopBlink = null;
      return;
    }
    this.invalidate();
  }

  /** Paint now, if anything is owed. For a caller that drives its own clock. */
  paintNow(): void {
    if (this.#disposed) return;
    this.#cancelFrame?.();
    this.#cancelFrame = null;
    this.#pending = false;
    this.#attemptPaint();
  }

  /** Stop presenting. The model, and the terminal, are untouched. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelFrame?.();
    this.#cancelFrame = null;
    this.#pending = false;
    this.#stopBlink?.();
    this.#stopBlink = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /**
   * A cursor that moved is a person typing: it is lit, and its wait starts over.
   *
   * Asked before the frame is planned, not after it is drawn. The character
   * somebody just typed must never appear under a dark cursor, and the frame
   * that carries it is this one.
   */
  #relight(at: string | null): void {
    if (at === this.#cursorAt) return;
    this.#cursorAt = at;
    this.#stopBlink?.();
    this.#stopBlink = null;
    this.#cursorLit = true;
  }

  /**
   * Keep the blink running, or stop it.
   *
   * Asked after each frame, because the wait is for the frame after this one.
   */
  #blink(blinking: boolean): void {
    if (!blinking) {
      this.#stopBlink?.();
      this.#stopBlink = null;
      this.#cursorLit = true;
      return;
    }
    if (this.#stopBlink) return;
    this.#stopBlink = this.#ports.defer(() => {
      this.#stopBlink = null;
      this.#cursorLit = !this.#cursorLit;
      // The cursor's own row is the only thing that changed, and it is the one
      // row the host did not report: this is the client's clock, not the
      // terminal's state.
      this.#rows.add(this.#ports.model.state?.screen.cursor.row ?? 0);
      this.#request();
    }, CURSOR_BLINK_MS);
  }

  #accumulate(damage: TerminalDamageModel): void {
    if (damage.scope === "full") {
      this.#full = true;
      return;
    }
    for (const row of damage.rows) this.#rows.add(row);
  }

  /**
   * A cursor change is presentation damage even when no cell changed.
   *
   * A written space and a Backspace can move the cursor over cells whose
   * visible contents stay blank. The host correctly reports clean cell damage
   * for those updates. Repaint the old and new cursor rows so the old cursor is
   * erased and the new cursor is drawn without waiting for a glyph change.
   */
  #accumulateCursor(cursor: TerminalCursorModel): void {
    const signature = [
      cursor.row,
      cursor.column,
      cursor.visible,
      cursor.shape,
      cursor.blinking,
    ].join(":");
    if (signature === this.#observedCursor?.signature) return;
    if (this.#observedCursor?.row !== null && this.#observedCursor?.row !== undefined) {
      this.#rows.add(this.#observedCursor.row);
    }
    const row = cursor.visible ? cursor.row : null;
    if (row !== null) this.#rows.add(row);
    this.#observedCursor = { signature, row };
  }

  #request(): void {
    if (this.#disposed || !this.#visible || this.#pending) return;
    this.#pending = true;
    this.#cancelFrame = this.#ports.schedule(() => {
      this.#cancelFrame = null;
      this.#pending = false;
      this.#attemptPaint();
    });
  }

  #attemptPaint(): void {
    try {
      this.#paint();
    } catch (error: unknown) {
      if (!this.#ports.onFailure) throw error;
      this.#ports.onFailure(error);
    }
  }

  #paint(): void {
    const startedAt = performance.now();
    const model = this.#ports.model;
    const state = model.state;
    // Nothing to show yet, or nothing owed. Either way, no frame: an empty
    // repaint would still clear rows a caller can see.
    if (!state || (!this.#full && this.#rows.size === 0)) return;

    const metrics = this.#ports.metrics();
    // The damage is left owed, so the frame is drawn as soon as the font can be
    // measured — a webfont that has not loaded is a wait, not a lost frame.
    if (!metrics) return;

    const displayed = composeDisplayedScreen(state.screen, model.history, model.viewportIntent);
    // A reader scrolled back to rows the client does not hold yet. The damage
    // stays owed and the frame is drawn when the window arrives; painting the
    // bottom instead would move the reader's eye for them.
    if (!displayed) return;

    const size = {
      width: displayed.columns * metrics.cellWidth,
      height: displayed.rows * metrics.cellHeight,
    };
    this.#relight(
      displayed.cursor.visible
        ? `${displayed.cursor.row}:${displayed.cursor.column}`
        : null,
    );
    const full =
      this.#full
      // Composed rows are not the rows the host's damage describes.
      || displayed !== state.screen
      || this.#ports.target.requiresFullFrame?.(size) === true;
    const cursorBlink = this.#ports.cursorBlink?.() ?? displayed.cursor.blinking;
    const plan = planTerminalPaint(displayed, {
      metrics,
      repaint: full ? "full" : "damage",
      rows: full ? undefined : [...this.#rows],
      cursorLit: this.#cursorLit,
      cursorBlink,
    });

    paintTerminalFrame(this.#ports.target, plan, this.#ports.palette());
    this.#ports.observePaint?.(performance.now() - startedAt);

    // Cleared only once the frame is drawn: a target that throws leaves the
    // damage owed rather than silently dropping it.
    this.#full = false;
    this.#rows.clear();
    this.#blink(displayed.cursor.visible && cursorBlink);
    this.#ports.onFrame?.(plan);
  }
}
