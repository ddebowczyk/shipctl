import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { TerminalRendererState } from "./terminalRenderer.ts";
import type { TerminalAttachmentId, TerminalId } from "./types.ts";

export interface TerminalCacheEntry extends TerminalRendererState {
  term: Terminal;
  fitAddon: FitAddon;
  attachmentId: TerminalAttachmentId | null;
}

// Keep terminal instances alive across tab switches.
//
// This lives apart from TerminalView so that the capability's logic never has to
// import a .tsx file: the node --test lanes run through Node's type stripping,
// which handles .ts but not JSX.
export const terminalCache = new Map<TerminalId, TerminalCacheEntry>();
