/**
 * The reading position, held as a line instead of as a row number.
 *
 * A reader who scrolls back is looking at history rows, and a history row
 * number is a position: row 0 is the oldest row the terminal still keeps, so
 * eviction renumbers everything behind the row it drops. A client that keeps
 * the number drifts by the lines evicted between reads — silently, because
 * nothing in a screen frame says that eviction happened.
 *
 * The host already tracks lines for itself. This holds one of those anchors for
 * the reader's top row and corrects the reading position from it, so the row
 * number the rest of the client works in is a live projection of one line
 * rather than a remembered coordinate.
 *
 * It owns no state the client model owns: the reading position stays in the
 * model, and this only moves it when the host says the line moved.
 */

import {
  decodeAnchor,
  decodeResolvedAnchor,
  type TerminalAnchorModel,
  type TerminalViewportIntent,
} from "./terminalClientModel.ts";
import type {
  TerminalAnchorId,
  TerminalProjectedPoint,
  TerminalProjectedSpace,
} from "./types.ts";

/** The host operations a reading anchor performs, and where it reports to. */
export interface TerminalReadingAnchorPorts {
  /** Pin a cell. Answered unchecked; this module decodes it. */
  anchor(space: TerminalProjectedSpace, at: TerminalProjectedPoint): Promise<unknown>;
  /** Where an anchored line is now, or null for a handle the host dropped. */
  resolveAnchor(anchor: TerminalAnchorId): Promise<unknown>;
  /** Drop an anchor. The host holds one only while a client asks it to. */
  releaseAnchor(anchor: TerminalAnchorId): Promise<unknown>;
  /** Where the reader is now. */
  intent(): TerminalViewportIntent;
  /** Move the reader, because the host says their line moved. */
  setIntent(intent: TerminalViewportIntent): void;
  /** Report a failure the user has to know about. */
  notifyError(title: string, error: unknown): void;
}

/** The reader's top row is a history row, so that is the space it is pinned in. */
const READING_SPACE: TerminalProjectedSpace = "history";

const FOLLOW_BOTTOM: TerminalViewportIntent = { followBottom: true, historyAnchor: null };

export class TerminalReadingAnchor {
  readonly #ports: TerminalReadingAnchorPorts;
  /** The anchor the host is holding for this reader, once one is minted. */
  #held: TerminalAnchorModel | null = null;
  /**
   * The row the held anchor stands for.
   *
   * It is how a reader who scrolled is told apart from a line that moved: an
   * intent at another row is the reader's own move, and the anchor is re-minted
   * there rather than pulling them back.
   */
  #pinnedRow: number | null = null;
  /** One host call at a time, so a frame cannot queue a second round trip. */
  #busy = false;
  /**
   * The host refused to hold an anchor. Reported once, and the reader is left
   * on plain row numbers until they return to the bottom — which is exactly
   * where they were before anchors, drift included.
   */
  #broken = false;
  #disposed = false;

  constructor(ports: TerminalReadingAnchorPorts) {
    this.#ports = ports;
  }

  /** The anchor the host holds for this reader, for the suite to read. */
  get held(): TerminalAnchorModel | null {
    return this.#held;
  }

  /**
   * The reading position may have moved, or the screen under it may have.
   *
   * Called on every announced change, because eviction is not announced: the
   * only way to learn that a line moved is to ask where it is now.
   */
  observe(): void {
    if (this.#disposed || this.#busy) return;
    const intent = this.#ports.intent();
    if (intent.followBottom || intent.historyAnchor === null) {
      // A reader at the bottom is following the newest output, and the newest
      // output is what a screen frame already carries.
      this.#broken = false;
      this.#drop();
      return;
    }
    if (this.#broken) return;
    if (this.#held && this.#pinnedRow === intent.historyAnchor) {
      void this.#follow(this.#held.id);
      return;
    }
    void this.#pin(intent.historyAnchor);
  }

  /** No later answer moves the reader, and the host stops holding the line. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#drop();
  }

  async #pin(row: number): Promise<void> {
    this.#busy = true;
    const previous = this.#held;
    this.#held = null;
    this.#pinnedRow = null;
    try {
      if (previous) await this.#ports.releaseAnchor(previous.id);
      const anchor = decodeAnchor(await this.#ports.anchor(READING_SPACE, { column: 0, row }));
      if (this.#disposed) {
        void this.#ports.releaseAnchor(anchor.id).catch(() => undefined);
        return;
      }
      this.#held = anchor;
      this.#pinnedRow = row;
    } catch (error) {
      this.#fail(error);
    } finally {
      this.#busy = false;
    }
  }

  async #follow(id: TerminalAnchorId): Promise<void> {
    this.#busy = true;
    try {
      const anchor = decodeResolvedAnchor(await this.#ports.resolveAnchor(id));
      if (this.#disposed) return;
      if (!anchor) {
        // The host is not holding this handle. Nothing is wrong with the
        // reader's position; the next observation pins it again.
        this.#held = null;
        this.#pinnedRow = null;
        return;
      }
      this.#held = anchor;
      if (!anchor.retained) {
        // The line left the terminal. The nearest position that still exists is
        // the oldest row history kept, so the reader lands there rather than on
        // whatever number their old row now names.
        this.#drop();
        this.#ports.setIntent({ followBottom: false, historyAnchor: 0 });
        return;
      }
      if (!anchor.history) {
        // The line is in the active area again, which a screen frame carries.
        this.#drop();
        this.#ports.setIntent(FOLLOW_BOTTOM);
        return;
      }
      if (anchor.history.row === this.#pinnedRow) return;
      this.#pinnedRow = anchor.history.row;
      this.#ports.setIntent({ followBottom: false, historyAnchor: anchor.history.row });
    } catch (error) {
      this.#fail(error);
    } finally {
      this.#busy = false;
    }
  }

  /** Stop holding a line, without waiting to hear that the host let go. */
  #drop(): void {
    const held = this.#held;
    this.#held = null;
    this.#pinnedRow = null;
    if (!held) return;
    void Promise.resolve(this.#ports.releaseAnchor(held.id)).catch(() => undefined);
  }

  #fail(error: unknown): void {
    this.#held = null;
    this.#pinnedRow = null;
    if (this.#disposed || this.#broken) return;
    this.#broken = true;
    this.#ports.notifyError("Couldn’t hold the terminal reading position", error);
  }
}
