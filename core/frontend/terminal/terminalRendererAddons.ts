import { WebglAddon } from "@xterm/addon-webgl";
import type { TerminalRendererFactories } from "./terminalRenderer.ts";

// The browser-only half of the renderer seam. Everything here value-imports an
// xterm addon bundle, so this module must stay out of "./index.ts" — and thus
// out of the node --test lanes that import the capability's logic.
export const browserTerminalRendererFactories: TerminalRendererFactories = {
  webgl: () => new WebglAddon(),
};
