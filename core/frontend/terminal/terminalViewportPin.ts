/**
 * Where the user is reading in one terminal.
 *
 * Following output is a user intent, not a buffer fact: the output queue writes
 * in chunks across frames, so by the time a chunk lands the buffer has already
 * moved and the buffer can no longer say whether the user asked to be there.
 * This holds that intent, plus the reading position a pending replay has to
 * restore, and is the only writer of both.
 *
 * `terminalScrollPin.ts` classifies the gesture and `terminalViewport.ts`
 * decides what a completed drain owes the viewport; this applies those
 * decisions to a surface. It touches no DOM, so the whole gesture-to-viewport
 * trace is provable without one.
 *
 * The pin outlives a view session — hiding a tab must not scroll the user back
 * to the end — and is disposed with the terminal it describes.
 */

import {
  keyScrollPinIntent,
  wheelScrollPinIntent,
  type ScrollPinIntent,
} from "./terminalScrollPin.ts";
import { resolveViewportDrainAction } from "./terminalViewport.ts";

/** The slice of a terminal surface the pin drives. */
export interface ViewportPinSurface {
  /** Lines between the viewport and the end of the buffer; 0 means following. */
  bottomOffset(): number;
  /** The buffer's last line. */
  baseY(): number;
  scrollToBottom(): void;
  scrollToLine(line: number): void;
}

export class TerminalViewportPin {
  readonly #surface: ViewportPinSurface;
  readonly #schedule: (task: () => void) => void;

  #pinnedToBottom = true;
  #pendingBottomOffset: number | null = null;
  #disposed = false;

  /**
   * @param schedule Defers the read-back of an ambiguous gesture. Defaults to
   * `queueMicrotask`; tests inject a scheduler they drain explicitly so no
   * trace depends on timing.
   */
  constructor(
    surface: ViewportPinSurface,
    schedule: (task: () => void) => void = queueMicrotask,
  ) {
    this.#surface = surface;
    this.#schedule = schedule;
  }

  /** Whether the viewport is following output. */
  get pinnedToBottom(): boolean {
    return this.#pinnedToBottom;
  }

  /** Lines from the end a pending replay must restore, or null when none is. */
  get pendingBottomOffset(): number | null {
    return this.#pendingBottomOffset;
  }

  applyIntent(intent: ScrollPinIntent): void {
    // A gesture during a replay supersedes the position that replay was going
    // to restore: the user has since said where they want to be.
    this.#pendingBottomOffset = null;

    if (intent === "unpin") {
      this.#pinnedToBottom = false;
      return;
    }
    if (intent === "follow") {
      // Resumed before xterm emits onData for this key.
      this.#pinnedToBottom = true;
      this.#surface.scrollToBottom();
      return;
    }
    // "resync": the gesture has not been applied to the buffer yet, so read the
    // resulting position back rather than guess it.
    this.#schedule(() => {
      if (this.#disposed) return;
      this.#pinnedToBottom = this.#surface.bottomOffset() === 0;
    });
  }

  noteWheel(deltaY: number): void {
    this.applyIntent(wheelScrollPinIntent(deltaY));
  }

  noteKey(event: Pick<KeyboardEvent, "shiftKey" | "key">): void {
    const intent = keyScrollPinIntent(event);
    this.applyIntent(intent);
    // A backward viewport key with no scrollback to move into leaves the
    // viewport at the bottom, so read the result back instead of assuming the
    // key moved it. The wheel needs no equivalent: a wheel-up gesture that
    // cannot move produces no further events to correct.
    if (intent === "unpin") this.applyIntent("resync");
  }

  /** The host took input: the response is what the user is waiting to see. */
  noteInputAccepted(): void {
    this.#pinnedToBottom = true;
    this.#surface.scrollToBottom();
  }

  /**
   * A replay is about to reset the buffer.
   *
   * The reset zeroes the scroll position, so the distance the user was reading
   * at is captured here and re-applied once the replayed bytes have drained. A
   * user already at the end is handled by the pin and needs nothing remembered.
   */
  noteReplayReset(): void {
    const bottomOffset = this.#surface.bottomOffset();
    this.#pendingBottomOffset = bottomOffset > 0 ? bottomOffset : null;
  }

  /** Everything queued for the current baseline has been written. */
  noteOutputDrained(): void {
    const action = resolveViewportDrainAction({
      pinnedToBottom: this.#pinnedToBottom,
      pendingBottomOffset: this.#pendingBottomOffset,
      baseY: this.#surface.baseY(),
    });
    this.#pendingBottomOffset = null;
    if (action.kind === "bottom") this.#surface.scrollToBottom();
    else if (action.kind === "line") this.#surface.scrollToLine(action.line);
  }

  /** Terminal: no deferred read-back may touch the surface afterwards. */
  dispose(): void {
    this.#disposed = true;
  }
}
