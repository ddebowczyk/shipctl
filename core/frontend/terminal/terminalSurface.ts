/**
 * The presentation surface one terminal is displayed on.
 *
 * Everything a view session needs from the terminal engine, and nothing else:
 * no addon, no DOM node, no store. The browser implementation lives in
 * "./terminalXtermSurface.ts", which value-imports xterm; this module holds
 * only the shape, so the capability's logic entry point — and the node --test
 * lanes — can name it.
 */

import type { TerminalGeometry } from "./terminalFitPlan.ts";
import type { TerminalInput } from "./terminalSemanticInput.ts";
import type { TerminalViewportPin } from "./terminalViewportPin.ts";
import type { TerminalAttachmentId } from "./types.ts";

export interface TerminalSurface {
  /** Where the user is reading. Outlives any one view session. */
  readonly pin: TerminalViewportPin;

  /** Mount into the view's container. Idempotent across sessions. */
  open(): void;

  /** Install the sink for locally produced input, or null to close it. */
  setInputSink(sink: ((data: string) => void) | null): void;

  /**
   * Install the sink for input that names what a person did, or null to close
   * it.
   *
   * Optional because the xterm surface has none: it holds the child's modes and
   * therefore produces bytes. A surface that has this one produces no bytes at
   * all, and area 05 leaves only this.
   */
  setSemanticInputSink?(sink: ((input: TerminalInput) => void) | null): void;

  /** Install the current theme and reconcile the renderer against it. */
  applyCurrentTheme(): void;

  /** Install the current font and cursor settings. */
  applyCurrentSettings(): void;

  /** Repaint the viewport. */
  refresh(): void;

  focus(): void;

  /** Discard the buffer ahead of a replay baseline. */
  reset(): void;

  /** Resize a buffer whose contents are about to be replaced. */
  resize(size: TerminalGeometry): void;

  /** Resize, keeping the user's reading position. */
  resizePreservingViewport(size: TerminalGeometry): void;

  geometry(): TerminalGeometry;

  /** The geometry the container can hold, or null while it cannot be measured. */
  proposeGeometry(): TerminalGeometry | null;

  /** Lines held in the active buffer, including scrollback. */
  bufferRows(): number;

  /** Re-assert the reading position after the container was hidden. */
  resyncViewport(): void;

  /** Record the live attachment id for the terminal's other readers. */
  publishAttachmentId(attachmentId: TerminalAttachmentId | null): void;

  /** Dev-only diagnostics naming the font actually in use. */
  logActiveFont(): void;
}
