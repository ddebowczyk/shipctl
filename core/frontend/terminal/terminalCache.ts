import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { TerminalRendererState } from "./terminalRenderer.ts";
import type { TerminalViewportPin } from "./terminalViewportPin.ts";
import type { TerminalAttachmentId, TerminalId } from "./types.ts";

export interface TerminalCacheEntry extends TerminalRendererState {
  term: Terminal;
  fitAddon: FitAddon;
  attachmentId: TerminalAttachmentId | null;
  /** Where the user is reading. Outlives any one view session. */
  viewportPin: TerminalViewportPin;
  /**
   * The live view session's input sink, or null while none is bound. The
   * terminal's own input handlers are installed once, so they submit through
   * this rather than closing over a session that may already be gone.
   */
  inputSink: ((data: string) => void) | null;
}

// Keep terminal instances alive across tab switches.
//
// This lives apart from TerminalView so that the capability's logic never has to
// import a .tsx file: the node --test lanes run through Node's type stripping,
// which handles .ts but not JSX.
export const terminalCache = new Map<TerminalId, TerminalCacheEntry>();
