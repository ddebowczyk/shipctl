import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { CanvasAddon } from "@xterm/addon-canvas";

// Keep terminal instances alive across tab switches.
//
// This lives apart from TerminalView so that the capability's logic never has to
// import a .tsx file: the node --test lanes run through Node's type stripping,
// which handles .ts but not JSX.
export const terminalCache = new Map<
  number,
  { term: Terminal; fitAddon: FitAddon; rendererAddon: WebglAddon | CanvasAddon | null }
>();
